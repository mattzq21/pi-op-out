use super::{
    controller::{Host, ReadonlyView},
    ownership::{ownership_error, Guard},
    protocol::{kind, text, Result},
    session::Session,
};
use serde_json::{json, Value};
use std::{
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};
use uuid::Uuid;

pub(super) async fn switch(host: &Arc<Host>, session: &Arc<Session>, runtime: &str, command: Value) -> Result<Value> {
    if session.working() || !session.queue.is_empty() {
        return Err("Stop or pause the response and finish queued messages before branching or switching".into());
    }
    let state = session.execute(json!({"type":"get_state"})).await?;
    assert_current(host, session, runtime)?;
    if matches!(kind(&command), "fork" | "fork_after") {
        let path = state["sessionFile"]
            .as_str()
            .filter(|path| !path.is_empty())
            .ok_or("The conversation has no session file")?;
        return fork(host, session, runtime, command.clone(), &state, path).await;
    }
    let mut key = Uuid::new_v4().to_string();
    let flag = match kind(&command) {
        "new_session" => "--session-id",
        "switch_session" => "--session",
        _ => "--fork",
    };
    let value = match kind(&command) {
        "new_session" => key.clone(),
        "switch_session" => text(&command, "sessionPath"),
        _ => text(&state, "sessionFile"),
    };
    if value.is_empty() {
        return Err("The conversation has no session file".into());
    }
    let spec = session.spec.session(flag, &value);
    if kind(&command) == "switch_session" {
        key = spec.identity(&key)?;
    }
    let guard = if session.ephemeral {
        Guard::ephemeral()
    } else {
        host.ownership()
            .begin(
                &key,
                &session.client_id,
                &json!({"path":if kind(&command)=="switch_session"{Some(&value)}else{None},"create":kind(&command)!="switch_session"}),
            )
            .await?
    };
    if !guard.owned {
        {
            let mut registry = host.registry();
            let mut packet = registry
                .attachments
                .get(runtime)
                .map(|value| (**value).clone())
                .unwrap_or(json!({}));
            packet["spec"] = json!(spec);
            packet["sessionKey"] = json!(key);
            registry.attachments.insert(runtime.into(), Arc::new(packet));
            registry.readonly.insert(
                runtime.into(),
                ReadonlyView {
                    id: key,
                    path: Some(value),
                },
            );
        }
        session.publish(json!({"type":"ownership_lost"}), Some(runtime));
        host.services.detach_voice(runtime).await;
        host.registry().subscriptions.remove(runtime);
        session.detach(runtime, false, false).await;
        return Ok(json!({}));
    }
    let result = async {
        let next = if kind(&command) == "switch_session" {
            host.find_session(&key)
        } else {
            None
        };
        if next.as_ref().is_some_and(|next| next.transient()) {
            return Err("This conversation branch is still being prepared".into());
        }
        let created = next.is_none();
        let next = match next {
            Some(next) => next,
            None => host.spawn_session(
                key,
                spec,
                session.timeout,
                session.ephemeral,
                false,
                session.client_id.clone(),
                session.cwd.clone(),
            )?,
        };
        let result = transfer(host, session, &next, runtime).await;
        if result.is_err() && created && next.views().is_empty() && !next.submitted() && !next.working() {
            next.stop().await;
        }
        result
    }
    .await;
    let released = guard.release(host.ownership(), false);
    released?;
    result
}

fn assert_current(host: &Host, session: &Session, runtime: &str) -> Result<()> {
    if host.current(runtime, session) {
        Ok(())
    } else {
        Err("The conversation changed while preparing its destination".into())
    }
}

async fn transfer(host: &Arc<Host>, session: &Arc<Session>, next: &Arc<Session>, runtime: &str) -> Result<Value> {
    next.execute(json!({"type":"get_state"})).await?;
    assert_current(host, session, runtime)?;
    if next.closed() || next.stopping() {
        return Err("The destination conversation has stopped".into());
    }
    if !Arc::ptr_eq(session, next) {
        let presence = session
            .views()
            .into_iter()
            .find(|(id, _)| id == runtime)
            .map(|(_, value)| value)
            .unwrap_or(json!({}));
        session.detach_view(runtime);
        host.attach_view(runtime, next.clone(), presence);
        host.services.detach_voice(runtime).await;
        host.release_unused(session).await?;
    }
    host.reconcile(next.clone());
    host.remember(runtime, next);
    if host.current(runtime, next) {
        next.publish(json!({"type":"session_switched"}), Some(runtime));
    }
    Ok(json!({}))
}

async fn fork(host: &Arc<Host>, session: &Arc<Session>, runtime: &str, command: Value, state: &Value, path: &str) -> Result<Value> {
    let directory = std::env::temp_dir().join(format!("piop-branch-{}", Uuid::new_v4()));
    crate::ensure_private_dir(&directory)?;
    let mut worker: Option<Arc<Session>> = None;
    let mut next: Option<Arc<Session>> = None;
    let mut pending: Option<PathBuf> = None;
    let mut guard = None;
    let mut committed = false;
    let result = async {
        let mut spec = session.spec.session("--fork", path);
        spec.args.extend(["--session-dir".into(), directory.to_string_lossy().into_owned()]);
        let preparing = host.spawn_session(
            Uuid::new_v4().to_string(),
            spec,
            session.timeout,
            session.ephemeral,
            true,
            session.client_id.clone(),
            session.cwd.clone(),
        )?;
        worker = Some(preparing.clone());
        let initial = preparing.execute(json!({"type":"get_state"})).await?;
        let result = preparing.raw(command).await?;
        if result["cancelled"] == true {
            return Ok(result);
        }
        let branch = preparing.execute(json!({"type":"get_state"})).await?;
        preparing.stop().await;
        let branch_file = PathBuf::from(text(&branch, "sessionFile"));
        let branch_id = text(&branch, "sessionId");
        validate_branch(host, &branch_file, &branch_id, &initial, state, &directory)?;
        let destination = Path::new(path)
            .parent()
            .ok_or("Invalid conversation path")?
            .join(branch_file.file_name().ok_or("Invalid branch path")?);
        let pending_path = destination
            .parent()
            .ok_or("Invalid branch path")?
            .join(format!(".piop-branch-{}.pending", Uuid::new_v4()));
        let content = std::fs::read(&branch_file).map_err(|error| error.to_string())?;
        let newline = content
            .iter()
            .position(|byte| *byte == b'\n')
            .ok_or("The branch has no session header")?;
        let mut header: Value = serde_json::from_slice(&content[..newline]).map_err(|error| error.to_string())?;
        if header["type"] != "session" || header["id"] != branch_id {
            return Err("The branch has an invalid session identity".into());
        }
        header["parentSession"] = json!(path);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&pending_path).map_err(|error| error.to_string())?;
        pending = Some(pending_path.clone());
        writeln!(file, "{header}")
            .and_then(|_| file.write_all(&content[newline + 1..]))
            .map_err(|error| error.to_string())?;
        drop(file);
        std::fs::hard_link(&pending_path, &destination).map_err(|error| error.to_string())?;
        let ownership = if session.ephemeral {
            Guard::ephemeral()
        } else {
            host.ownership()
                .begin(&branch_id, &session.client_id, &json!({"path":destination}))
                .await?
        };
        let owned = ownership.owned;
        guard = Some(ownership);
        if !owned {
            return Err(ownership_error());
        }
        let destination = destination.to_string_lossy().into_owned();
        let opened = host.spawn_session(
            branch_id.clone(),
            session.spec.session("--session", &destination),
            session.timeout,
            session.ephemeral,
            true,
            session.client_id.clone(),
            session.cwd.clone(),
        )?;
        opened.set_reserved_path(Some(destination.clone()));
        next = Some(opened.clone());
        let actual = opened.execute(json!({"type":"get_state"})).await?;
        if actual["sessionId"] != branch_id || actual["sessionFile"] != destination {
            return Err("Pi did not open the prepared branch".into());
        }
        if !host.current(runtime, session) {
            return Err("The conversation changed while preparing its branch".into());
        }
        let presence = session
            .views()
            .into_iter()
            .find(|(id, _)| id == runtime)
            .map(|(_, presence)| presence)
            .unwrap_or(json!({}));
        session.detach_view(runtime);
        opened.set_reserved_path(None);
        opened.make_visible();
        host.attach_view(runtime, opened.clone(), presence);
        committed = true;
        host.remember(runtime, &opened);
        host.services.detach_voice(runtime).await;
        host.release_unused(session).await?;
        host.reconcile(opened.clone());
        if host.current(runtime, &opened) {
            opened.publish(json!({"type":"session_switched"}), Some(runtime));
        }
        Ok(result)
    }
    .await;
    let release = guard.map(|guard| guard.release(host.ownership(), false)).transpose();
    if let Some(worker) = &worker {
        worker.stop().await;
    }
    if !committed {
        if let Some(next) = &next {
            next.stop().await;
        }
    }
    let cleanup = cleanup_paths(pending.as_deref(), &directory);
    if let Some(worker) = &worker {
        host.forget_worker(worker);
    }
    if !committed {
        if let Some(next) = &next {
            host.forget_worker(next);
        }
    }
    release?;
    cleanup?;
    result
}

fn validate_branch(host: &Host, path: &Path, id: &str, initial: &Value, state: &Value, directory: &Path) -> Result<()> {
    let parent = path.parent().and_then(|parent| parent.canonicalize().ok());
    if parent != Some(directory.canonicalize().map_err(|error| error.to_string())?)
        || path.to_str() == initial["sessionFile"].as_str()
        || id.is_empty()
        || state["sessionId"] == id
        || host.registry().sessions.contains_key(id)
    {
        return Err("Pi did not create the requested branch".into());
    }
    Ok(())
}

fn cleanup_paths(pending: Option<&Path>, directory: &Path) -> Result<()> {
    let pending = if let Some(path) = pending {
        match std::fs::remove_file(path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
            _ => Ok(()),
        }
    } else {
        Ok(())
    };
    let directory = match std::fs::remove_dir_all(directory) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
        _ => Ok(()),
    };
    pending.and(directory)
}
