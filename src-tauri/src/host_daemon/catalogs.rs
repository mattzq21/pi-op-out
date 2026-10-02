use super::protocol::{array, flag, text, Result};
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue},
    Url,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

pub(super) fn auth_url(value: &Value) -> Option<String> {
    Url::parse(value.as_str()?)
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https"))
        .map(|url| url.to_string())
}

pub(super) fn auth_text(value: &Value) -> String {
    value.as_str().unwrap_or_default().chars().take(8192).collect()
}

pub(super) fn custom_config(request: &Value) -> Result<Value> {
    let id = text(request, "providerId");
    if !valid_provider_id(&id) {
        return Err("Use a unique provider ID containing lowercase letters, numbers, hyphens or underscores".into());
    }
    if !supported_api(request) {
        return Err("Choose a supported API format".into());
    }
    let url = auth_url(&request["baseUrl"])
        .and_then(|url| Url::parse(&url).ok())
        .filter(|url| url.username().is_empty() && url.password().is_none())
        .ok_or("Enter an HTTP or HTTPS API URL without embedded credentials")?;
    let name = auth_text(&request["name"]);
    let mut config = json!({"name":if name.trim().is_empty() { &id } else { name.trim() },"baseUrl":url.as_str().trim_end_matches('/'),"api":request["api"]});
    if flag(request, "noKey") {
        config["apiKey"] = json!("not-required");
        config["authHeader"] = json!(false);
    }
    if flag(request, "sessionAffinity") {
        config["compat"] = json!({"sessionAffinityFormat":"openai","sendSessionAffinityHeaders":true});
    }
    Ok(config)
}

pub(super) fn supported_api(config: &Value) -> bool {
    matches!(
        config["api"].as_str(),
        Some("openai-completions" | "openai-responses" | "anthropic-messages")
    )
}

fn valid_provider_id(id: &str) -> bool {
    let alphanumeric = |ch: u8| ch.is_ascii_lowercase() || ch.is_ascii_digit();
    !id.is_empty()
        && id.len() <= 80
        && alphanumeric(id.as_bytes()[0])
        && id.bytes().all(|ch| alphanumeric(ch) || matches!(ch, b'_' | b'-'))
        && !id.contains("--piop-account-")
}

pub(super) async fn discover(config: &Value, key: Option<&str>, known: &[Value], extra_headers: &Value) -> Result<Vec<Value>> {
    let mut url = Url::parse(&text(config, "baseUrl")).map_err(|_| "Enter an HTTP or HTTPS API URL without embedded credentials")?;
    url.set_path(&format!("{}/models", url.path().trim_end_matches('/')));
    let headers = discovery_headers(config, key, extra_headers)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(15), async {
        let mut models = BTreeMap::new();
        for _ in 0..50 {
            let body = catalog_page(&client, &url, &headers).await?;
            merge_catalog_page(&mut models, &body, known)?;
            if !flag(&body, "has_more") {
                return finish_catalog(models);
            }
            advance_catalog(&mut url, &body)?;
        }
        Err("Model catalog exceeds the pagination limit".into())
    })
    .await
    .map_err(|_| "Could not discover models. Check the API URL and connectivity from the selected host.".to_owned())?
}

fn finish_catalog(models: BTreeMap<String, Value>) -> Result<Vec<Value>> {
    if models.is_empty() {
        return Err("The provider returned no models".into());
    }
    Ok(models.into_values().collect())
}

fn discovery_headers(config: &Value, key: Option<&str>, extra_headers: &Value) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    add_extra_headers(&mut headers, extra_headers)?;
    insert_header(&mut headers, "accept", "application/json")?;
    if let Some(key) = key.filter(|key| !key.is_empty()) {
        insert_header(&mut headers, "authorization", &format!("Bearer {key}"))?;
    }
    if config["api"] == "anthropic-messages" {
        insert_header(&mut headers, "anthropic-version", "2023-06-01")?;
        if let Some(key) = key.filter(|key| !key.is_empty()) {
            insert_header(&mut headers, "x-api-key", key)?;
        }
    }
    Ok(headers)
}

fn add_extra_headers(headers: &mut HeaderMap, extra_headers: &Value) -> Result<()> {
    if let Some(extra) = extra_headers.as_object() {
        for (name, value) in extra {
            if let Some(value) = value.as_str() {
                insert_header(headers, name, value)?;
            }
        }
    }
    Ok(())
}

fn merge_catalog_page(models: &mut BTreeMap<String, Value>, body: &Value, known: &[Value]) -> Result<()> {
    let entries = body
        .as_array()
        .or_else(|| body["data"].as_array())
        .ok_or("Expected a models endpoint returning a data array")?;
    for entry in entries {
        let model = discovered_model(entry, known)?;
        models.insert(text(&model, "id"), model);
    }
    Ok(())
}

async fn catalog_page(client: &reqwest::Client, url: &Url, headers: &HeaderMap) -> Result<Value> {
    let mut response = client
        .get(url.clone())
        .headers(headers.clone())
        .send()
        .await
        .map_err(|_| "Could not discover models. Check the API URL and connectivity from the selected host.")?;
    if !response.status().is_success() {
        return Err(format!(
            "Model discovery returned HTTP {}. Check the API URL and key.",
            response.status().as_u16()
        ));
    }
    let mut content = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not discover models. Check the API URL and connectivity from the selected host.")?
    {
        if content.len() + chunk.len() > 10 * 1024 * 1024 {
            return Err("Model catalog is too large".into());
        }
        content.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&content).map_err(|_| "Models endpoint did not return valid JSON".into())
}

fn advance_catalog(url: &mut Url, body: &Value) -> Result<()> {
    let after = body["last_id"].as_str().ok_or("Invalid model catalog pagination")?;
    if url.query_pairs().any(|(key, value)| key == "after_id" && value == after) {
        return Err("Invalid model catalog pagination".into());
    }
    let mut query: Vec<_> = url
        .query_pairs()
        .filter(|(key, _)| key != "after_id")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    query.push(("after_id".into(), after.into()));
    url.query_pairs_mut().clear().extend_pairs(query);
    Ok(())
}

fn insert_header(headers: &mut HeaderMap, name: &str, value: &str) -> Result<()> {
    headers.insert(
        HeaderName::from_bytes(name.as_bytes()).map_err(|_| "Invalid provider authentication header")?,
        HeaderValue::from_str(value).map_err(|_| "Invalid provider authentication header")?,
    );
    Ok(())
}

fn discovered_model(entry: &Value, known: &[Value]) -> Result<Value> {
    let id = entry["id"]
        .as_str()
        .filter(|id| !id.trim().is_empty())
        .ok_or("The models endpoint returned an invalid model ID")?;
    let name = auth_text(
        entry
            .get("name")
            .filter(|name| name.as_str().is_some_and(|name| !name.is_empty()))
            .unwrap_or(&entry["display_name"]),
    );
    let mut model = json!({"id":id,"name":if name.is_empty() { id } else { &name }});
    if let Some(baseline) = known.iter().find(|model| model["id"] == id) {
        for field in ["reasoning", "input", "contextWindow", "maxTokens"] {
            if let Some(value) = baseline.get(field) {
                model[field] = value.clone();
            }
        }
    }
    if entry["reasoning"].is_boolean() {
        model["reasoning"] = entry["reasoning"].clone();
    }
    if entry["input"]
        .as_array()
        .is_some_and(|items| items.iter().all(|item| matches!(item.as_str(), Some("text" | "image"))))
    {
        model["input"] = entry["input"].clone();
    }
    for (field, aliases) in [
        ("contextWindow", ["contextWindow", "context_length", "context_window"]),
        ("maxTokens", ["maxTokens", "max_output_tokens", "max_tokens"]),
    ] {
        if let Some(value) = aliases
            .iter()
            .filter_map(|alias| entry.get(*alias))
            .find(|value| !value.is_null())
            .and_then(Value::as_u64)
            .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991)
        {
            model[field] = json!(value);
        }
    }
    Ok(model)
}

pub(super) async fn file_lock(path: &Path) -> Result<File> {
    if let Some(parent) = path.parent() {
        crate::ensure_private_dir(parent)?;
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path).map_err(|error| error.to_string())?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(std::fs::TryLockError::WouldBlock) if tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(20)).await
            }
            Err(_) => return Err("Could not lock provider configuration on this host".into()),
        }
    }
}

pub(super) fn write_atomic(path: &Path, data: &Value) -> Result<()> {
    let temporary = PathBuf::from(format!("{}.{}", path.to_string_lossy(), Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temporary).map_err(|error| error.to_string())?;
        writeln!(file, "{}", serde_json::to_string_pretty(data).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
        std::fs::rename(&temporary, path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

pub(super) async fn save_provider(path: &Path, id: &str, config: &Value, previous: Option<&Value>) -> Result<()> {
    let _lock = file_lock(&PathBuf::from(format!("{}.lock", path.to_string_lossy()))).await?;
    let mut data = read_provider_file(path)?;
    let providers = data["providers"]
        .as_object_mut()
        .ok_or("Could not save the provider. Check models.json and host file permissions.")?;
    if let Some(previous) = previous {
        if providers.get(id) != Some(previous) {
            return Err("Could not save the provider. Check models.json and host file permissions.".into());
        }
        if previous == config {
            return Ok(());
        }
    } else if providers.contains_key(id) {
        return Err("That provider ID already exists. Choose another ID.".into());
    }
    providers.insert(id.into(), config.clone());
    write_atomic(path, &data)
}

fn read_provider_file(path: &Path) -> Result<Value> {
    match std::fs::read(path) {
        Ok(data) => {
            serde_json::from_slice(&data).map_err(|_| "Could not save the provider. Check models.json and host file permissions.".into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({"providers":{}})),
        Err(_) => Err("Could not save the provider. Check models.json and host file permissions.".into()),
    }
}

pub(super) fn accounts_path(auth: &Path) -> PathBuf {
    PathBuf::from(format!("{}.piop-accounts.json", auth.to_string_lossy()))
}

pub(super) fn read_accounts(auth: &Path) -> Result<Vec<Value>> {
    let records: Value = match std::fs::read(accounts_path(auth)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "Invalid provider account registry")?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let records = records.as_array().ok_or("Invalid provider account registry")?;
    if records.iter().any(|record| {
        let number = record["number"].as_u64();
        !record["providerId"].is_string()
            || number.is_none_or(|number| !(2..=9_007_199_254_740_991).contains(&number))
            || record["id"] != format!("{}--piop-account-{}", text(record, "providerId"), number.unwrap_or(0))
    }) {
        return Err("Invalid provider account registry".into());
    }
    Ok(records.clone())
}

pub(super) async fn allocate_account(auth: &Path, id: &str, occupied: HashSet<String>) -> Result<Value> {
    let path = accounts_path(auth);
    let _lock = file_lock(&PathBuf::from(format!("{}.lock", path.to_string_lossy()))).await?;
    let mut records = read_accounts(auth)?;
    let mut number = records
        .iter()
        .filter(|record| record["providerId"] == id)
        .filter_map(|record| record["number"].as_u64())
        .max()
        .unwrap_or(1)
        + 1;
    while occupied.contains(&format!("{id}--piop-account-{number}")) {
        number += 1;
    }
    let record = json!({"providerId":id,"number":number,"id":format!("{id}--piop-account-{number}")});
    records.push(record.clone());
    write_atomic(&path, &json!(records))?;
    Ok(record)
}

pub(super) fn merge_models(config: &Value, discovered: Vec<Value>) -> Vec<Value> {
    let saved = array(config, "models");
    let discovered_ids: HashSet<_> = discovered.iter().map(|model| text(model, "id")).collect();
    let mut models: Vec<_> = discovered
        .into_iter()
        .map(|mut model| {
            if let Some(original) = saved.iter().find(|original| original["id"] == model["id"]) {
                if let (Some(model), Some(original)) = (model.as_object_mut(), original.as_object()) {
                    model.extend(original.clone());
                }
            }
            model
        })
        .collect();
    models.extend(saved.into_iter().filter(|model| !discovered_ids.contains(&text(model, "id"))));
    models
}
