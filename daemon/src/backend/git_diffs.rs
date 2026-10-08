use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use crate::platform::AppHandle;
use crate::{GitDiffSnapshot, GitDiffSnapshots, MAX_GIT_PATCH_BYTES, RemoteHost, STORAGE_DIRECTORY, conversation_ownership};
use crate::archives::{local_desktop_session_file_at};
use crate::worktree_setup::{GitSnapshotToken, ensure_desktop_sessions_dir, run_limited, shell_quote};
use crate::pi_launch::{remote_login_command, saved_remote_host, ssh};
use crate::environment::home_dir;
use crate::snapshot_capture::{local_git_diff, local_git_diff_between, local_git_tree, parse_local_snapshot};

#[path = "git_diff_store.rs"]
mod store;
#[path = "git_diff_pending.rs"]
mod pending;

pub(crate) use pending::capture as persist_capture_diff;
pub(crate) use pending::capture_ephemeral as persist_ephemeral_capture_diff;

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GitDiffPart {
    pub(crate) message_id: String,
    pub(crate) transfer_id: String,
    pub(crate) index: u32,
    pub(crate) content: String,
    #[serde(rename = "final")]
    pub(crate) final_part: bool,
    pub(crate) digest: String,
}

pub(crate) fn append_git_diff_part(app: AppHandle, session_path: String, part: GitDiffPart, host_id: Option<String>, client_id: String) -> Result<serde_json::Value, String> {
    let mutation = conversation_ownership::MutationGuard::acquire(&app, host_id.as_deref().unwrap_or("local"), &session_path, &client_id, false, "save_diffs")?;
    let host = saved_remote_host(app, host_id)?;
    let result = storage_request(&session_path, &serde_json::json!({"action":"part","part":part}), host.as_ref())?;
    mutation.finish()?;
    Ok(result)
}

pub(super) fn valid_remote_snapshot(snapshot: &GitSnapshotToken) -> bool {
    let path = Path::new(&snapshot.root);
    path.is_absolute()
        && path.components().all(|component| matches!(component, std::path::Component::RootDir | std::path::Component::Normal(_)))
        && path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("pi-desktop-diff-"))
        && snapshot.tree.len() >= 40 && snapshot.tree.len() <= 64 && snapshot.tree.chars().all(|character| character.is_ascii_hexdigit())
}

fn remote_git_tree(host: &RemoteHost, cwd: &str) -> Result<Option<String>, String> {
    let script = format!("cd {} && PIOP_STORAGE_DIRECTORY={STORAGE_DIRECTORY} node -e {}", shell_quote(cwd), shell_quote(include_str!("../../resources/capture-git-tree.cjs")));
    let mut command = ssh(host); command.arg(remote_login_command(&script));
    query_remote_git_tree(&mut command, &host.name)
}

pub(super) fn query_remote_git_tree(command: &mut Command, host_name: &str) -> Result<Option<String>, String> {
    let output = run_limited(command, 64 * 1024, &format!("Could not capture Git snapshot on {host_name}"))?;
    if let Some(3 | 4 | 6) = output.status.code() { return Ok(None) }
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let snapshot: GitSnapshotToken = serde_json::from_slice(&output.stdout).map_err(|error| format!("Remote Git snapshot was invalid: {error}"))?;
    if !valid_remote_snapshot(&snapshot) || !Path::new(&snapshot.repository_root).is_absolute() { return Err("Remote Git snapshot was invalid".into()); }
    serde_json::to_string(&snapshot).map(Some).map_err(|error| error.to_string())
}
pub(super) fn capture_git_tree(app: AppHandle, cwd: String, host_id: Option<String>) -> Result<Option<String>, String> {
    capture_git_tree_at_host(&cwd, saved_remote_host(app, host_id)?.as_ref())
}

fn capture_git_tree_at_host(cwd: &str, host: Option<&RemoteHost>) -> Result<Option<String>, String> {
    match host { Some(host) => remote_git_tree(host, cwd), None => local_git_tree(cwd) }
}
pub(super) fn discard_git_tree(app: AppHandle, snapshot: String, host_id: Option<String>) -> Result<(), String> {
    discard_git_tree_at_host(&snapshot, saved_remote_host(app, host_id)?.as_ref())
}

pub(super) fn discard_git_tree_at_host(snapshot: &str, host: Option<&RemoteHost>) -> Result<(), String> {
    let Some(host) = host else { let snapshot = parse_local_snapshot(snapshot)?; return fs::remove_dir_all(snapshot.root).map_err(|error| format!("Could not discard Git snapshot: {error}")); };
    discard_remote_git_tree(snapshot, &host.name, |script| { let mut command = ssh(host); command.arg(script); command })
}

pub(super) fn discard_remote_git_tree(snapshot: &str, host_name: &str, command: impl FnOnce(String) -> Command) -> Result<(), String> {
    let snapshot: GitSnapshotToken = serde_json::from_str(snapshot).map_err(|_| "Invalid remote Git snapshot token".to_string())?;
    if !valid_remote_snapshot(&snapshot) { return Err("Invalid remote Git snapshot location".into()); }
    let root = shell_quote(&snapshot.root);
    let script = format!("parent=$(cd \"$HOME/{STORAGE_DIRECTORY}/git-snapshots\" && pwd -P) || exit 7; snap=$(cd {root} && pwd -P) || exit 7; [ \"$(dirname -- \"$snap\")\" = \"$parent\" ] || exit 7; case \"$(basename -- \"$snap\")\" in pi-desktop-diff-*) ;; *) exit 7;; esac; rm -rf -- \"$snap\"");
    let output = command(script).output().map_err(|error| format!("Could not discard Git snapshot on {host_name}: {error}"))?;
    output.status.success().then_some(()).ok_or_else(|| String::from_utf8_lossy(&output.stderr).trim().to_string())
}
pub(super) fn load_git_diff(app: AppHandle, cwd: String, base_tree: String, host_id: Option<String>) -> Result<Option<GitDiffSnapshot>, String> {
    load_git_diff_at_host(&cwd, &base_tree, saved_remote_host(app, host_id)?.as_ref())
}

pub(super) fn load_git_diff_at_host(cwd: &str, base_tree: &str, host: Option<&RemoteHost>) -> Result<Option<GitDiffSnapshot>, String> {
    let Some(host) = host else { return local_git_diff(cwd, base_tree); };
    load_remote_git_diff_with(base_tree,
        || remote_git_tree(host, cwd),
        |base_tree, current_token| load_git_diff_between_at_host(cwd, base_tree, current_token, Some(host)),
        |token| discard_git_tree_at_host(token, Some(host)))
}

pub(super) fn load_remote_git_diff_with(base_tree: &str,
    capture: impl FnOnce() -> Result<Option<String>, String>,
    diff: impl FnOnce(&str, &str) -> Result<Option<GitDiffSnapshot>, String>,
    mut discard: impl FnMut(&str) -> Result<(), String>,
) -> Result<Option<GitDiffSnapshot>, String> {
    let base: GitSnapshotToken = serde_json::from_str(base_tree).map_err(|_| "Invalid remote Git snapshot token".to_string())?;
    if !valid_remote_snapshot(&base) { return Err("Invalid remote Git snapshot location".into()); }
    let Some(current_token) = capture()? else { return Ok(None) };
    let result = diff(base_tree, &current_token);
    if result.is_ok() { let _ = discard(base_tree); let _ = discard(&current_token); }
    result
}

pub(super) fn load_git_diff_between_at_host(cwd: &str, base_tree: &str, current_token: &str, host: Option<&RemoteHost>) -> Result<Option<GitDiffSnapshot>, String> {
    let Some(host) = host else { return local_git_diff_between(cwd, &parse_local_snapshot(base_tree)?, &parse_local_snapshot(current_token)?); };
    load_remote_git_diff_between(base_tree, current_token, &host.name, |script| { let mut command = ssh(host); command.arg(script); command })
}

pub(super) fn load_remote_git_diff_between(base_tree: &str, current_token: &str, host_name: &str, command: impl FnOnce(String) -> Command) -> Result<Option<GitDiffSnapshot>, String> {
    let base: GitSnapshotToken = serde_json::from_str(base_tree).map_err(|_| "Invalid remote Git snapshot token".to_string())?;
    let current: GitSnapshotToken = serde_json::from_str(current_token).map_err(|_| "Invalid remote Git snapshot token".to_string())?;
    if !valid_remote_snapshot(&base) || !valid_remote_snapshot(&current) { return Err("Invalid remote Git snapshot location".into()); }
    let script = format!("cd {} || exit 2; parent=$(cd \"$HOME/{STORAGE_DIRECTORY}/git-snapshots\" && pwd -P) || exit 7; base=$(cd {} && pwd -P) || exit 7; current=$(cd {} && pwd -P) || exit 7; for snapshot in \"$base\" \"$current\"; do [ \"$(dirname -- \"$snapshot\")\" = \"$parent\" ] || exit 7; case \"$(basename -- \"$snapshot\")\" in pi-desktop-diff-*) ;; *) exit 7;; esac; done; repo_objects=$(git rev-parse --git-path objects) || exit 3; repo_objects=$(cd \"$repo_objects\" && pwd -P) || exit 3; GIT_OBJECT_DIRECTORY=\"$current/objects\" GIT_ALTERNATE_OBJECT_DIRECTORIES=\"$base/objects:$repo_objects\" node -e {} {} {}", shell_quote(&current.repository_root), shell_quote(&base.root), shell_quote(&current.root), shell_quote(include_str!("../../resources/capture-git-diff.bundle.mjs")), shell_quote(&base.tree), shell_quote(&current.tree));
    let output = run_limited(&mut command(script), MAX_GIT_PATCH_BYTES, &format!("Git patch on {host_name} is too large"))?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let patch = String::from_utf8_lossy(&output.stdout).into_owned();
    Ok((!patch.trim().is_empty()).then_some(GitDiffSnapshot::Located { patch, repository_root: String::new(), tool_paths: Vec::new() }))
}

pub(super) fn remote_session_sidecar_script(session_path: &str, action: &str) -> String {
    format!("session=$(readlink -f -- {}) || exit 7; sessions=$(cd \"$HOME/{STORAGE_DIRECTORY}/sessions\" && pwd -P) || exit 7; case \"$session\" in \"$sessions\"/*.jsonl) ;; *) exit 7;; esac; sidecar=${{session%.jsonl}}.diffs.json; {action}", shell_quote(session_path))
}
pub(super) fn load_git_diffs(app: AppHandle, session_path: String, host_id: Option<String>, cursor: Option<String>) -> Result<serde_json::Value, String> {
    if let Some(cursor) = cursor { return compatibility_diff_page(app, session_path, host_id, &cursor); }
    let mut snapshots = GitDiffSnapshots::new(); let mut page = String::new();
    let mut fragment = None;
    loop {
        let result = load_git_diff_page(app.clone(), session_path.clone(), host_id.clone(), page)?;
        merge_diff_page(&mut snapshots, &mut fragment, &result)?;
        let Some(next) = result["next"].as_str() else { break; };
        page = next.to_owned();
    }
    if fragment.is_some() { return Err("Diff history ended with an incomplete snapshot; preserved".into()); }
    serde_json::to_value(snapshots).map_err(|error| error.to_string())
}

fn compatibility_diff_page(app: AppHandle, session_path: String, host_id: Option<String>, cursor: &str) -> Result<serde_json::Value, String> {
    let (sequence, mut page) = compatibility_diff_cursor(cursor)?;
    let mut snapshots = GitDiffSnapshots::new(); let mut fragment = None;
    let next = loop {
        let result = load_git_diff_page(app.clone(), session_path.clone(), host_id.clone(), page)?;
        merge_diff_page(&mut snapshots, &mut fragment, &result)?;
        let next = result["next"].as_str().map(str::to_owned);
        if fragment.is_none() { break next; }
        page = next.ok_or("Diff history ended with an incomplete snapshot; preserved")?;
    };
    let next = next.map(|page| format!("{sequence:020}:{page}"));
    Ok(serde_json::json!({"snapshots":snapshots,"nextCursor":next}))
}

fn compatibility_diff_cursor(cursor: &str) -> Result<(u64, String), String> {
    if cursor.is_empty() { return Ok((1, String::new())); }
    let (sequence, page) = cursor.split_once(':').ok_or("Invalid diff page cursor; reload history")?;
    let sequence = sequence.parse::<u64>().map_err(|_| "Invalid diff page cursor; reload history")?;
    Ok((sequence.checked_add(1).ok_or("Diff page cursor overflow")?, page.to_owned()))
}

fn merge_diff_page(snapshots: &mut GitDiffSnapshots, fragment: &mut Option<(String, String)>, result: &serde_json::Value) -> Result<(), String> {
    snapshots.extend(serde_json::from_value::<GitDiffSnapshots>(result["snapshots"].clone()).map_err(|error| error.to_string())?);
    let Some(part) = result.get("fragment") else { return Ok(()); };
    let id = part["messageId"].as_str().ok_or("Diff fragment has no message ID")?;
    let content = part["content"].as_str().ok_or("Diff fragment has no contents")?;
    let current = fragment.get_or_insert_with(|| (id.to_owned(), String::new()));
    if current.0 != id || current.1.len() + content.len() > store::MAX_RECORD_BYTES { return Err("Invalid or oversized fragmented snapshot; preserved".into()); }
    current.1.push_str(content);
    if part["complete"] == true { let (id, content) = fragment.take().ok_or("Diff fragment disappeared")?; snapshots.insert(id, serde_json::from_str(&content).map_err(|error| error.to_string())?); }
    Ok(())
}

pub(crate) fn load_ephemeral_git_diff_page(app: AppHandle, session_path: String, session_id: String, host_id: Option<String>, page: String) -> Result<serde_json::Value, String> {
    let host = saved_remote_host(app, host_id)?;
    storage_request(&session_path, &serde_json::json!({"action":"ephemeral_validate","ephemeralSessionId":session_id}), host.as_ref())?;
    if page.is_empty() { pending::recover(&session_path, host.as_ref(), Some(&session_id))?; }
    storage_request(&session_path, &serde_json::json!({"action":"page","cursor":page,"ephemeralSessionId":session_id}), host.as_ref())
}

pub(crate) fn load_git_diff_page(app: AppHandle, session_path: String, host_id: Option<String>, page: String) -> Result<serde_json::Value, String> {
    let host = saved_remote_host(app, host_id)?;
    if host.is_none() && !Path::new(&session_path).exists() {
        load_local_git_diffs(&home_dir()?, &session_path)?;
        return Ok(serde_json::json!({"snapshots":{},"next":null}));
    }
    if page.is_empty() {
        if let Err(error) = crate::git_diff_retry::retry_pending_git_diffs(&session_path, host.as_ref()) { eprintln!("Pending project changes retained for retry: {error}"); }
    }
    pending::page(&session_path, &page, host.as_ref())
}

fn validate_unsaved_session(home: &Path, candidate: &Path) -> Result<(), String> {
        let root = ensure_desktop_sessions_dir(home)?.canonicalize().map_err(|error| format!("Could not locate piop sessions: {error}"))?;
        let parent = candidate.parent().ok_or("Session path has no parent directory")?.canonicalize().map_err(|error| format!("Could not locate session directory: {error}"))?;
        if !candidate.is_absolute() || !parent.starts_with(&root) || candidate.extension().and_then(|value| value.to_str()) != Some("jsonl") { return Err("Only piop session files can be accessed".into()); }
        Ok(())
}

pub(super) fn load_local_git_diffs(home: &Path, session_path: &str) -> Result<GitDiffSnapshots, String> {
    let candidate = PathBuf::from(session_path);
    if !candidate.exists() {
        validate_unsaved_session(home, &candidate)?;
        return Ok(HashMap::new());
    }
    let path = local_desktop_session_file_at(home, session_path)?.with_extension("diffs.json");
    let state = store::request(&path, &serde_json::json!({"action":"load"}))?;
    serde_json::from_value(state["snapshots"].clone()).map_err(|error| error.to_string())
}

#[cfg(test)]
pub(super) fn load_git_diffs_at_host(session_path: &str, host: Option<&RemoteHost>) -> Result<GitDiffSnapshots, String> {
    if host.is_none() && !Path::new(session_path).exists() { return load_local_git_diffs(&home_dir()?, session_path); }
    pending::load(session_path, host)
}

#[cfg(test)]
pub(super) fn query_remote_git_diffs(command: &mut Command, host_name: &str) -> Result<GitDiffSnapshots, String> {
    let state = read_command(command, None).map_err(|error| format!("Diffs on {host_name}: {error}"))?;
    serde_json::from_value(state).map_err(|error| format!("Could not parse saved diffs: {error}"))
}
pub(super) fn save_git_diffs(app: AppHandle, session_path: String, snapshots: GitDiffSnapshots, host_id: Option<String>, client_id: String) -> Result<(), String> {
    save_git_diffs_with_mode(app, session_path, snapshots, host_id, client_id, false)
}

pub(crate) fn save_git_diffs_with_mode(app: AppHandle, session_path: String, snapshots: GitDiffSnapshots, host_id: Option<String>, client_id: String, append: bool) -> Result<(), String> {
    let mutation = conversation_ownership::MutationGuard::acquire(&app, host_id.as_deref().unwrap_or("local"), &session_path, &client_id, false, "save_diffs")?;
    let host = saved_remote_host(app, host_id)?;
    storage_request(&session_path, &serde_json::json!({"action":if append { "merge" } else { "replace" },"snapshots":snapshots}), host.as_ref())?;
    mutation.finish()
}

pub(super) fn save_git_diffs_at_host(session_path: &str, snapshots: GitDiffSnapshots, host: Option<&RemoteHost>) -> Result<(), String> {
    storage_request(session_path, &serde_json::json!({"action":"merge","snapshots":snapshots}), host).map(|_| ())
}

#[cfg(test)]
pub(super) fn save_local_git_diffs(home: &Path, session_path: &str, body: &str) -> Result<(), String> {
    let path = local_desktop_session_file_at(home, session_path)?.with_extension("diffs.json");
    let snapshots: GitDiffSnapshots = serde_json::from_str(body).map_err(|error| error.to_string())?;
    store::request(&path, &serde_json::json!({"action":"replace","snapshots":snapshots})).map(|_| ())
}

pub(super) fn remote_save_git_diffs_script(session_path: &str) -> String {
    let helper = shell_quote(&storage_helper());
    remote_login_command(&remote_session_sidecar_script(session_path, &format!("umask 077; PIOP_STORAGE_DIRECTORY={STORAGE_DIRECTORY} exec flock --exclusive \"$sidecar.lock\" node -e {helper} \"$sidecar\"")))
}

#[cfg(test)]
pub(super) fn write_remote_git_diffs(command: &mut Command, body: &str) -> Result<(), String> {
    let snapshots: GitDiffSnapshots = serde_json::from_str(body).map_err(|error| error.to_string())?;
    read_command(command, Some(&serde_json::json!({"action":"replace","snapshots":snapshots}))).map(|_| ())
}

fn storage_request(session_path: &str, request: &serde_json::Value, host: Option<&RemoteHost>) -> Result<serde_json::Value, String> {
    if let Some(id) = request["ephemeralSessionId"].as_str() { return ephemeral_storage_request(session_path, id, request, host); }
    let Some(host) = host else {
        let home = home_dir()?;
        let path = local_desktop_session_file_at(&home, session_path)?.with_extension("diffs.json");
        if matches!(request["action"].as_str(), Some("retain" | "discover" | "part")) {
            let mut command = crate::node_command();
            command.args(["-e", &storage_helper()]).arg(&path).env("PIOP_STORAGE_DIRECTORY", STORAGE_DIRECTORY).env("PIOP_DIFF_HOME", home).env("PIOP_DIFF_LOCK", "1");
            return read_command(&mut command, Some(request));
        }
        return store::request(&path, request);
    };
    let mut command = ssh(host); command.arg(remote_save_git_diffs_script(session_path));
    read_command(&mut command, Some(request))
}

pub(crate) fn recover_ephemeral_git_diffs_at_host(session_path: &str, session_id: &str, host: Option<&RemoteHost>) -> Result<(), String> {
    storage_request(session_path, &serde_json::json!({"action":"ephemeral_validate","ephemeralSessionId":session_id}), host)?;
    pending::recover(session_path, host, Some(session_id))
}

fn validate_ephemeral_diff_name(session_path: &str, session_id: &str) -> Result<(), String> {
    let path = Path::new(session_path);
    let name = path.file_name().and_then(|value| value.to_str()).ok_or("Invalid temporary transcript filename")?;
    let suffix = name.strip_prefix("pi-desktop-btw-").and_then(|value| value.strip_suffix(".jsonl")).ok_or("Only temporary side-conversation transcripts can be recovered")?;
    if !path.is_absolute() || !path.components().all(|component| matches!(component, std::path::Component::RootDir | std::path::Component::Normal(_))) { return Err("Temporary transcript path must be absolute and normalized".into()); }
    if suffix.len() != 36 || session_id.len() != 36 { return Err("Invalid temporary transcript identity".into()); }
    uuid::Uuid::parse_str(suffix).map_err(|error| error.to_string())?;
    uuid::Uuid::parse_str(session_id).map_err(|error| error.to_string())?;
    Ok(())
}

fn ephemeral_storage_request(session_path: &str, session_id: &str, request: &serde_json::Value, host: Option<&RemoteHost>) -> Result<serde_json::Value, String> {
    validate_ephemeral_diff_name(session_path, session_id)?;
    let sidecar = Path::new(session_path).with_extension("diffs.json");
    let helper = storage_helper();
    let mut command = if let Some(host) = host {
        let mut command = ssh(host);
        command.arg(remote_login_command(&format!("PIOP_STORAGE_DIRECTORY={STORAGE_DIRECTORY} PIOP_DIFF_EPHEMERAL_TMP=/tmp node -e {} {}", shell_quote(&helper), shell_quote(sidecar.to_str().ok_or("Invalid temporary transcript path")?))));
        command
    } else {
        let mut command = crate::node_command();
        command.args(["-e", &helper]).arg(sidecar).env("PIOP_STORAGE_DIRECTORY", STORAGE_DIRECTORY).env("PIOP_DIFF_HOME", home_dir()?).env("PIOP_DIFF_EPHEMERAL_TMP", std::env::temp_dir());
        command
    };
    read_command(&mut command, Some(request))
}

fn storage_helper() -> String {
    format!("{}\ntry {{ const request = JSON.parse(require('node:fs').readFileSync(0, 'utf8')); const result = request.ephemeralSessionId !== undefined ? diffStore.requestEphemeralStore(process.argv[1], request) : process.env.PIOP_DIFF_LOCK === '1' ? diffStore.requestStoreLocked(process.argv[1], request) : diffStore.requestStore(process.argv[1], request); process.stdout.write(JSON.stringify(result)); }} catch (error) {{ process.stderr.write(error.message + '\\n'); process.exitCode = 1; }}", embedded_diff_store())
}

pub(crate) fn embedded_diff_store() -> String {
    format!(r#"const diffStore = ((builtinRequire) => {{
const modules = {{}};
modules['./git-diff-pages.cjs'] = ((require) => {{ const module = {{exports: {{}}}}; {}
return module.exports; }})(builtinRequire);
modules['./git-diff-transfer.cjs'] = ((require) => {{ const module = {{exports: {{}}}}; {}
return module.exports; }})(builtinRequire);
modules['./git-diff-migration.cjs'] = ((require) => {{ const module = {{exports: {{}}}}; {}
return module.exports; }})(builtinRequire);
const require = name => modules[name] ?? builtinRequire(name);
const module = {{exports: {{}}}};
{}
return module.exports;
}})(require);"#, include_str!("../../resources/session-broker/git-diff-pages.cjs"), include_str!("../../resources/session-broker/git-diff-transfer.cjs"), include_str!("../../resources/session-broker/git-diff-migration.cjs"), include_str!("../../resources/session-broker/git-diff-store.cjs"))
}

fn read_command(command: &mut Command, request: Option<&serde_json::Value>) -> Result<serde_json::Value, String> {
    let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|error| error.to_string())?;
    let stderr = child.stderr.take().ok_or("Diff helper stderr unavailable")?;
    let errors = std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stderr); let mut bytes = Vec::new();
        let _ = reader.by_ref().take(64 * 1024).read_to_end(&mut bytes);
        let _ = std::io::copy(&mut reader, &mut std::io::sink());
        bytes
    });
    let written = (|| {
        let mut input = child.stdin.take().ok_or("Diff helper stdin unavailable")?;
        if let Some(request) = request { serde_json::to_writer(&mut input, request).map_err(|error| error.to_string())?; input.flush().map_err(|error| error.to_string())?; }
        Ok::<_, String>(())
    })();
    let parsed = serde_json::from_reader(child.stdout.take().ok_or("Diff helper stdout unavailable")?);
    if parsed.is_err() { let _ = child.kill(); }
    let status = child.wait().map_err(|error| error.to_string())?;
    let stderr = errors.join().map_err(|_| "Diff helper error reader stopped")?;
    if !status.success() { return Err(String::from_utf8_lossy(&stderr).trim().to_owned()); }
    if !stderr.is_empty() { eprintln!("Diff recovery diagnostics: {}", String::from_utf8_lossy(&stderr).trim()); }
    written?;
    parsed.map_err(|error| error.to_string())
}
