use serde::Deserialize;
use serde::de;
use serde::Deserializer;
use serde_json::json;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::thread;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;
use crate::{CodexUsage, DEVELOPMENT, OpencodeGoUsage, OpencodeGoUsageWindow};

pub(super) fn default_pi_path() -> String { "pi".into() }
pub(super) fn default_context_window_cap() -> u64 { 300_000 }
pub(super) fn default_context_window_cap_enabled() -> bool { true }
pub(super) fn default_true() -> bool { true }
pub(super) fn deserialize_context_window_cap<'de, D>(deserializer: D) -> Result<u64, D::Error> where D: Deserializer<'de> {
    let value = Value::deserialize(deserializer)?;
    value.as_u64().ok_or_else(|| de::Error::custom("Context window cap must be a whole number"))
}
pub(super) const DEFAULT_MODEL: &str = if DEVELOPMENT { "openai-codex/gpt-6-luna" } else { "openai-codex/gpt-5.6-sol" };

pub(super) fn default_keybindings() -> HashMap<String, String> {
    [
        ("newConversation", "Ctrl+N"),
        ("toggleConversations", "Ctrl+B"),
        ("toggleTerminal", "Ctrl+J"),
        ("toggleDebugMode", "Ctrl+D"),
        ("focusComposer", "Ctrl+E"),
        ("openSettings", "Ctrl+,"),
    ].into_iter().map(|(action, shortcut)| (action.into(), shortcut.into())).collect()
}

pub(super) fn home_dir() -> Result<PathBuf, String> {
    #[cfg(feature = "test-home")]
    if let Some(path) = std::env::var_os("PIOP_TEST_HOME") { return Ok(PathBuf::from(path)); }
    std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| "HOME is not set".into())
}

pub(super) fn pi_executable() -> PathBuf { pi_executable_in(home_dir().ok()) }

pub(super) fn pi_executable_in(home: Option<PathBuf>) -> PathBuf {
    if let Some(home) = home {
        for candidate in [home.join(".local/bin/pi"), home.join(".npm-global/bin/pi"), home.join(".bun/bin/pi")] { if candidate.is_file() { return candidate; } }
    }
    pi_on_path().unwrap_or_else(|| PathBuf::from("pi"))
}

fn pi_on_path() -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths).map(|directory| directory.join("pi")).find(|candidate| candidate.is_file())
}

fn codex_executable() -> PathBuf {
    if let Ok(home) = home_dir() {
        for candidate in [home.join(".local/bin/codex"), home.join(".npm-global/bin/codex"), home.join(".bun/bin/codex")] { if candidate.is_file() { return candidate; } }
    }
    PathBuf::from("codex")
}

pub(super) fn codex_response(receiver: &mpsc::Receiver<String>, id: u64, deadline: Instant) -> Result<Value, String> {
    loop {
        let timeout = deadline.checked_duration_since(Instant::now()).ok_or("Codex usage request timed out")?;
        let line = receiver.recv_timeout(timeout).map_err(|_| "Codex usage request timed out".to_string())?;
        let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
        if value.get("id").and_then(Value::as_u64) != Some(id) { continue; }
        if let Some(error) = value.get("error") { return Err(error.to_string()); }
        return value.get("result").cloned().ok_or_else(|| "Codex returned no usage data".into());
    }
}
pub(super) fn codex_usage_values(response: &Value) -> Option<CodexUsage> {
    let limits = response.pointer("/rateLimitsByLimitId/codex").or_else(|| response.get("rateLimits"))?;
    let (used, reset_at) = ["primary", "secondary"].iter().filter_map(|window| {
        let value = limits.get(window)?;
        Some((value.get("usedPercent")?.as_f64()?, value.get("resetsAt").and_then(Value::as_u64)))
    }).max_by(|left, right| left.0.total_cmp(&right.0))?;
    Some(CodexUsage { remaining_percent: (100.0 - used.clamp(0.0, 100.0)).round() as u8, reset_at })
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
pub(super) fn codex_usage() -> Result<CodexUsage, String> {
    query_codex_usage(Command::new(codex_executable()).current_dir(home_dir()?))
}

pub(super) fn query_codex_usage(command: &mut Command) -> Result<CodexUsage, String> {
    let mut child = command.arg("app-server").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|error| format!("Could not start Codex: {error}"))?;
    let result = (|| {
        let mut stdin = child.stdin.take().ok_or("Codex stdin was unavailable")?;
        let stdout = child.stdout.take().ok_or("Codex stdout was unavailable")?;
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || for line in BufReader::new(stdout).lines().map_while(Result::ok) { if sender.send(line).is_err() { break; } });
        let deadline = Instant::now() + Duration::from_secs(8);
        writeln!(stdin, "{}", json!({"method":"initialize","id":1,"params":{"clientInfo":{"name":"piop","title":"piop","version":env!("CARGO_PKG_VERSION")},"capabilities":null}})).map_err(|error| error.to_string())?;
        codex_response(&receiver, 1, deadline)?;
        writeln!(stdin, "{}", json!({"method":"initialized"})).map_err(|error| error.to_string())?;
        writeln!(stdin, "{}", json!({"method":"account/rateLimits/read","id":2})).map_err(|error| error.to_string())?;
        let response = codex_response(&receiver, 2, deadline)?;
        codex_usage_values(&response).ok_or_else(|| "Codex usage is unavailable".into())
    })();
    let _ = child.kill(); let _ = child.wait(); result
}

fn opencode_go_api_key() -> Option<String> {
    if let Ok(home) = home_dir() {
        let credentials = fs::read_to_string(home.join(".pi/agent/auth.json")).ok().and_then(|body| serde_json::from_str::<Value>(&body).ok());
        if let Some(key) = credentials.as_ref().and_then(|credentials| credentials.pointer("/opencode-go/key")).and_then(Value::as_str) { return Some(key.to_string()); }
    }
    std::env::var("OPENCODE_API_KEY").ok().filter(|key| !key.trim().is_empty())
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

#[cfg_attr(feature = "desktop", tauri::command(async))]
pub(super) async fn opencode_go_usage() -> Result<OpencodeGoUsage, String> {
    let api_key = opencode_go_api_key().ok_or("OpenCode Go API key is not configured")?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(8)).build().map_err(|error| format!("Could not create HTTP client: {error}"))?;
    let response = client.get("https://opencode.ai/zen/go/v1/usage").bearer_auth(api_key).send().await.map_err(|error| format!("OpenCode Go usage request failed: {error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let message = response.json::<Value>().await.ok().and_then(|body| body.pointer("/error/message").and_then(Value::as_str).map(String::from)).unwrap_or_else(|| status.to_string());
        return Err(format!("OpenCode Go usage is unavailable: {message}"));
    }
    let body = response.json::<Value>().await.map_err(|error| format!("OpenCode Go usage could not be read: {error}"))?;
    opencode_go_usage_values(&body).ok_or_else(|| "OpenCode Go usage is unavailable".into())
}

#[cfg(test)]
mod opencode_go_tests {
    use super::*;

    #[test]
    fn parses_usage_windows_from_the_opencode_go_gateway() {
        let response = json!({"usage":{"rolling":{"status":"ok","percent":26.7,"resetsAt":"2026-09-17T16:00:00.000Z"},"weekly":{"status":"ok","percent":55.4,"resetsAt":"2026-09-21T00:00:00Z"},"monthly":{"status":"rate-limited","percent":101,"resetsAt":"2026-09-30T00:00:00.000Z"}}});
        let usage = opencode_go_usage_values(&response).expect("usage parses");
        assert_eq!(usage.rolling.status, "ok");
        assert_eq!(usage.rolling.remaining_percent, 73);
        assert_eq!(usage.rolling.reset_at, Some(1789660800));
        assert_eq!(usage.weekly.remaining_percent, 45);
        assert_eq!(usage.weekly.reset_at, Some(1789948800));
        assert_eq!(usage.monthly.status, "rate-limited");
        assert_eq!(usage.monthly.remaining_percent, 0);
    }

    #[test]
    fn rejects_responses_without_usage_windows() {
        assert!(opencode_go_usage_values(&json!({"type":"error","error":{"type":"AuthError","message":"Unauthorized"}})).is_none());
        assert!(opencode_go_usage_values(&json!({"usage":{"rolling":{"status":"ok","percent":50}}})).is_none());
        assert!(opencode_go_usage_values(&json!({})).is_none());
    }

    #[test]
    fn converts_iso8601_reset_timestamps_to_epoch_seconds() {
        assert_eq!(opencode_go_epoch_seconds("2026-09-17T00:00:00.000Z"), Some(1789603200));
        assert_eq!(opencode_go_epoch_seconds("2026-09-17T11:39:50Z"), Some(1789645190));
        assert_eq!(opencode_go_epoch_seconds("2000-02-29T23:59:59Z"), Some(951868799));
        assert_eq!(opencode_go_epoch_seconds("2026-09-17T11:39:50+02:00"), None);
        assert_eq!(opencode_go_epoch_seconds("2026-09-17 11:39:50Z"), None);
        assert_eq!(opencode_go_epoch_seconds("yesterday"), None);
    }

    #[test]
    fn settings_saved_before_new_toggles_still_load() {
        let stored = json!({"defaultModel":"openai-codex/gpt-5.6-sol","defaultThinking":"medium","contextWindowCap":200000,"contextWindowCapEnabled":true,"autoRetry":true,"tools":[],"skills":[],"mcpServers":[]});
        let settings: AppSettings = serde_json::from_value(stored).expect("older settings load");
        assert!(settings.auto_retry);
    }
}
