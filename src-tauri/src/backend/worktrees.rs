#[cfg_attr(feature = "desktop", tauri::command(async))]
fn is_git_repository(app: AppHandle, cwd: String, host_id: Option<String>) -> Result<bool, String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    let output = if host_id == "local" {
        Command::new("git").args(["-C", &cwd, "rev-parse", "--git-dir"]).output().map_err(|error| format!("Could not inspect project Git repository: {error}"))?
    } else {
        let settings = load_app_settings(app)?; let host = remote_host(&settings, &host_id)?;
        ssh(host).arg(format!("git -C {} rev-parse --git-dir", shell_quote(&cwd))).output().map_err(|error| format!("Could not inspect Git repository on {}: {error}", host.name))?
    };
    Ok(output.status.success())
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
fn git_branch(app: AppHandle, cwd: String, host_id: Option<String>) -> Result<Option<String>, String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    let host = if host_id == "local" { None } else { Some(remote_host(&load_app_settings(app)?, &host_id)?.clone()) };
    git_branch_at(&cwd, host.as_ref())
}

fn git_branch_at(cwd: &str, host: Option<&RemoteHost>) -> Result<Option<String>, String> {
    let output = if let Some(host) = host {
        ssh(host).arg(format!("git -C {} rev-parse --abbrev-ref HEAD", shell_quote(cwd))).output().map_err(|error| format!("Could not read Git branch on {}: {error}", host.name))?
    } else {
        Command::new("git").args(["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]).output().map_err(|error| format!("Could not read project Git branch: {error}"))?
    };
    if !output.status.success() { return Ok(None); }
    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!branch.is_empty()).then_some(branch))
}

fn inspect_git_project_kind(settings: &AppSettings, cwd: &str, host_id: &str) -> Result<ProjectKind, String> {
    let script = format!(r#"[ -d {cwd} ] || {{ printf 'Project directory does not exist' >&2; exit 3; }}
git_dir=$(git -C {cwd} rev-parse --absolute-git-dir 2>/dev/null) || {{ printf 'no-repo'; exit 0; }}
common_dir=$(git -C {cwd} rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 1
git_dir=$(cd -- "$git_dir" && pwd -P) || exit 1
common_dir=$(cd -- "$common_dir" && pwd -P) || exit 1
if [ "$git_dir" = "$common_dir" ]; then printf 'main'; else printf 'worktree'; fi"#, cwd = shell_quote(cwd));
    let mut command = if host_id == "local" {
        let mut command = Command::new("sh"); command.args(["-c", &script]); command
    } else {
        let host = remote_host(settings, host_id)?;
        let mut command = ssh(host); command.arg(remote_login_command(&script)); command
    };
    let output = run_limited(&mut command, 64 * 1024, "Could not inspect project Git repository")?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if error.is_empty() { "Could not inspect project Git repository".into() } else { error });
    }
    match output.stdout.as_slice() {
        b"no-repo" => Ok(ProjectKind::NoRepo),
        b"main" => Ok(ProjectKind::Main),
        b"worktree" => Ok(ProjectKind::Worktree),
        _ => Err("Git returned an unknown project kind".into()),
    }
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
fn git_project_kind(app: AppHandle, cwd: String, host_id: Option<String>) -> Result<ProjectKind, String> {
    let settings = load_app_settings(app)?;
    inspect_git_project_kind(&settings, &cwd, host_id.as_deref().unwrap_or("local"))
}

fn worktree_suffix(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() { return Err("Name can't be empty".into()); }
    if !name.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')) { return Err("Name may only contain letters, numbers, dots, hyphens, and underscores".into()); }
    Ok(name)
}

fn worktree_branch_name(project: &str, name: &str) -> String {
    let mut prefix = String::new();
    let mut separator = false;
    for character in project.chars() {
        if character.is_ascii_alphanumeric() || character == '_' {
            if separator && !prefix.is_empty() { prefix.push('-'); }
            prefix.push(character);
            separator = false;
        } else { separator = true; }
    }
    if prefix.is_empty() { prefix.push_str("project"); }
    format!("{prefix}/{name}")
}

fn parse_worktree_output(output: LimitedOutput, context: &str) -> Result<GitWorktree, String> {
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if error.is_empty() { context.into() } else { error });
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut lines = text.lines();
    let branch = lines.next().unwrap_or_default().to_string();
    let path = lines.next().unwrap_or_default().to_string();
    if branch.is_empty() || path.is_empty() { return Err(format!("{context}: Git returned an incomplete result")); }
    Ok(GitWorktree { branch, path })
}

fn copy_untracked_symlink(source: &Path, target: &Path, relative: &Path) -> Result<(), String> {
        let link = fs::read_link(source).map_err(|error| format!("Could not read untracked symlink {}: {error}", relative.display()))?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(link, target).map_err(|error| format!("Could not copy untracked symlink {}: {error}", relative.display()))?;
        #[cfg(windows)]
        if source.is_dir() { std::os::windows::fs::symlink_dir(link, &target) } else { std::os::windows::fs::symlink_file(link, &target) }.map_err(|error| format!("Could not copy untracked symlink {}: {error}", relative.display()))?;
        #[cfg(not(any(unix, windows)))]
        return Err(format!("Copying untracked symlinks is unsupported on this platform: {}", relative.display()));
    Ok(())
}

fn copy_untracked_directory(source_root: &Path, target_root: &Path, relative: &Path) -> Result<(), String> {
        let source = source_root.join(relative); let target = target_root.join(relative);
        fs::create_dir_all(&target).map_err(|error| format!("Could not prepare untracked directory {}: {error}", relative.display()))?;
        for entry in fs::read_dir(&source).map_err(|error| format!("Could not read untracked directory {}: {error}", relative.display()))? {
            let entry = entry.map_err(|error| format!("Could not read untracked directory {}: {error}", relative.display()))?;
            if entry.file_name() == ".git" { continue; }
            copy_untracked_file(source_root, target_root, &relative.join(entry.file_name()))?;
        }
    Ok(())
}

fn copy_untracked_file(source_root: &Path, target_root: &Path, relative: &Path) -> Result<(), String> {
    if !relative.components().all(|component| matches!(component, std::path::Component::Normal(_))) { return Err("Git returned an invalid untracked path".into()); }
    let source = source_root.join(relative); let target = target_root.join(relative);
    let metadata = fs::symlink_metadata(&source).map_err(|error| format!("Could not inspect untracked file {}: {error}", relative.display()))?;
    if let Some(parent) = target.parent() { fs::create_dir_all(parent).map_err(|error| format!("Could not prepare untracked file {}: {error}", relative.display()))?; }
    if metadata.file_type().is_symlink() {
        return copy_untracked_symlink(&source, &target, relative);
    }
    if metadata.is_dir() { return copy_untracked_directory(source_root, target_root, relative); }
    if !metadata.is_file() { return Err(format!("Unsupported untracked filesystem entry: {}", relative.display())); }
    fs::copy(&source, &target).map_err(|error| format!("Could not copy untracked file {}: {error}", relative.display()))?;
    Ok(())
}

#[cfg(unix)]
fn git_relative_path(bytes: &[u8]) -> PathBuf {
    use std::os::unix::ffi::OsStrExt;
    PathBuf::from(std::ffi::OsStr::from_bytes(bytes))
}

#[cfg(not(unix))]
fn git_relative_path(bytes: &[u8]) -> PathBuf { PathBuf::from(String::from_utf8_lossy(bytes).into_owned()) }

fn remove_created_worktree(root: &Path, target: &Path, branch: &str) {
    let _ = Command::new("git").arg("-C").arg(root).args(["worktree", "remove", "--force"]).arg(target).stdout(Stdio::null()).stderr(Stdio::null()).status();
    let _ = Command::new("git").arg("-C").arg(root).args(["branch", "-D", branch]).stdout(Stdio::null()).stderr(Stdio::null()).status();
}

fn local_branch_exists(root: &Path, branch: &str) -> Result<bool, String> {
    let reference = format!("refs/heads/{branch}");
    let status = Command::new("git").arg("-C").arg(root).args(["show-ref", "--verify", "--quiet", &reference]).status().map_err(|error| format!("Could not inspect Git branches: {error}"))?;
    match status.code() { Some(0) => Ok(true), Some(1) => Ok(false), _ => Err("Could not inspect Git branches".into()) }
}

fn local_worktree_is_registered(root: &Path, target: &Path) -> Result<bool, String> {
    let output = run_limited(Command::new("git").arg("-C").arg(root).args(["worktree", "list", "--porcelain", "-z"]), 1024 * 1024, "Could not inspect Git worktrees")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let prefix = "worktree "; let target = target.to_string_lossy();
    Ok(output.stdout.split(|byte| *byte == 0).any(|field| String::from_utf8_lossy(field).strip_prefix(prefix).is_some_and(|path| path == target)))
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
fn create_project_worktree(app: AppHandle, cwd: String, name: String, host_id: Option<String>) -> Result<GitWorktree, String> {
    let settings = load_app_settings(app)?;
    let host_id = host_id.as_deref().unwrap_or("local");
    let host = if host_id == "local" { None } else { Some(remote_host(&settings, host_id)?) };
    create_project_worktree_at(&cwd, &name, host)
}

fn project_worktree_root(cwd: &str, host: Option<&RemoteHost>) -> Result<PathBuf, String> {
    let located = if let Some(host) = host {
        run_limited(ssh(host).arg(format!("git -C {} rev-parse --show-toplevel", shell_quote(cwd))), 64 * 1024, "Could not locate Git repository")?
    } else {
        run_limited(Command::new("git").args(["-C", cwd, "rev-parse", "--show-toplevel"]), 64 * 1024, "Could not locate Git repository")?
    };
    if !located.status.success() { return Err("Project is not a Git repository".into()); }
    Ok(PathBuf::from(String::from_utf8_lossy(&located.stdout).trim()))
}

struct ManagedWorktreeTarget { path: PathBuf, host: Option<RemoteHost> }

fn worktree_storage_command(action: &str, directory: &Path, host: Option<&RemoteHost>) -> Command {
    let script = include_str!("../../resources/worktree-storage.cjs");
    if let Some(host) = host {
        let mut command = ssh(host);
        command.arg(format!("node -e {} {} {} {}", shell_quote(script), shell_quote(action), shell_quote(&directory.to_string_lossy()), shell_quote(STORAGE_DIRECTORY)));
        command
    } else {
        let mut command = node_command();
        command.args(["-e", script, action]).arg(directory).arg(STORAGE_DIRECTORY);
        command
    }
}

impl Drop for ManagedWorktreeTarget {
    fn drop(&mut self) {
        let _ = run_limited(&mut worktree_storage_command("cleanup", &self.path, self.host.as_ref()), 64 * 1024, "Could not clean up worktree storage");
    }
}

fn managed_worktree_target(root: &Path, host: Option<&RemoteHost>) -> Result<ManagedWorktreeTarget, String> {
    let output = run_limited(&mut worktree_storage_command("allocate", root, host), 64 * 1024, "Could not allocate worktree storage")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let path = String::from_utf8(output.stdout).map_err(|error| error.to_string())?;
    if path.is_empty() { return Err("Worktree storage path was unavailable".into()); }
    Ok(ManagedWorktreeTarget { path: PathBuf::from(path), host: host.cloned() })
}

fn create_project_worktree_at(cwd: &str, name: &str, host: Option<&RemoteHost>) -> Result<GitWorktree, String> {
    let name = worktree_suffix(name)?;
    let root = project_worktree_root(cwd, host)?;
    let project = root.file_name().ok_or("Git repository directory has no name")?.to_string_lossy();
    let branch = worktree_branch_name(&project, name);
    let reservation = managed_worktree_target(&root, host)?;
    let target = &reservation.path;
    let output = if let Some(host) = host {
        run_limited(ssh(host).arg(format!("git -C {} worktree add -b {} {} HEAD", shell_quote(&root.to_string_lossy()), shell_quote(&branch), shell_quote(&target.to_string_lossy()))), 64 * 1024, "Could not create Git worktree")?
    } else {
        run_limited(Command::new("git").arg("-C").arg(&root).args(["worktree", "add", "-b", &branch]).arg(&target).arg("HEAD"), 64 * 1024, "Could not create Git worktree")?
    };
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if error.is_empty() { "Could not create Git worktree".into() } else { error });
    }
    Ok(GitWorktree { branch, path: target.to_string_lossy().into_owned() })
}

fn remote_worktree_root(cwd: &str, host: &RemoteHost) -> Result<String, String> {
    let locate = format!("root=$(git -C {} rev-parse --show-toplevel 2>/dev/null) || exit 3; cd \"$root\" && pwd -P", shell_quote(cwd));
    let located = run_limited(ssh(host).arg(locate), 64 * 1024, &format!("Could not locate Git repository on {}", host.name))?;
    if !located.status.success() {
        if located.status.code() == Some(3) { return Err("Project is not a Git repository".into()); }
        let error = String::from_utf8_lossy(&located.stderr).trim().to_string();
        return Err(if error.is_empty() { format!("Could not locate Git repository on {}", host.name) } else { error });
    }
    let root = String::from_utf8_lossy(&located.stdout).trim().to_string();
    Ok(root)
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
fn create_git_worktree(app: AppHandle, cwd: String, name: String, host_id: Option<String>) -> Result<GitWorktree, String> {
    let name = worktree_suffix(&name)?;
    let host_id = host_id.as_deref().unwrap_or("local");
    if host_id != "local" {
        let settings = load_app_settings(app)?; let host = remote_host(&settings, host_id)?;
        let root = remote_worktree_root(&cwd, host)?;
        let project = Path::new(&root).file_name().ok_or("Git repository directory has no name")?.to_string_lossy();
        let branch = worktree_branch_name(&project, name);
        let reservation = managed_worktree_target(Path::new(&root), Some(host))?;
        let script = format!(r#"root={root}; branch={branch}; git check-ref-format --branch "$branch" >/dev/null || {{ printf 'Invalid Git branch name: %s' "$branch" >&2; exit 1; }}; git -C "$root" show-ref --verify --quiet "refs/heads/$branch" && {{ printf 'Git branch already exists: %s' "$branch" >&2; exit 1; }}; [ $? -eq 1 ] || {{ printf 'Could not inspect Git branches' >&2; exit 1; }}; target={target}; if [ -e "$target" ] || [ -L "$target" ]; then printf 'Worktree directory already exists: %s' "$target" >&2; exit 1; fi; worktrees=$(git -C "$root" worktree list --porcelain) || {{ printf 'Could not inspect Git worktrees' >&2; exit 1; }}; printf '%s\n' "$worktrees" | grep -Fqx "worktree $target" && {{ printf 'Git worktree is already registered: %s' "$target" >&2; exit 1; }}; [ $? -eq 1 ] || {{ printf 'Could not inspect Git worktrees' >&2; exit 1; }}; temporary=$(mktemp -d "${{TMPDIR:-/tmp}}/pi-desktop-worktree.XXXXXX") || exit 1; created=0; cleanup() {{ status=$?; rm -rf -- "$temporary"; if [ "$status" -ne 0 ] && [ "$created" -eq 1 ]; then git -C "$root" worktree remove --force "$target" >/dev/null 2>&1; git -C "$root" branch -D "$branch" >/dev/null 2>&1; fi; exit "$status"; }}; trap cleanup EXIT; has_head=0; if git -C "$root" rev-parse --verify HEAD >/dev/null 2>&1; then has_head=1; fi; : > "$temporary/changes.patch"; if [ "$has_head" -eq 1 ]; then mkfifo "$temporary/patch.pipe" || exit 1; git -C "$root" diff --binary --no-textconv --no-ext-diff HEAD -- > "$temporary/patch.pipe" 2> "$temporary/diff-error" & diff_pid=$!; head -c {patch_plus_one} < "$temporary/patch.pipe" > "$temporary/changes.patch"; wait "$diff_pid"; diff_status=$?; rm -f -- "$temporary/patch.pipe"; patch_bytes=$(wc -c < "$temporary/changes.patch"); [ "$patch_bytes" -le {max_patch} ] || {{ printf 'Git changes are too large to copy' >&2; exit 1; }}; [ "$diff_status" -eq 0 ] || {{ cat "$temporary/diff-error" >&2; printf 'Could not capture Git changes' >&2; exit 1; }}; fi; git -C "$root" ls-files -z --others --exclude-standard $(test "$has_head" -eq 0 && printf %s --cached) -- > "$temporary/untracked" || exit 1; if [ "$has_head" -eq 1 ]; then git -C "$root" worktree add -b "$branch" "$target" >/dev/null || exit 1; else git -C "$root" worktree add --orphan -b "$branch" "$target" >/dev/null || exit 1; fi; created=1; if [ -s "$temporary/changes.patch" ]; then git -C "$target" apply --whitespace=nowarn "$temporary/changes.patch" || exit 1; fi; if [ -s "$temporary/untracked" ]; then tar -C "$root" --exclude=.git --null -T "$temporary/untracked" -cf "$temporary/untracked.tar" || exit 1; tar -C "$target" -xf "$temporary/untracked.tar" || exit 1; fi; printf '%s\n%s\n' "$branch" "$target""#,
            root = shell_quote(&root), branch = shell_quote(&branch), target = shell_quote(&reservation.path.to_string_lossy()),
            patch_plus_one = MAX_GIT_PATCH_BYTES + 1, max_patch = MAX_GIT_PATCH_BYTES);
        let output = run_limited(ssh(host).arg(script), 64 * 1024, &format!("Could not create Git worktree on {}", host.name))?;
        return parse_worktree_output(output, "Could not create Git worktree");
    }

    create_local_git_worktree(&cwd, name)
}

fn new_local_worktree_target(root: &Path, branch: &str) -> Result<ManagedWorktreeTarget, String> {
    let valid = Command::new("git").args(["check-ref-format", "--branch", branch]).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|error| format!("Could not validate Git branch: {error}"))?;
    if !valid.success() { return Err(format!("Invalid Git branch name: {branch}")); }
    if local_branch_exists(root, branch)? { return Err(format!("Git branch already exists: {branch}")); }
    let reservation = managed_worktree_target(root, None)?;
    let target = &reservation.path;
    if fs::symlink_metadata(&target).is_ok() { return Err(format!("Worktree directory already exists: {}", target.display())); }
    if local_worktree_is_registered(root, &target)? { return Err(format!("Git worktree is already registered: {}", target.display())); }
    Ok(reservation)
}

fn write_worktree_patch(path: &Path, patch: &[u8]) -> std::io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    if let Err(error) = file.write_all(patch) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(error);
    }
    Ok(())
}

fn local_worktree_patch(root: &Path, has_head: bool) -> Result<Vec<u8>, String> {
    if has_head {
        let output = run_limited(Command::new("git").arg("-C").arg(root).args(["diff", "--binary", "--no-textconv", "--no-ext-diff", "HEAD", "--"]), MAX_GIT_PATCH_BYTES, "Git changes are too large to copy")?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
        Ok(output.stdout)
    } else { Ok(Vec::new()) }
}

fn local_worktree_untracked(root: &Path, has_head: bool) -> Result<LimitedOutput, String> {
    let mut files = Command::new("git"); files.arg("-C").arg(root).args(["ls-files", "-z", "--others", "--exclude-standard"]); if !has_head { files.arg("--cached"); } files.arg("--");
    let untracked = run_limited(&mut files, MAX_GIT_PATH_LIST_BYTES, "Untracked file list is too large to copy")?;
    if !untracked.status.success() { return Err(String::from_utf8_lossy(&untracked.stderr).trim().to_string()); }
    Ok(untracked)
}

fn add_local_worktree(root: &Path, branch: &str, target: &Path, has_head: bool) -> Result<(), String> {
    let mut add_worktree = Command::new("git"); add_worktree.arg("-C").arg(root).args(["worktree", "add"]);
    if !has_head { add_worktree.arg("--orphan"); }
    add_worktree.args(["-b", branch]).arg(target);
    let output = run_limited(&mut add_worktree, 64 * 1024, "Could not create Git worktree")?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if error.is_empty() { "Could not create Git worktree".into() } else { error });
    }
    Ok(())
}

fn canonical_worktree_root(cwd: &str) -> Result<PathBuf, String> {
    project_worktree_root(cwd, None)?.canonicalize().map_err(|error| format!("Could not resolve Git repository: {error}"))
}

fn create_local_git_worktree(cwd: &str, name: &str) -> Result<GitWorktree, String> {
    let name = worktree_suffix(name)?;
    let root = canonical_worktree_root(cwd)?;
    let project = root.file_name().ok_or("Git repository directory has no name")?.to_string_lossy();
    let branch = worktree_branch_name(&project, name);
    let reservation = new_local_worktree_target(&root, &branch)?;
    let target = &reservation.path;
    let has_head = Command::new("git").arg("-C").arg(&root).args(["rev-parse", "--verify", "HEAD"]).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|error| format!("Could not inspect Git HEAD: {error}"))?.success();
    let patch = local_worktree_patch(&root, has_head)?;
    let untracked = local_worktree_untracked(&root, has_head)?;
    add_local_worktree(&root, &branch, &target, has_head)?;
    let copy_result = (|| {
        if !patch.is_empty() {
            let patch_path = std::env::temp_dir().join(format!("pi-desktop-worktree-{}.patch", Uuid::new_v4()));
            write_worktree_patch(&patch_path, &patch).map_err(|error| format!("Could not prepare Git changes for copying: {error}"))?;
            let applied = run_limited(Command::new("git").arg("-C").arg(&target).args(["apply", "--whitespace=nowarn"]).arg(&patch_path), 64 * 1024, "Could not copy Git changes");
            let _ = fs::remove_file(&patch_path);
            let applied = applied?;
            if !applied.status.success() { return Err(String::from_utf8_lossy(&applied.stderr).trim().to_string()); }
        }
        for raw in untracked.stdout.split(|byte| *byte == 0).filter(|path| !path.is_empty()) {
            copy_untracked_file(&root, &target, &git_relative_path(raw))?;
        }
        Ok(())
    })();
    if let Err(error) = copy_result { remove_created_worktree(&root, &target, &branch); return Err(error); }
    Ok(GitWorktree { branch, path: target.to_string_lossy().into_owned() })
}

struct WorktreeRemovalTarget { path: String, source: String, branch: Option<String> }

fn canonical_worktree_roots(settings: &AppSettings, host_id: &str, paths: &[String]) -> Result<Vec<Option<String>>, String> {
    let script = r#"command -v git >/dev/null 2>&1 || exit 2
for path do
    if root=$(git -C "$path" rev-parse --show-toplevel 2>/dev/null) && root=$(cd -- "$root" 2>/dev/null && pwd -P); then
        printf '%s\000' "$root"
    else
        printf '\000'
    fi
done"#;
    let host = if host_id == "local" { None } else { Some(remote_host(settings, host_id)?) };
    let mut roots = Vec::with_capacity(paths.len());
    for batch in paths.chunks(128) {
        let mut command = if let Some(host) = host {
            let arguments = batch.iter().map(|path| shell_quote(path)).collect::<Vec<_>>().join(" ");
            let remote = format!("sh -c {} sh {arguments}", shell_quote(script));
            let mut command = ssh(host); command.arg(remote_login_command(&remote)); command
        } else {
            let mut command = Command::new("sh"); command.args(["-c", script, "sh"]).args(batch); command
        };
        let context = host.map(|host| format!("Could not resolve worktree paths on {}", host.name)).unwrap_or_else(|| "Could not resolve worktree paths".into());
        let output = run_limited(&mut command, MAX_GIT_PATH_LIST_BYTES, &context)?;
        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if error.is_empty() { context } else { format!("{context}: {error}") });
        }
        let fields = output.stdout.strip_suffix(&[0]).ok_or("Incomplete worktree path details")?.split(|byte| *byte == 0).collect::<Vec<_>>();
        if fields.len() != batch.len() { return Err("Could not resolve every worktree path".into()); }
        roots.extend(fields.into_iter().map(|field| (!field.is_empty()).then(|| String::from_utf8_lossy(field).into_owned())));
    }
    Ok(roots)
}

#[cfg_attr(feature = "desktop", tauri::command)]
async fn git_worktree_roots(app: AppHandle, paths: Vec<String>, host_id: Option<String>) -> Result<Vec<Option<String>>, String> {
    crate::platform::async_runtime::spawn_blocking(move || {
        let settings = load_app_settings(app)?;
        canonical_worktree_roots(&settings, host_id.as_deref().unwrap_or("local"), &paths)
    }).await.map_err(|error| error.to_string())?
}

fn sessions_on_host(settings: &AppSettings, index: &SessionIndexRuntime, host_id: &str) -> Result<Vec<SessionSummary>, String> {
    if host_id == "local" {
        let root = ensure_desktop_sessions_dir(&home_dir()?)?;
        return list_local_sessions(index, &root);
    }
    let host = remote_host(settings, host_id)?;
    list_remote_sessions(index, host).map_err(|error| format!("Could not verify conversations on {}: {error}", host.name))
}

fn inspect_worktree_removal(settings: &AppSettings, cwd: &str, host_id: &str) -> Result<WorktreeRemovalTarget, String> {
    let script = format!(r#"target=$(git -C {cwd} rev-parse --show-toplevel 2>/dev/null) || {{ printf 'Project is not a Git repository' >&2; exit 1; }}
target=$(cd -- "$target" && pwd -P) || exit 1
git_dir=$(git -C "$target" rev-parse --absolute-git-dir) || exit 1
common_dir=$(git -C "$target" rev-parse --path-format=absolute --git-common-dir) || exit 1
git_dir=$(cd -- "$git_dir" && pwd -P) || exit 1
common_dir=$(cd -- "$common_dir" && pwd -P) || exit 1
[ "$git_dir" != "$common_dir" ] || {{ printf 'The main checkout cannot be deleted as a worktree' >&2; exit 1; }}
worktree_list=$(mktemp "${{TMPDIR:-/tmp}}/piop-worktree-list.XXXXXX") || exit 1
trap 'rm -f -- "$worktree_list"' EXIT
git -C "$target" worktree list --porcelain -z >"$worktree_list" || exit 1
source=
record_path=
target_locked=0
target_lock_reason=
while IFS= read -r -d '' field; do
    case "$field" in
        "worktree "*)
            record_path=${{field#worktree }}
            [ -n "$source" ] || source=$record_path
            ;;
        locked)
            if [ "$record_path" = "$target" ]; then target_locked=1; fi
            ;;
        "locked "*)
            if [ "$record_path" = "$target" ]; then target_locked=1; target_lock_reason=${{field#locked }}; fi
            ;;
        "") record_path= ;;
    esac
done <"$worktree_list"
[ -n "$source" ] || {{ printf 'Could not locate the main checkout' >&2; exit 1; }}
[ "$target_locked" -eq 0 ] || {{
    if [ -n "$target_lock_reason" ]; then printf 'Worktree is locked: %s' "$target_lock_reason" >&2; else printf 'Worktree is locked; unlock it before deletion' >&2; fi
    exit 1
}}
source=$(cd -- "$source" && pwd -P) || exit 1
status=$(git -C "$target" status --porcelain=v1 --untracked-files=normal) || exit 1
[ -z "$status" ] || {{ printf 'Worktree has uncommitted or untracked changes; commit or remove them before deletion' >&2; exit 1; }}
branch=$(git -C "$target" symbolic-ref --quiet --short HEAD 2>/dev/null) || branch=
printf '%s\000%s\000%s\000' "$target" "$source" "$branch""#, cwd = shell_quote(cwd));
    let mut command = if host_id == "local" {
        let mut command = Command::new("bash"); command.args(["-c", &script]); command
    } else {
        let host = remote_host(settings, host_id)?;
        let mut command = ssh(host); command.arg(remote_login_command(&script)); command
    };
    let output = run_limited(&mut command, 64 * 1024, "Could not inspect Git worktree")?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if error.is_empty() { "Could not inspect Git worktree".into() } else { error });
    }
    let fields = output.stdout.split(|byte| *byte == 0).collect::<Vec<_>>();
    if fields.len() < 4 || fields[0].is_empty() || fields[1].is_empty() { return Err("Git returned incomplete worktree details".into()); }
    Ok(WorktreeRemovalTarget {
        path: String::from_utf8_lossy(fields[0]).into_owned(),
        source: String::from_utf8_lossy(fields[1]).into_owned(),
        branch: (!fields[2].is_empty()).then(|| String::from_utf8_lossy(fields[2]).into_owned()),
    })
}

fn remove_git_worktree_blocking(app: AppHandle, cwd: String, host_id: Option<String>, delete_branch: bool) -> Result<GitWorktreeRemoval, String> {
    remove_git_worktree_cancellable(app, cwd, host_id, delete_branch, &AtomicBool::new(false))
}

fn validated_removal_target(app: &AppHandle, settings: &AppSettings, cwd: &str, host_id: &str) -> Result<WorktreeRemovalTarget, String> {
    let runtime = app.state::<PiRuntime>();
    let terminals = app.state::<TerminalRuntime>();
    let session_index = app.state::<SessionIndexRuntime>();
    let target = inspect_worktree_removal(settings, cwd, host_id)?;
    let session_paths = sessions_on_host(settings, &session_index, host_id)?.into_iter().map(|session| session.cwd).collect::<Vec<_>>();
    validate_worktree_unused(settings, host_id, &target.path, &session_paths, &runtime, &terminals)?;
    Ok(target)
}

fn remove_git_worktree_cancellable(app: AppHandle, cwd: String, host_id: Option<String>, delete_branch: bool, cancelled: &AtomicBool) -> Result<GitWorktreeRemoval, String> {
    let host_id = host_id.unwrap_or_else(|| "local".into());
    let settings = load_app_settings(app.clone())?;
    let runtime = app.state::<PiRuntime>();
    let target = validated_removal_target(&app, &settings, &cwd, &host_id)?;
    run_worktree_scripts(&settings, &target.source, &target.path, &host_id, cancelled, WorktreeScriptPhase::Cleanup)?;
    let _lifecycle = runtime.lifecycle.lock().map_err(|_| "Session lifecycle lock was poisoned")?;
    let target = validated_removal_target(&app, &settings, &cwd, &host_id)?;
    if cancelled.load(Ordering::SeqCst) { return Err("Worktree removal cancelled".into()); }
    remove_worktree_target(&settings, &host_id, target, delete_branch, cancelled)
}

fn validate_worktree_unused(settings: &AppSettings, host_id: &str, target: &str, session_paths: &[String], runtime: &PiRuntime, terminals: &TerminalRuntime) -> Result<(), String> {
    let conversations = canonical_worktree_roots(settings, host_id, session_paths)?.into_iter().filter(|root| root.as_deref() == Some(target)).count();
    if conversations > 0 {
        return Err(format!("Archive or relocate the {conversations} conversation{} using this worktree before deleting it", if conversations == 1 { "" } else { "s" }));
    }
    let agent_paths = runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.values().filter(|agent| agent.host_id == host_id).filter_map(|agent| agent.worktree.clone()).collect::<Vec<_>>();
    if canonical_worktree_roots(settings, host_id, &agent_paths)?.into_iter().any(|root| root.as_deref() == Some(target)) {
        return Err("Close every conversation using this worktree before deleting it".into());
    }
    let terminal_paths = terminals.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?.values().filter(|terminal| terminal.host_id == host_id).map(|terminal| terminal.cwd.clone()).collect::<Vec<_>>();
    if canonical_worktree_roots(settings, host_id, &terminal_paths)?.into_iter().any(|root| root.as_deref() == Some(target)) {
        return Err("Close every terminal using this worktree before deleting it".into());
    }
    Ok(())
}

fn preserve_worktree_checkpoints(settings: &AppSettings, host_id: &str, target: &WorktreeRemovalTarget) -> Result<(), String> {
    let script = include_str!("../../resources/preserve-archive-checkpoints.cjs");
    let mut preserve = if host_id == "local" {
        let mut command = node_command(); command.env("PIOP_STORAGE_DIRECTORY", STORAGE_DIRECTORY).args(["-e", script, &target.path]); command
    } else {
        let mut command = ssh(remote_host(settings, host_id)?);
        command.arg(remote_login_command(&format!("PIOP_STORAGE_DIRECTORY={STORAGE_DIRECTORY} node -e {} {}", shell_quote(script), shell_quote(&target.path)))); command
    };
    let preserved = run_limited(&mut preserve, 64 * 1024, "Could not preserve archived checkpoints")?;
    if !preserved.status.success() { return Err(format!("Could not preserve archived checkpoints: {}", String::from_utf8_lossy(&preserved.stderr).trim())); }
    Ok(())
}

fn cleanup_worktree_storage(settings: &AppSettings, host_id: &str, path: &str) {
    let host = if host_id == "local" { None } else {
        let Ok(host) = remote_host(settings, host_id) else { return; };
        Some(host)
    };
    let _ = run_limited(&mut worktree_storage_command("cleanup", Path::new(path), host), 64 * 1024, "Could not clean up worktree storage");
}

fn remove_worktree_target(settings: &AppSettings, host_id: &str, target: WorktreeRemovalTarget, delete_branch: bool, cancelled: &AtomicBool) -> Result<GitWorktreeRemoval, String> {
    preserve_worktree_checkpoints(settings, host_id, &target)?;
    if cancelled.load(Ordering::SeqCst) { return Err("Worktree removal cancelled".into()); }
    let removed = if host_id == "local" {
        run_limited(Command::new("git").arg("-C").arg(&target.source).args(["worktree", "remove"]).arg(&target.path), 64 * 1024, "Could not remove Git worktree")?
    } else {
        let host = remote_host(settings, host_id)?;
        run_limited(ssh(host).arg(format!("git -C {} worktree remove -- {}", shell_quote(&target.source), shell_quote(&target.path))), 64 * 1024, &format!("Could not remove Git worktree on {}", host.name))?
    };
    if !removed.status.success() {
        let error = String::from_utf8_lossy(&removed.stderr).trim().to_string();
        return Err(if error.is_empty() { "Could not remove Git worktree".into() } else { error });
    }
    cleanup_worktree_storage(settings, host_id, &target.path);
    if !delete_branch { return Ok(GitWorktreeRemoval { branch: target.branch, branch_deleted: false, warning: None }); }
    remove_worktree_branch(settings, host_id, target)
}

fn remove_worktree_branch(settings: &AppSettings, host_id: &str, target: WorktreeRemovalTarget) -> Result<GitWorktreeRemoval, String> {
    let Some(branch) = target.branch.as_deref() else {
        return Ok(GitWorktreeRemoval { branch: None, branch_deleted: false, warning: Some("The detached worktree was removed; there was no branch to delete".into()) });
    };
    let deleted = if host_id == "local" {
        run_limited(Command::new("git").arg("-C").arg(&target.source).args(["branch", "-d", "--", branch]), 64 * 1024, "Could not delete Git branch")?
    } else {
        let host = remote_host(settings, host_id)?;
        run_limited(ssh(host).arg(format!("git -C {} branch -d -- {}", shell_quote(&target.source), shell_quote(branch))), 64 * 1024, &format!("Could not delete Git branch on {}", host.name))?
    };
    if deleted.status.success() { return Ok(GitWorktreeRemoval { branch: target.branch, branch_deleted: true, warning: None }); }
    let detail = String::from_utf8_lossy(&deleted.stderr).trim().to_string();
    let warning = if detail.is_empty() { format!("Worktree removed, but branch '{branch}' could not be deleted") } else { format!("Worktree removed, but branch '{branch}' was kept:\n{detail}") };
    Ok(GitWorktreeRemoval { branch: target.branch, branch_deleted: false, warning: Some(warning) })
}

#[cfg_attr(feature = "desktop", tauri::command)]
async fn remove_git_worktree(app: AppHandle, cwd: String, host_id: Option<String>, delete_branch: bool) -> Result<GitWorktreeRemoval, String> {
    crate::platform::async_runtime::spawn_blocking(move || remove_git_worktree_blocking(app, cwd, host_id, delete_branch)).await.map_err(|error| error.to_string())?
}
