use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use super::environment::pi_executable;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OpencodeGoUsageWindow {
    pub(super) status: String,
    pub(super) remaining_percent: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reset_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OpencodeGoUsage {
    pub(super) rolling: OpencodeGoUsageWindow,
    pub(super) weekly: OpencodeGoUsageWindow,
    pub(super) monthly: OpencodeGoUsageWindow,
}

fn opencode_go_digits(characters: &mut std::str::Chars<'_>, length: usize) -> Option<i64> {
    let mut number = 0;
    for _ in 0..length { number = number * 10 + characters.next()?.to_digit(10)? as i64; }
    Some(number)
}

fn opencode_go_expect_separator(characters: &mut std::str::Chars<'_>, separator: char) -> Option<()> {
    (characters.next()? == separator).then_some(())
}

fn opencode_go_skip_fraction(characters: &mut std::str::Chars<'_>) {
    if characters.clone().next() != Some('.') { return; }
    characters.next();
    while characters.clone().next().is_some_and(|character| character.is_ascii_digit()) { characters.next(); }
}

fn opencode_go_days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let civil = if month <= 2 { year - 1 } else { year };
    let era = civil.div_euclid(400);
    let year_of_era = civil - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2).div_euclid(5) + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era.div_euclid(4) - year_of_era.div_euclid(100) + day_of_year;
    era * 146097 + day_of_era - 719468
}

fn opencode_go_date(characters: &mut std::str::Chars<'_>) -> Option<i64> {
    let year = opencode_go_digits(characters, 4)?;
    opencode_go_expect_separator(characters, '-')?;
    let month = opencode_go_digits(characters, 2)?;
    opencode_go_expect_separator(characters, '-')?;
    let day = opencode_go_digits(characters, 2)?;
    Some(opencode_go_days_from_civil(year, month, day))
}

fn opencode_go_epoch_seconds(value: &str) -> Option<u64> {
    let mut characters = value.chars();
    let days = opencode_go_date(&mut characters)?;
    opencode_go_expect_separator(&mut characters, 'T')?;
    let hour = opencode_go_digits(&mut characters, 2)?;
    opencode_go_expect_separator(&mut characters, ':')?;
    let minute = opencode_go_digits(&mut characters, 2)?;
    opencode_go_expect_separator(&mut characters, ':')?;
    let second = opencode_go_digits(&mut characters, 2)?;
    opencode_go_skip_fraction(&mut characters);
    if !matches!(characters.next()?, 'Z' | 'z') { return None; }
    let seconds = days * 86400 + hour * 3600 + minute * 60 + second;
    u64::try_from(seconds).ok()
}

fn opencode_go_usage_window(window: &Value) -> Option<OpencodeGoUsageWindow> {
    let percent = window.get("percent")?.as_f64()?;
    let reset_at = window.get("resetsAt").and_then(Value::as_str).and_then(opencode_go_epoch_seconds);
    Some(OpencodeGoUsageWindow {
        status: window.get("status").and_then(Value::as_str).unwrap_or("ok").to_string(),
        remaining_percent: (100.0 - percent.clamp(0.0, 100.0)).round() as u8,
        reset_at,
    })
}

fn opencode_go_usage_values(response: &Value) -> Option<OpencodeGoUsage> {
    let usage = response.get("usage")?;
    Some(OpencodeGoUsage {
        rolling: opencode_go_usage_window(usage.get("rolling")?)?,
        weekly: opencode_go_usage_window(usage.get("weekly")?)?,
        monthly: opencode_go_usage_window(usage.get("monthly")?)?,
    })
}
pub(super) async fn opencode_go_usage() -> Result<OpencodeGoUsage, String> {
    let auth = crate::host_supervisor::resolve_provider_auth(pi_executable().to_string_lossy().into_owned(), "opencode-go").await?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(8)).build().map_err(|error| format!("Could not create HTTP client: {error}"))?;
    let response = opencode_go_request(&client, &auth)?.send().await.map_err(|error| format!("OpenCode Go usage request failed: {error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let message = response.json::<Value>().await.ok().and_then(|body| body.pointer("/error/message").and_then(Value::as_str).map(String::from)).unwrap_or_else(|| status.to_string());
        return Err(format!("OpenCode Go usage is unavailable: {message}"));
    }
    let body = response.json::<Value>().await.map_err(|error| format!("OpenCode Go usage could not be read: {error}"))?;
    opencode_go_usage_values(&body).ok_or_else(|| "OpenCode Go usage is unavailable".into())
}

fn opencode_go_request(client: &reqwest::Client, auth: &Value) -> Result<reqwest::RequestBuilder, String> {
    let api_key = auth["apiKey"].as_str().filter(|key| !key.trim().is_empty()).ok_or("OpenCode Go API key is not configured")?;
    let mut request = client.get("https://opencode.ai/zen/go/v1/usage").bearer_auth(api_key);
    for (name, value) in auth["headers"].as_object().into_iter().flatten() {
        request = request.header(name, value.as_str().ok_or("Invalid OpenCode Go authentication header")?);
    }
    Ok(request)
}
