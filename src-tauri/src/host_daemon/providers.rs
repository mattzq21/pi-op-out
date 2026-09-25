use super::{
    catalogs::{self, auth_text, auth_url},
    controller::Host,
    protocol::{array, flag, text, Result},
    provider_sdk::{Events, Sdk},
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, MutexGuard, OnceLock, Weak,
    },
    time::{Duration, Instant},
};
use tokio::sync::{watch, Mutex as AsyncMutex};
use uuid::Uuid;

struct Flow {
    id: String,
    owner: String,
    provider_id: String,
    name: String,
    status: String,
    notices: Vec<Value>,
    prompt: Option<Value>,
    error: Option<String>,
    created: Instant,
}

impl Flow {
    fn snapshot(&self) -> Value {
        let mut snapshot =
            json!({"flowId":self.id,"providerId":self.provider_id,"name":self.name,"status":self.status,"notices":self.notices});
        if let Some(prompt) = &self.prompt {
            snapshot["prompt"] = prompt.clone();
        }
        if let Some(error) = &self.error {
            snapshot["error"] = json!(error);
        }
        snapshot
    }
}

#[derive(Default)]
struct AuthState {
    flows: HashMap<String, Flow>,
    busy: HashSet<String>,
    credential_revision: Option<String>,
    catalog_warning: Option<String>,
    next_catalog: Option<Instant>,
}

#[derive(Clone)]
struct RuntimeInfo {
    auth_path: PathBuf,
    builtin_ids: HashSet<String>,
}

pub(super) struct ProviderService {
    sdk: Sdk,
    host: OnceLock<Weak<Host>>,
    weak: Weak<Self>,
    state: Mutex<AuthState>,
    runtime: AsyncMutex<Option<RuntimeInfo>>,
    checking: AsyncMutex<()>,
    catalogs: AsyncMutex<()>,
    revision: AtomicU64,
    shutdown: watch::Sender<bool>,
}

struct SdkEvents(Weak<ProviderService>);
impl Events for SdkEvents {
    fn event(&self, packet: Value) {
        if let Some(service) = self.0.upgrade() {
            service.receive(packet);
        }
    }
}

impl ProviderService {
    pub fn new(executable: String) -> Arc<Self> {
        let (shutdown, _) = watch::channel(false);
        Arc::new_cyclic(|weak| Self {
            sdk: Sdk::new(executable, Arc::new(SdkEvents(weak.clone()))),
            host: OnceLock::new(),
            weak: weak.clone(),
            state: Mutex::new(AuthState::default()),
            runtime: AsyncMutex::new(None),
            checking: AsyncMutex::new(()),
            catalogs: AsyncMutex::new(()),
            revision: AtomicU64::new(0),
            shutdown,
        })
    }

    pub fn bind(self: &Arc<Self>, host: Weak<Host>) {
        let _ = self.host.set(host);
        let service = self.clone();
        let mut stopped = self.shutdown.subscribe();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = async { let _ = stopped.wait_for(|stop| *stop).await; } => break,
                    _ = tokio::time::sleep(Duration::from_secs(2)) => { let _ = service.check().await; }
                }
            }
        });
    }

    fn state(&self) -> MutexGuard<'_, AuthState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn changed(&self) {
        self.revision.fetch_add(1, Ordering::SeqCst);
        if let Some(host) = self.host.get().and_then(Weak::upgrade) {
            let sessions: Vec<_> = host.registry().sessions.values().cloned().collect();
            for session in sessions {
                session.publish(json!({"type":"session_info_changed"}), None);
            }
            host.output(json!({"type":"provider_auth_changed"}));
        }
    }

    async fn runtime(&self) -> Result<RuntimeInfo> {
        let mut runtime = self.runtime.lock().await;
        if let Some(info) = &*runtime {
            return Ok(info.clone());
        }
        let info = self.sdk.request(json!({"method":"initialize"})).await?;
        let auth_path = info["authPath"]
            .as_str()
            .filter(|path| !path.is_empty())
            .ok_or("Pi provider SDK returned no authentication path")?;
        let info = RuntimeInfo {
            auth_path: PathBuf::from(auth_path),
            builtin_ids: array(&info, "builtinIds")
                .iter()
                .filter_map(|id| id.as_str().map(str::to_owned))
                .collect(),
        };
        *runtime = Some(info.clone());
        Ok(info)
    }

    pub async fn check(&self) -> Result<u64> {
        let _checking = self.checking.lock().await;
        let info = self.runtime().await?;
        self.refresh_catalogs(false).await?;
        let parent = info.auth_path.parent().ok_or("Invalid Pi authentication path")?;
        let paths = [
            info.auth_path.clone(),
            catalogs::accounts_path(&info.auth_path),
            parent.join("models.json"),
        ];
        let revision = paths.iter().map(|path| file_revision(path)).collect::<Result<Vec<_>>>()?.join("|");
        let changed = {
            let mut state = self.state();
            let changed = state.credential_revision.as_ref() != Some(&revision);
            state.credential_revision = Some(revision);
            changed
        };
        if changed {
            self.changed();
        }
        Ok(self.revision.load(Ordering::SeqCst))
    }

    pub async fn handle(self: &Arc<Self>, owner: &str, request: Value) -> Result<Value> {
        if owner.is_empty() {
            return Err("Login owner is missing".into());
        }
        match request["action"].as_str() {
            Some("list") => return self.listing(flag(&request, "refreshModels")).await,
            Some("begin") => return self.begin(owner, request).await,
            Some("logout") => return self.logout(&text(&request, "providerId")).await,
            Some("create") => return self.create_provider(request).await,
            _ => {}
        }
        let id = text(&request, "flowId");
        let snapshot = {
            let state = self.state();
            state
                .flows
                .get(&id)
                .filter(|flow| flow.owner == owner)
                .ok_or("This login attempt is unavailable. Start again.")?
                .snapshot()
        };
        match request["action"].as_str() {
            Some("poll") => Ok(snapshot),
            Some("reply") => self.reply(&id, &request).await,
            Some("cancel") => {
                self.cancel(&id).await;
                self.snapshot(&id)
            }
            _ => Err("Unknown provider authentication operation".into()),
        }
    }

    fn snapshot(&self, id: &str) -> Result<Value> {
        self.state()
            .flows
            .get(id)
            .map(Flow::snapshot)
            .ok_or_else(|| "This login attempt is unavailable. Start again.".into())
    }

    async fn listing(&self, refresh: bool) -> Result<Value> {
        let info = self.runtime().await?;
        self.refresh_catalogs(refresh).await?;
        let records = catalogs::read_accounts(&info.auth_path)?;
        let snapshot = self.sdk.request(json!({"method":"inspect"})).await?;
        let credentials = array(&snapshot, "credentials");
        let mut providers = Vec::new();
        for mut provider in array(&snapshot, "providers") {
            let account = records.iter().find(|record| record["id"] == provider["id"]);
            provider["providerId"] = account.map(|record| record["providerId"].clone()).unwrap_or(provider["id"].clone());
            provider["number"] = account.map(|record| record["number"].clone()).unwrap_or(json!(1));
            if account.is_none() {
                provider["name"] = json!(format!("{} #1", text(&provider, "name")));
            }
            if let Some(credential) = credentials.iter().find(|credential| credential["providerId"] == provider["id"]) {
                provider["storedType"] = credential["type"].clone();
            }
            if let Some(methods) = provider["methods"].as_array_mut() {
                for method in methods {
                    if let Some(method) = method.as_object_mut() {
                        method.remove("login");
                    }
                }
            }
            if !array(&provider, "methods").is_empty() {
                providers.push(provider);
            }
        }
        providers.sort_by(|a, b| {
            text(a, "providerId")
                .cmp(&text(b, "providerId"))
                .then(a["number"].as_u64().cmp(&b["number"].as_u64()))
        });
        let mut result = json!({"providers":providers});
        if let Some(warning) = self.state().catalog_warning.clone() {
            result["warning"] = json!(warning);
        }
        Ok(result)
    }

    async fn begin(self: &Arc<Self>, owner: &str, request: Value) -> Result<Value> {
        let info = self.runtime().await?;
        let snapshot = self.sdk.request(json!({"method":"inspect"})).await?;
        let mut provider = array(&snapshot, "providers")
            .into_iter()
            .find(|provider| provider["id"] == request["providerId"])
            .ok_or("Provider is unavailable on this host")?;
        if !matches!(request["authType"].as_str(), Some("oauth" | "api_key"))
            || !array(&provider, "methods")
                .iter()
                .any(|method| method["type"] == request["authType"] && flag(method, "login"))
        {
            return Err("This provider uses credentials configured on the host".into());
        }
        {
            let mut state = self.state();
            state
                .flows
                .retain(|_, flow| flow.status == "pending" || flow.created.elapsed() <= Duration::from_secs(600));
            if state.flows.len() >= 32 {
                return Err("Too many login attempts. Try again later.".into());
            }
            if state.busy.contains(&text(&provider, "id")) {
                return Err("A credential operation is already running for this provider".into());
            }
        }
        let records = catalogs::read_accounts(&info.auth_path)?;
        if flag(&request, "addAccount") {
            let id = text(&provider, "id");
            let base = records
                .iter()
                .find(|record| record["id"] == id)
                .map(|record| text(record, "providerId"))
                .unwrap_or(id);
            let occupied = array(&snapshot, "providers")
                .iter()
                .map(|provider| text(provider, "id"))
                .chain(
                    array(&snapshot, "credentials")
                        .iter()
                        .map(|credential| text(credential, "providerId")),
                )
                .collect();
            let record = catalogs::allocate_account(&info.auth_path, &base, occupied).await?;
            let refreshed = self.sdk.request(json!({"method":"inspect"})).await?;
            provider = array(&refreshed, "providers")
                .into_iter()
                .find(|provider| provider["id"] == record["id"])
                .ok_or("Could not initialize the new provider account")?;
            self.changed();
        }
        let provider_id = text(&provider, "id");
        let extra = catalogs::read_accounts(&info.auth_path)?
            .iter()
            .any(|record| record["id"] == provider_id);
        let flow = Flow {
            id: Uuid::new_v4().to_string(),
            owner: owner.into(),
            provider_id: provider_id.clone(),
            name: if extra {
                text(&provider, "name")
            } else {
                format!("{} #1", text(&provider, "name"))
            },
            status: "pending".into(),
            notices: Vec::new(),
            prompt: None,
            error: None,
            created: Instant::now(),
        };
        let id = flow.id.clone();
        let snapshot = flow.snapshot();
        {
            let mut state = self.state();
            if !state.busy.insert(provider_id.clone()) {
                return Err("A credential operation is already running for this provider".into());
            }
            state.flows.insert(id.clone(), flow);
        }
        let service = self.clone();
        let auth_type = request["authType"].clone();
        tokio::spawn(async move {
            let login = service
                .sdk
                .request(json!({"method":"login","flowId":id,"providerId":provider_id,"authType":auth_type}));
            let result = tokio::time::timeout(Duration::from_secs(600), login).await;
            let result = match result {
                Ok(result) => result,
                Err(_) => {
                    service.cancel(&id).await;
                    Ok(json!({"status":"cancelled"}))
                }
            };
            {
                let mut state = service.state();
                state.busy.remove(&provider_id);
                if let Some(flow) = state.flows.get_mut(&id) {
                    if flow.status == "pending" {
                        match result {
                            Ok(result) => {
                                flow.status = result["status"].as_str().unwrap_or("failed").into();
                                flow.error = result["error"].as_str().map(|error| error.chars().take(400).collect());
                            }
                            Err(error) => {
                                flow.status = "failed".into();
                                flow.error = Some(error.chars().take(400).collect());
                            }
                        }
                    }
                    flow.prompt = None;
                    flow.notices.clear();
                }
            }
            service.changed();
        });
        Ok(snapshot)
    }

    async fn reply(&self, id: &str, request: &Value) -> Result<Value> {
        {
            let state = self.state();
            let flow = state.flows.get(id).ok_or("This login attempt is unavailable. Start again.")?;
            let prompt = flow
                .prompt
                .as_ref()
                .filter(|prompt| flow.status == "pending" && prompt["id"] == request["promptId"])
                .ok_or("This login prompt has expired")?;
            let answer = request["answer"]
                .as_str()
                .filter(|answer| answer.encode_utf16().count() <= 128 * 1024)
                .ok_or("Invalid login answer")?;
            if prompt["type"] == "select" && !array(prompt, "options").iter().any(|option| option["id"] == answer) {
                return Err("Choose one of the available options".into());
            }
        }
        self.sdk
            .request(json!({"method":"answer","flowId":id,"promptId":request["promptId"],"answer":request["answer"]}))
            .await?;
        self.snapshot(id)
    }

    pub async fn cancel_owner(&self, owner: &str) {
        let ids: Vec<_> = self
            .state()
            .flows
            .values()
            .filter(|flow| flow.owner == owner)
            .map(|flow| flow.id.clone())
            .collect();
        for id in ids {
            self.cancel(&id).await;
        }
    }

    async fn cancel(&self, id: &str) {
        let cancelled = {
            let mut state = self.state();
            if let Some(flow) = state.flows.get_mut(id).filter(|flow| flow.status == "pending") {
                flow.status = "cancelled".into();
                flow.prompt = None;
                flow.notices.clear();
                true
            } else {
                false
            }
        };
        if cancelled {
            let _ = self.sdk.request(json!({"method":"cancel","flowId":id})).await;
        }
    }

    async fn logout(&self, id: &str) -> Result<Value> {
        self.runtime().await?;
        let snapshot = self.sdk.request(json!({"method":"inspect"})).await?;
        if !array(&snapshot, "providers").iter().any(|provider| provider["id"] == id) {
            return Err("Provider is unavailable on this host".into());
        }
        if !self.state().busy.insert(id.into()) {
            return Err("Finish or cancel the current login first".into());
        }
        let result = self.sdk.request(json!({"method":"logout","providerId":id})).await;
        self.state().busy.remove(id);
        self.changed();
        result.map_err(|_| "Could not remove the saved provider login. Refresh and try again.")?;
        self.listing(false).await
    }

    async fn create_provider(&self, request: Value) -> Result<Value> {
        let mut config = catalogs::custom_config(&request)?;
        let key = request["apiKey"].as_str().map(str::trim);
        if !flag(&request, "noKey")
            && (key.is_none_or(str::is_empty) || request["apiKey"].as_str().is_some_and(|key| key.encode_utf16().count() > 32768))
        {
            return Err("Enter the API key, or select No API key required".into());
        }
        let info = self.runtime().await?;
        let snapshot = self.sdk.request(json!({"method":"inspect"})).await?;
        let id = text(&request, "providerId");
        if array(&snapshot, "providers").iter().any(|provider| provider["id"] == id) {
            return Err("That provider ID already exists. Choose another ID.".into());
        }
        config["models"] = json!(
            catalogs::discover(
                &config,
                if flag(&request, "noKey") { None } else { key },
                &array(&snapshot, "models"),
                &Value::Null
            )
            .await?
        );
        let path = info.auth_path.parent().ok_or("Invalid Pi authentication path")?.join("models.json");
        catalogs::save_provider(&path, &id, &config, None).await?;
        let result = async {
            self.sdk.request(json!({"method":"inspect"})).await?;
            if !flag(&request, "noKey") {
                let login = self
                    .sdk
                    .request(json!({"method":"login","flowId":Uuid::new_v4().to_string(),"providerId":id,"authType":"api_key","key":key}))
                    .await?;
                if login["status"] != "complete" {
                    return Err("Provider login could not be confirmed".to_owned());
                }
            }
            Ok(())
        }
        .await;
        self.changed();
        let mut result_value = json!({"created":true});
        if result.is_err() {
            result_value["warning"] =
                json!("Provider created, but its login could not be confirmed. Refresh and use Add account to save the key.");
        }
        Ok(result_value)
    }

    async fn refresh_catalogs(&self, force: bool) -> Result<()> {
        let _catalogs = self.catalogs.lock().await;
        {
            let mut state = self.state();
            if !force && state.next_catalog.is_some_and(|next| Instant::now() < next) {
                return Ok(());
            }
            state.next_catalog = Some(Instant::now() + Duration::from_secs(300));
        }
        let info = self.runtime().await?;
        let snapshot = self.sdk.request(json!({"method":"inspect"})).await?;
        let path = info.auth_path.parent().ok_or("Invalid Pi authentication path")?.join("models.json");
        let data: Value = match std::fs::read(&path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()) {
            Some(data) => data,
            None => return Ok(()),
        };
        let models = array(&snapshot, "models");
        let catalogs = data["providers"].as_object().into_iter().flatten().filter(|(id, config)| {
            !info.builtin_ids.contains(*id) && auth_url(&config["baseUrl"]).is_some() && catalogs::supported_api(config)
        });
        let failures: Vec<_> = futures_util::future::join_all(
            catalogs.map(|(id, config)| async { self.refresh_catalog(&path, id, config, &models).await.err().map(|_| id.clone()) }),
        )
        .await
        .into_iter()
        .flatten()
        .collect();
        self.state().catalog_warning = (!failures.is_empty()).then(|| {
            format!(
                "Could not refresh models for {}. Keeping the last successful catalog.",
                failures.join(", ")
            )
        });
        Ok(())
    }

    async fn refresh_catalog(&self, path: &Path, id: &str, config: &Value, models: &[Value]) -> Result<()> {
        let auth = self.sdk.request(json!({"method":"auth","providerId":id})).await?;
        if auth.is_null() {
            return Err("Provider login is missing".into());
        }
        let discovered = catalogs::discover(config, auth["apiKey"].as_str(), models, &auth["headers"]).await?;
        let mut next = config.clone();
        next["models"] = json!(catalogs::merge_models(config, discovered));
        catalogs::save_provider(path, id, &next, Some(config)).await
    }

    fn receive(&self, packet: Value) {
        let id = text(&packet, "flowId");
        let mut cancel = false;
        {
            let mut state = self.state();
            let Some(flow) = state.flows.get_mut(&id).filter(|flow| flow.status == "pending") else {
                return;
            };
            match packet["event"].as_str() {
                Some("prompt") => match prompt(&packet) {
                    Ok(prompt) => flow.prompt = Some(prompt),
                    Err(error) => {
                        flow.status = "failed".into();
                        flow.error = Some(error);
                        flow.prompt = None;
                        flow.notices.clear();
                        cancel = true;
                    }
                },
                Some("prompt_resolved") => {
                    if flow.prompt.as_ref().is_some_and(|prompt| prompt["id"] == packet["promptId"]) {
                        flow.prompt = None;
                    }
                }
                Some("notice") => {
                    if let Some(notice) = notice(&packet["notice"]) {
                        if flow.notices.len() >= 16 {
                            flow.notices.remove(0);
                        }
                        flow.notices.push(notice);
                    }
                }
                _ => {}
            }
        }
        if cancel {
            if let Some(service) = self.weak.upgrade() {
                tokio::spawn(async move {
                    let _ = service.sdk.request(json!({"method":"cancel","flowId":id})).await;
                });
            }
        }
    }

    pub async fn shutdown(&self) {
        self.shutdown.send_replace(true);
        {
            let mut state = self.state();
            for flow in state.flows.values_mut() {
                if flow.status == "pending" {
                    flow.status = "cancelled".into();
                    flow.prompt = None;
                    flow.notices.clear();
                }
            }
        }
        self.sdk.shutdown().await;
    }
}

fn notice(event: &Value) -> Option<Value> {
    match event["type"].as_str() {
        Some("auth_url") => Some(json!({"type":"auth_url","url":auth_url(&event["url"]),"message":auth_text(&event["instructions"])})),
        Some("device_code") => {
            Some(json!({"type":"device_code","url":auth_url(&event["verificationUri"]),"userCode":auth_text(&event["userCode"])}))
        }
        Some("info" | "progress") => Some(
            json!({"type":event["type"],"message":auth_text(&event["message"]),"links":array(event,"links").iter().take(8).map(|link|json!({"url":auth_url(&link["url"]),"label":auth_text(&link["label"])})).collect::<Vec<_>>()}),
        ),
        _ => None,
    }
}

fn prompt(packet: &Value) -> Result<Value> {
    let request = &packet["request"];
    if !matches!(request["type"].as_str(), Some("text" | "secret" | "select" | "manual_code")) {
        return Err("Unsupported provider login prompt".into());
    }
    let mut prompt = json!({"id":packet["promptId"],"type":request["type"],"message":auth_text(&request["message"]),"placeholder":auth_text(&request["placeholder"])});
    if request["type"] == "select" {
        prompt["options"]=json!(array(request,"options").iter().map(|option|json!({"id":auth_text(&option["id"]),"label":auth_text(&option["label"]),"description":auth_text(&option["description"])})).collect::<Vec<_>>());
    }
    Ok(prompt)
}

fn file_revision(path: &Path) -> Result<String> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok("missing".into()),
        Err(_) => return Err("Could not check provider credentials on this host".into()),
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(format!(
            "{}:{}:{}:{}:{}",
            metadata.dev(),
            metadata.ino(),
            metadata.len(),
            metadata.mtime() as i128 * 1_000_000_000 + metadata.mtime_nsec() as i128,
            metadata.ctime() as i128 * 1_000_000_000 + metadata.ctime_nsec() as i128
        ))
    }
    #[cfg(not(unix))]
    {
        Ok(format!("{}:{:?}:{:?}", metadata.len(), metadata.modified(), metadata.created()))
    }
}
