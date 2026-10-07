mod publication;
mod preparation;

use super::{
    controller::{Host, ReadonlyView},
    ownership::{ownership_error, Guard},
    protocol::{expand_home, kind, text, LaunchSpec, Result, SessionLaunch},
    session::Session,
};
use serde_json::{json, Value};
use std::{
    fs::OpenOptions,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};
use uuid::Uuid;

struct Destination {
    key: String,
    spec: LaunchSpec,
    path: String,
    existing: bool,
    cwd: Option<String>,
}

fn requires_idle_source(session: &Session, command: &Value) -> bool {
    !matches!(kind(command), "fork" | "fork_after") && (session.working() || !session.queue.is_empty())
}

pub(super) async fn switch(host: &Arc<Host>, session: &Arc<Session>, runtime: &str, command: Value) -> Result<Value> {
    if requires_idle_source(session, &command) {
        return Err("Stop or pause the response and finish queued messages before switching".into());
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
    let mut destination = destination(session, &command, &state)?;
    let guard = destination_ownership(host, session, &destination).await?;
    destination.resolve_cwd(host, &guard)?;
    if !guard.owned {
        return attach_readonly(host, session, runtime, destination).await;
    }
    let result = open_destination(host, session, runtime, destination).await;
    guard.release(host.ownership(), false).and(result)
}

fn destination(session: &Session, command: &Value, state: &Value) -> Result<Destination> {
    let mut key = Uuid::new_v4().to_string();
    let flag = match kind(command) {
        "new_session" => "--session-id",
        "switch_session" => "--session",
        _ => "--fork",
    };
    let value = match kind(command) {
        "new_session" => key.clone(),
        "switch_session" => text(command, "sessionPath"),
        _ => text(state, "sessionFile"),
    };
    if value.is_empty() {
        return Err("The conversation has no session file".into());
    }
    let spec = session.spec.session(flag, &value);
    if kind(command) == "switch_session" {
        key = spec.identity(&key)?;
    }
    Ok(Destination {
        key,
        spec,
        path: value,
        existing: kind(command) == "switch_session",
        cwd: session.cwd.clone(),
    })
}

impl Destination {
    fn resolve_cwd(&mut self, host: &Host, guard: &Guard) -> Result<()> {
        if !self.existing { return Ok(()); }
        let header = match &guard.saved {
            Some(saved) => saved.header.clone(),
            None => destination_header(&self.path)?,
        };
        if header["id"] != self.key { return Err("The destination conversation changed while switching".into()); }
        let cwd = header["cwd"].as_str().filter(|cwd| !cwd.trim().is_empty()).ok_or("The destination conversation has no working directory")?;
        let cwd = expand_home(cwd, &host.home).to_string_lossy().into_owned();
        if self.spec.env.contains_key("PIOP_REMOTE_SESSION_CLAIMS") {
            self.spec.env.insert("PIOP_SESSION_CWD".into(), cwd.clone());
        } else {
            self.spec.cwd = Some(cwd.clone());
        }
        self.cwd = Some(cwd);
        Ok(())
    }
}

fn destination_header(path: &str) -> Result<Value> {
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut header = String::new();
    BufReader::new(file).take(64 * 1024).read_line(&mut header).map_err(|error| error.to_string())?;
    serde_json::from_str(&header).map_err(|error| error.to_string())
}

async fn destination_ownership(host: &Host, session: &Session, destination: &Destination) -> Result<Guard> {
    if session.ephemeral {
        Ok(Guard::ephemeral())
    } else {
        host.ownership()
            .begin(
                &destination.key,
                &session.client_id(),
                &json!({"path":destination.existing.then_some(&destination.path),"create":!destination.existing}),
            )
            .await
    }
}

async fn attach_readonly(host: &Host, session: &Session, runtime: &str, destination: Destination) -> Result<Value> {
    {
        let mut registry = host.registry();
        let mut packet = registry
            .attachments
            .get(runtime)
            .map(|value| (**value).clone())
            .unwrap_or(json!({}));
        packet["spec"] = json!(destination.spec);
        packet["sessionKey"] = json!(destination.key);
        packet["cwd"] = json!(destination.cwd);
        registry.attachments.insert(runtime.into(), Arc::new(packet));
        registry.readonly.insert(
            runtime.into(),
            ReadonlyView {
                id: destination.key,
                path: Some(destination.path),
            },
        );
    }
    session.publish(json!({"type":"ownership_lost"}), Some(runtime));
    host.registry().subscriptions.remove(runtime);
    session.detach_view(runtime);
    session.finish_detach(false, false).await;
    host.release_unused(session).await?;
    Ok(json!({}))
}

async fn open_destination(host: &Arc<Host>, session: &Arc<Session>, runtime: &str, destination: Destination) -> Result<Value> {
    let next = if destination.existing {
        host.find_session(&destination.key)
    } else {
        None
    };
    if next.as_ref().is_some_and(|next| next.transient()) {
        return Err("This conversation branch is still being prepared".into());
    }
    let created = next.is_none();
    let next = match next {
        Some(next) => next,
        None => host.spawn_session(SessionLaunch {
            key: destination.key,
            spec: destination.spec,
            timeout: session.timeout,
            ephemeral: session.ephemeral,
            transient: false,
            client_id: session.client_id(),
            cwd: destination.cwd,
        })?,
    };
    let result = transfer(host, session, &next, runtime).await;
    if result.is_err() && created && unstarted(&next) {
        next.stop().await;
    }
    result
}

fn unstarted(session: &Session) -> bool {
    session.views().is_empty() && !session.submitted() && !session.working()
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
        finish_transfer(host, session).await?;
    }
    host.reconcile(next.clone());
    host.remember(runtime, next);
    if host.current(runtime, next) {
        next.publish(json!({"type":"session_switched"}), Some(runtime));
    }
    Ok(json!({}))
}

async fn finish_transfer(host: &Host, session: &Session) -> Result<()> {
    if session.ephemeral && session.views().is_empty() {
        session.stop().await;
    }
    host.release_unused(session).await
}

async fn fork(host: &Arc<Host>, session: &Arc<Session>, runtime: &str, command: Value, state: &Value, path: &str) -> Result<Value> {
    let (directory, preparation_lock) = preparation::create(host)?;
    let mut branch = Branch {
        host,
        session,
        runtime,
        state,
        path,
        directory,
        preparation_lock: Some(preparation_lock),
        worker: None,
        next: None,
        destination: None,
        guard: None,
        committed: false,
    };
    let result = branch.create(command).await;
    branch.cleanup().await?;
    result
}

struct Branch<'a> {
    host: &'a Arc<Host>,
    session: &'a Arc<Session>,
    runtime: &'a str,
    state: &'a Value,
    path: &'a str,
    directory: PathBuf,
    preparation_lock: Option<std::fs::File>,
    worker: Option<Arc<Session>>,
    next: Option<Arc<Session>>,
    destination: Option<PathBuf>,
    guard: Option<Guard>,
    committed: bool,
}

impl Branch<'_> {
    async fn create(&mut self, command: Value) -> Result<Value> {
        let preparing = self.spawn_preparing()?;
        self.worker = Some(preparing.clone());
        let initial = preparing.execute(json!({"type":"get_state"})).await?;
        let mut result = preparing.raw(command).await?;
        if result["cancelled"] == true {
            return Ok(result);
        }
        let branch = preparing.execute(json!({"type":"get_state"})).await?;
        preparing.stop().await;
        self.host.flush_capture(&self.session.key()).await?;
        let destination = self.persist(&branch, &initial)?;
        let opened = self.open(&branch, &destination).await?;
        self.commit(&opened).await?;
        result["state"] = branch;
        result["state"]["sessionFile"] = json!(destination);
        Ok(result)
    }

    fn spawn_preparing(&self) -> Result<Arc<Session>> {
        let source = self.snapshot_source()?;
        let mut spec = self.session.spec.session("--fork", &source.to_string_lossy());
        spec.env.insert("PIOP_FORK_PREPARATION_DIRECTORY".into(), self.directory.to_string_lossy().into_owned());
        spec.args
            .extend(["--session-dir".into(), self.directory.to_string_lossy().into_owned()]);
        self.spawn(Uuid::new_v4().to_string(), spec)
    }

    fn snapshot_source(&self) -> Result<PathBuf> {
        let source = std::fs::File::open(self.path).map_err(|error| error.to_string())?;
        let length = source.metadata().map_err(|error| error.to_string())?.len();
        let mut content = Vec::new();
        source.take(length).read_to_end(&mut content).map_err(|error| error.to_string())?;
        let end = content.iter().rposition(|byte| *byte == b'\n').ok_or("The conversation has no complete session header")?;
        let snapshot = self.directory.join("source.jsonl");
        private_file(&snapshot)?
            .write_all(&content[..=end])
            .map_err(|error| error.to_string())?;
        Ok(snapshot)
    }

    fn spawn(&self, key: String, spec: LaunchSpec) -> Result<Arc<Session>> {
        self.host.spawn_session(SessionLaunch {
            key,
            spec,
            timeout: self.session.timeout,
            ephemeral: self.session.ephemeral,
            transient: true,
            client_id: self.session.client_id(),
            cwd: self.session.cwd.clone(),
        })
    }

    fn persist(&mut self, branch: &Value, initial: &Value) -> Result<PathBuf> {
        let branch_file = PathBuf::from(text(branch, "sessionFile"));
        let branch_id = text(branch, "sessionId");
        validate_branch(self.host, &branch_file, &branch_id, initial, self.state, &self.directory)?;
        let destination = Path::new(self.path)
            .parent()
            .ok_or("Invalid conversation path")?
            .join(branch_file.file_name().ok_or("Invalid branch path")?);
        publication::publish(self.host, self.path, &branch_file, &branch_id, &destination, self.session.ephemeral)?;
        self.destination = Some(destination.clone());
        Ok(destination)
    }

    async fn open(&mut self, branch: &Value, destination: &Path) -> Result<Arc<Session>> {
        let branch_id = text(branch, "sessionId");
        let ownership = if self.session.ephemeral {
            Guard::ephemeral()
        } else {
            self.host
                .ownership()
                .begin(&branch_id, &self.session.client_id(), &json!({"path":destination}))
                .await?
        };
        let owned = ownership.owned;
        self.guard = Some(ownership);
        if !owned {
            return Err(ownership_error());
        }
        let destination = destination.to_string_lossy().into_owned();
        let opened = self.spawn(branch_id.clone(), self.session.spec.session("--session", &destination))?;
        opened.set_reserved_path(Some(destination.clone()));
        self.next = Some(opened.clone());
        let actual = opened.execute(json!({"type":"get_state"})).await?;
        if actual["sessionId"] != branch_id || actual["sessionFile"] != destination {
            return Err("Pi did not open the prepared branch".into());
        }
        Ok(opened)
    }

    async fn commit(&mut self, opened: &Arc<Session>) -> Result<()> {
        if !self.host.current(self.runtime, self.session) {
            return Err("The conversation changed while preparing its branch".into());
        }
        let presence = self
            .session
            .views()
            .into_iter()
            .find(|(id, _)| id == self.runtime)
            .map(|(_, presence)| presence)
            .unwrap_or(json!({}));
        self.session.detach_view(self.runtime);
        opened.set_reserved_path(None);
        opened.make_visible();
        self.host.attach_view(self.runtime, opened.clone(), presence);
        self.committed = true;
        self.host.remember(self.runtime, opened);
        self.session.finish_detach(false, true).await;
        self.host.release_unused(self.session).await?;
        self.host.reconcile(opened.clone());
        if self.host.current(self.runtime, opened) {
            opened.publish(json!({"type":"session_switched"}), Some(self.runtime));
        }
        Ok(())
    }

    async fn cleanup(&mut self) -> Result<()> {
        let workers: Vec<_> = self.worker.iter().chain(self.next.iter().filter(|_| !self.committed)).collect();
        for worker in &workers {
            worker.stop().await;
        }
        let destination = if !self.committed {
            self.destination.take().map(|path| publication::remove(self.host, &path, self.session.ephemeral)).transpose()
        } else {
            Ok(None)
        };
        self.preparation_lock.take();
        let cleanup = publication::recover(self.host);
        for worker in workers {
            self.host.forget_worker(worker);
        }
        if let Some(guard) = self.guard.take() {
            guard.release(self.host.ownership(), !self.committed)?;
        }
        destination?;
        cleanup
    }
}

fn private_file(path: &Path) -> Result<std::fs::File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(|error| error.to_string())
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
