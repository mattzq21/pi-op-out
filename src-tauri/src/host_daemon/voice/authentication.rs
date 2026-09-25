use super::*;

pub(super) async fn authenticate(home: &Path, refresh: bool) -> Result<VoiceAuth> {
    tokio::time::timeout(Duration::from_secs(25), async {
        let executable = [".local/bin/codex", ".npm-global/bin/codex", ".bun/bin/codex"]
            .iter()
            .map(|path| home.join(path))
            .find(|path| path.exists())
            .unwrap_or_else(|| PathBuf::from("codex"));
        let mut child = Command::new(executable)
            .arg("app-server")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| LOGIN_ERROR)?;
        let stdin = child.stdin.take().ok_or(LOGIN_ERROR)?;
        let stdout = child.stdout.take().ok_or(LOGIN_ERROR)?;
        read_auth(stdin, stdout, refresh).await
    })
    .await
    .map_err(|_| LOGIN_ERROR.to_owned())?
    .map_err(str::to_owned)
}

async fn read_auth(
    mut stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
    refresh: bool,
) -> std::result::Result<VoiceAuth, &'static str> {
    let mut lines = BufReader::new(stdout).lines();
    stdin
        .write_all(
            format!(
                "{}\n",
                json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"piop","version":"0.1.0"}}})
            )
            .as_bytes(),
        )
        .await
        .map_err(|_| LOGIN_ERROR)?;
    while let Some(line) = lines.next_line().await.map_err(|_| LOGIN_ERROR)? {
        let response: Value = serde_json::from_str(&line).map_err(|_| LOGIN_ERROR)?;
        if response.get("error").is_some_and(|error| !error.is_null()) {
            return Err(LOGIN_ERROR);
        }
        if response["id"] == 1 {
            let packets = format!(
                "{}\n{}\n",
                json!({"method":"initialized"}),
                json!({"id":2,"method":"getAuthStatus","params":{"includeToken":true,"refreshToken":refresh}})
            );
            stdin.write_all(packets.as_bytes()).await.map_err(|_| LOGIN_ERROR)?;
        }
        if response["id"] != 2 {
            continue;
        }
        return decode_response(&response);
    }
    Err(LOGIN_ERROR)
}

fn decode_response(response: &Value) -> std::result::Result<VoiceAuth, &'static str> {
    let result = &response["result"];
    if !matches!(result["authMethod"].as_str(), Some("chatgpt" | "chatgptAuthTokens")) {
        return Err(LOGIN_ERROR);
    }
    let token = result["authToken"].as_str().ok_or(LOGIN_ERROR)?;
    let claims = token.split('.').nth(1).ok_or(LOGIN_ERROR)?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(claims.trim_end_matches('='))
        .map_err(|_| LOGIN_ERROR)?;
    let claims: Value = serde_json::from_slice(&decoded).map_err(|_| LOGIN_ERROR)?;
    let account = claims["https://api.openai.com/auth"]["chatgpt_account_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or(LOGIN_ERROR)?;
    Ok(VoiceAuth {
        token: token.into(),
        account: account.into(),
    })
}
