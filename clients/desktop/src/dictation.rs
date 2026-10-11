//! Dictation on the desktop client: runs the speech engine chosen in the client preferences and saves speech models.
//! The engines are separately installed Python programs (transcribe.cpp or Cactus Needle). Each live dictation runs
//! the embedded worker script, which reads 16 kHz mono 16-bit audio on stdin and writes JSON lines on stdout.
use super::*;
use base64::Engine as _;
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Read as _, Write as _};
use std::process::{Child, ChildStdin};
use tokio::io::AsyncWriteExt;

const WORKER: &str = include_str!("../resources/dictation-worker.py");
const BYTES_PER_SECOND: usize = 16000 * 2;
const MAX_STREAM_BYTES: usize = BYTES_PER_SECOND * 120;
const MAX_FEED_BYTES: usize = BYTES_PER_SECOND * 5;
const MAX_LINE_BYTES: usize = 256 * 1024;
const MAX_ERROR_BYTES: usize = 4096;
const PROBE_TIMEOUT: Duration = Duration::from_secs(120);
const FINISH_TIMEOUT: Duration = Duration::from_secs(120);
const UNCONFIGURED: &str = "No dictation model is configured";

/// The dictation fields of the client preferences. Empty strings mean "not set".
#[derive(Clone, PartialEq)]
pub(crate) struct DictationSettings { pub engine: String, pub program: String, pub model: String, pub language: String }

/// A speech-to-text setup that can run: the Python command, the model file and the language ("" lets the model choose).
#[derive(Clone)]
struct Engine { kind: String, executable: String, interpreter: Vec<String>, model: String, language: String }

/// What a loaded model reports: the languages it knows and whether it can detect the language.
struct Languages { languages: Vec<String>, detect: bool }

/// A running worker process.
struct Worker { child: Arc<Mutex<Child>>, stdin: Mutex<Option<ChildStdin>> }

/// The one live dictation. A new dictation from any window replaces it.
struct Stream { id: String, window: String, worker: Arc<Worker>, bytes: usize, finishing: bool, done: Option<mpsc::Receiver<Result<String, String>>> }

struct State {
    settings: Option<DictationSettings>,
    generation: u64,
    engine: Option<Engine>,
    languages: Option<Languages>,
    error: Option<String>,
    loading: bool,
    stream: Option<Stream>,
}

/// One running model save. received counts the bytes written so far.
struct Download { received: u64, cancelled: Arc<AtomicBool> }

#[derive(Default)]
struct Models { downloads: HashMap<String, Download>, errors: HashMap<String, String> }

pub(crate) struct Dictation { state: Mutex<State>, models: Mutex<Models> }

impl Default for Dictation {
    fn default() -> Self {
        Self { state: Mutex::new(State { settings: None, generation: 0, engine: None, languages: None, error: None, loading: true, stream: None }), models: Mutex::default() }
    }
}

fn lock_state(app: &AppHandle) -> std::sync::MutexGuard<'_, State> {
    app.state::<Dictation>().inner().state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn configuration(state: &State) -> Value {
    let mut result = json!({ "enabled": state.engine.is_some(), "loading": state.loading });
    if let Some(engine) = &state.engine {
        result["engine"] = json!(engine.kind);
        result["executable"] = json!(engine.executable);
        result["language"] = json!(engine.language);
    }
    if let Some(languages) = &state.languages {
        result["languages"] = json!(languages.languages);
        result["detectLanguage"] = json!(languages.detect);
    }
    if let Some(error) = &state.error { result["error"] = json!(error); }
    result
}

fn publish(app: &AppHandle, state: &State) {
    if let Err(error) = app.emit("pi://dictation", configuration(state)) { eprintln!("Could not publish the dictation status: {error}"); }
}

fn stream_event(app: &AppHandle, window: &str, payload: Value) {
    if let Err(error) = app.emit_to(tauri::EventTarget::webview_window(window), "pi://dictation-stream", payload) { eprintln!("Could not send dictation text: {error}"); }
}

/// Must hold the state lock. Stops the live dictation and tells its window why.
fn close_stream(app: &AppHandle, state: &mut State, error: Option<&str>) {
    let Some(stream) = state.stream.take() else { return };
    stream.worker.kill();
    if let Some(error) = error { stream_event(app, &stream.window, json!({ "id": stream.id, "error": error })); }
}

/// Loads the engine for these settings when they changed.
pub(crate) fn reload(app: &AppHandle, settings: DictationSettings) {
    let generation = {
        let mut state = lock_state(app);
        if state.settings.as_ref() == Some(&settings) { return; }
        state.settings = Some(settings.clone());
        state.generation += 1;
        close_stream(app, &mut state, Some("Dictation stopped because the speech engine changed"));
        state.engine = None;
        state.languages = None;
        state.error = None;
        state.loading = true;
        publish(app, &state);
        state.generation
    };
    let app = app.clone();
    thread::spawn(move || {
        let loaded = load_engine(&settings);
        let mut state = lock_state(&app);
        if state.generation != generation { return; }
        state.loading = false;
        match loaded {
            Ok((engine, languages)) => { state.engine = Some(engine); state.languages = Some(languages); }
            Err(error) => {
                if error != UNCONFIGURED { eprintln!("Dictation is unavailable: {error}"); }
                state.error = Some(error);
            }
        }
        publish(&app, &state);
    });
}

/// Stops the dictation of a closed window.
pub(crate) fn close_window(app: &AppHandle, window: &str) {
    let mut state = lock_state(app);
    if state.stream.as_ref().is_some_and(|stream| stream.window == window) { close_stream(app, &mut state, None); }
}

fn expand(path: &str) -> String {
    let trimmed = path.trim();
    match (trimmed.strip_prefix("~/"), home_dir()) {
        (Some(rest), Ok(home)) => home.join(rest).to_string_lossy().into_owned(),
        _ => trimmed.to_owned(),
    }
}

fn program_name(kind: &str) -> &'static str {
    if kind == "needle" { "needle (pip install cactus-needle)" } else { "transcribe.cpp (pip install transcribe-cpp)" }
}

fn candidates(kind: &str, configured: &str) -> Vec<String> {
    let mut paths: Vec<PathBuf> = Vec::new();
    if !configured.is_empty() { paths.push(PathBuf::from(expand(configured))); } else {
        let mut directories: Vec<PathBuf> = std::env::var_os("PATH").map(|value| std::env::split_paths(&value).collect()).unwrap_or_default();
        if let Ok(home) = home_dir() {
            directories.push(home.join(".local/bin"));
            if kind != "needle" { paths.push(home.join(".local/share/transcribe-cpp/venv/bin/python")); }
        }
        directories.push(PathBuf::from("/usr/local/bin"));
        for directory in directories { paths.push(directory.join(if kind == "needle" { "needle" } else { "python3" })); }
    }
    let mut seen = std::collections::HashSet::new();
    paths.into_iter().filter(|path| path.is_file() && fs::canonicalize(path).is_ok_and(|real| seen.insert(real))).map(|path| path.to_string_lossy().into_owned()).collect()
}

/// The Python command. For Needle, it is the interpreter named in the needle script's first line.
fn interpreter(kind: &str, executable: &str) -> Result<Vec<String>, String> {
    if kind != "needle" { return Ok(vec![executable.to_owned()]); }
    let content = fs::read(executable).map_err(|_| "Could not read the needle program")?;
    let first = String::from_utf8_lossy(content.split(|byte| *byte == b'\n').next().unwrap_or_default()).into_owned();
    let line = first.strip_prefix("#!").ok_or("The needle program is not a Python script")?;
    let parts: Vec<String> = line.split_whitespace().map(str::to_owned).collect();
    let command = if parts.first().is_some_and(|part| part.ends_with("/env")) { parts[1..].to_vec() } else { parts };
    let python = command.first().and_then(|program| Path::new(program).file_name()).map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    if !python.starts_with("python") || !python[6..].chars().all(|c| c.is_ascii_digit() || c == '.') { return Err("The needle program does not name a Python interpreter".into()); }
    Ok(command)
}

fn load_engine(settings: &DictationSettings) -> Result<(Engine, Languages), String> {
    if settings.model.is_empty() { return Err(UNCONFIGURED.into()); }
    let model = expand(&settings.model);
    if !Path::new(&model).is_file() { return Err(format!("The model file {model} does not exist")); }
    let executables = candidates(&settings.engine, &settings.program);
    if executables.is_empty() {
        return Err(if settings.program.is_empty() { format!("Could not find {}. Install it or set its path.", program_name(&settings.engine)) } else { format!("The program {} does not exist", expand(&settings.program)) });
    }
    let mut failures = Vec::new();
    for executable in executables {
        let attempt = interpreter(&settings.engine, &executable).and_then(|interpreter| {
            let engine = Engine { kind: settings.engine.clone(), executable: executable.clone(), interpreter, model: model.clone(), language: settings.language.clone() };
            probe(&engine).map(|languages| (engine, languages))
        });
        match attempt { Ok(loaded) => return Ok(loaded), Err(error) => failures.push(format!("{executable}: {error}")) }
    }
    Err(failures.join("\n"))
}

/// Runs one second of silence through the engine to prove that the program, the model and the language load.
fn probe(engine: &Engine) -> Result<Languages, String> {
    let (ready_sender, ready) = mpsc::channel();
    let (done_sender, done) = mpsc::channel();
    let worker = spawn_worker(engine, Box::new(|_, _| {}), Box::new(move |languages| { let _ = ready_sender.send(languages); }), Box::new(move |result| { let _ = done_sender.send(result); }))?;
    worker.write(&vec![0; BYTES_PER_SECOND])?;
    worker.end();
    wait(&worker, &done, PROBE_TIMEOUT, "The speech engine did not start in time")?;
    ready.try_recv().map_err(|_| "The speech engine did not report its languages".to_string())
}

fn wait(worker: &Worker, done: &mpsc::Receiver<Result<String, String>>, timeout: Duration, message: &str) -> Result<String, String> {
    match done.recv_timeout(timeout) {
        Ok(result) => result,
        Err(_) => { worker.kill(); Err(message.into()) }
    }
}

impl Worker {
    fn write(&self, audio: &[u8]) -> Result<(), String> {
        let mut stdin = self.stdin.lock().map_err(|_| "The speech engine is unavailable")?;
        let pipe = stdin.as_mut().ok_or("The speech engine input is closed")?;
        pipe.write_all(audio).map_err(|error| format!("Could not send audio to the speech engine: {error}"))
    }
    fn end(&self) { if let Ok(mut stdin) = self.stdin.lock() { stdin.take(); } }
    fn kill(&self) { if let Ok(mut child) = self.child.lock() { let _ = child.kill(); } }
}

fn last_line(text: &str) -> Option<&str> { text.lines().map(str::trim).filter(|line| !line.is_empty()).last() }

type TextHandler = Box<dyn Fn(String, String) + Send>;
type ReadyHandler = Box<dyn FnOnce(Languages) + Send>;
type DoneHandler = Box<dyn FnOnce(Result<String, String>) + Send>;

fn spawn_worker(engine: &Engine, on_text: TextHandler, on_ready: ReadyHandler, on_done: DoneHandler) -> Result<Worker, String> {
    let (program, prefix) = engine.interpreter.split_first().ok_or("No Python interpreter")?;
    let mut child = Command::new(program).args(prefix).arg("-c").arg(WORKER).arg(&engine.kind).arg(&engine.model).arg(&engine.language)
        .env("NEEDLE_TELEMETRY", "0").env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
        .map_err(|error| format!("Could not start the speech engine: {error}"))?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().ok_or("The speech engine has no output")?;
    let mut stderr = child.stderr.take().ok_or("The speech engine has no error output")?;
    let child = Arc::new(Mutex::new(child));
    let errors = thread::spawn(move || {
        let mut text = Vec::new();
        let mut buffer = [0u8; 4096];
        while let Ok(count) = stderr.read(&mut buffer) {
            if count == 0 { break; }
            text.extend_from_slice(&buffer[..count]);
            if text.len() > MAX_ERROR_BYTES { text.drain(..text.len() - MAX_ERROR_BYTES); }
        }
        String::from_utf8_lossy(&text).into_owned()
    });
    let process = child.clone();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut on_ready = Some(on_ready);
        let mut final_text: Option<String> = None;
        let mut protocol_error: Option<&str> = None;
        let mut line = Vec::new();
        loop {
            line.clear();
            match (&mut reader).take(MAX_LINE_BYTES as u64 + 1).read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            if line.len() > MAX_LINE_BYTES { protocol_error = Some("The speech engine sent too much text"); break; }
            let Ok(message) = serde_json::from_slice::<Value>(&line) else { protocol_error = Some("The speech engine sent invalid output"); break; };
            match message["type"].as_str() {
                Some("text") => if let (Some(committed), Some(tentative)) = (message["committed"].as_str(), message["tentative"].as_str()) { on_text(committed.to_owned(), tentative.to_owned()); },
                Some("ready") => if let (Some(languages), Some(detect)) = (message["languages"].as_array(), message["detect"].as_bool()) {
                    let languages: Option<Vec<String>> = languages.iter().map(|item| item.as_str().map(str::to_owned)).collect();
                    if let (Some(languages), Some(handler)) = (languages, on_ready.take()) { handler(Languages { languages, detect }); }
                },
                Some("final") => if let Some(text) = message["text"].as_str() { final_text = Some(text.trim().to_owned()); },
                _ => {}
            }
        }
        if protocol_error.is_some() { if let Ok(mut child) = process.lock() { let _ = child.kill(); } }
        let stderr = errors.join().unwrap_or_default();
        let status = process.lock().map_err(|_| ()).and_then(|mut child| child.wait().map_err(|_| ()));
        let result = match (protocol_error, status, final_text) {
            (Some(error), _, _) => Err(error.to_owned()),
            (None, Ok(status), Some(text)) if status.success() => Ok(text),
            (None, status, _) => Err(match last_line(&stderr) {
                Some(line) => format!("The speech engine failed: {line}"),
                None => format!("The speech engine failed with {}", status.map(|status| status.to_string()).unwrap_or_else(|_| "an unknown status".into())),
            }),
        };
        on_done(result);
    });
    Ok(Worker { child, stdin: Mutex::new(stdin) })
}

fn new_id() -> String { Uuid::new_v4().to_string() }

#[tauri::command(async)]
pub(crate) fn dictation_configuration(app: AppHandle) -> Value { configuration(&lock_state(&app)) }

/// Starts a live dictation. Text changes arrive as pi://dictation-stream events with this id.
#[tauri::command(async)]
pub(crate) fn dictation_stream_start(app: AppHandle, window: tauri::WebviewWindow) -> Result<Value, String> {
    let mut state = lock_state(&app);
    let engine = match (&state.engine, &state.error) {
        (Some(engine), _) => engine.clone(),
        (None, Some(error)) => return Err(format!("Dictation is unavailable: {error}")),
        (None, None) => return Err("Dictation is unavailable".into()),
    };
    close_stream(&app, &mut state, Some("Dictation stopped because a new dictation started"));
    let id = new_id();
    let label = window.label().to_owned();
    let (done_sender, done) = mpsc::channel();
    let text_app = app.clone();
    let (text_id, text_window) = (id.clone(), label.clone());
    let done_app = app.clone();
    let done_id = id.clone();
    let worker = spawn_worker(&engine,
        Box::new(move |committed, tentative| stream_event(&text_app, &text_window, json!({ "id": text_id, "committed": committed, "tentative": tentative }))),
        Box::new(|_| {}),
        Box::new(move |result| {
            if let Err(error) = &result {
                let mut state = lock_state(&done_app);
                if state.stream.as_ref().is_some_and(|stream| stream.id == done_id && !stream.finishing) { close_stream(&done_app, &mut state, Some(error)); }
            }
            let _ = done_sender.send(result);
        }))?;
    state.stream = Some(Stream { id: id.clone(), window: label, worker: Arc::new(worker), bytes: 0, finishing: false, done: Some(done) });
    Ok(json!({ "id": id }))
}

fn owned<'a>(state: &'a mut State, window: &str, id: &str) -> Result<&'a mut Stream, String> {
    state.stream.as_mut().filter(|stream| stream.id == id && stream.window == window).ok_or_else(|| "This dictation is no longer running".into())
}

#[tauri::command(async)]
pub(crate) fn dictation_stream_feed(app: AppHandle, window: tauri::WebviewWindow, id: String, audio: String) -> Result<(), String> {
    if audio.len() > MAX_FEED_BYTES.div_ceil(3) * 4 { return Err("Invalid dictation audio".into()); }
    let bytes = base64::engine::general_purpose::STANDARD.decode(audio).map_err(|_| "Invalid dictation audio")?;
    if bytes.len() % 2 != 0 { return Err("Invalid dictation audio".into()); }
    let worker = {
        let mut state = lock_state(&app);
        let stream = owned(&mut state, window.label(), &id)?;
        if stream.finishing { return Err("This dictation is already finishing".into()); }
        if stream.bytes + bytes.len() > MAX_STREAM_BYTES { return Err("Dictation recording is too long".into()); }
        stream.bytes += bytes.len();
        stream.worker.clone()
    };
    worker.write(&bytes)
}

#[tauri::command(async)]
pub(crate) fn dictation_stream_finish(app: AppHandle, window: tauri::WebviewWindow, id: String) -> Result<Value, String> {
    let (worker, done) = {
        let mut state = lock_state(&app);
        let stream = owned(&mut state, window.label(), &id)?;
        if stream.finishing { return Err("This dictation is already finishing".into()); }
        stream.finishing = true;
        (stream.worker.clone(), stream.done.take().ok_or("This dictation is already finishing")?)
    };
    worker.end();
    let result = wait(&worker, &done, FINISH_TIMEOUT, "The speech engine did not finish in time");
    let mut state = lock_state(&app);
    if state.stream.as_ref().is_some_and(|stream| stream.id == id) { close_stream(&app, &mut state, None); }
    result.map(|text| json!({ "text": text }))
}

#[tauri::command(async)]
pub(crate) fn dictation_stream_cancel(app: AppHandle, window: tauri::WebviewWindow, id: String) {
    let mut state = lock_state(&app);
    if owned(&mut state, window.label(), &id).is_ok() { close_stream(&app, &mut state, None); }
}

/// The directory for saved speech models. Debug and release builds share it, so a large model is saved once.
fn models_directory() -> Result<PathBuf, String> {
    let data = std::env::var_os("XDG_DATA_HOME").filter(|value| !value.is_empty()).map(PathBuf::from).map_or_else(|| home_dir().map(|home| home.join(".local/share")), Ok)?;
    Ok(data.join("piop/models/speech"))
}

fn models_state(app: &AppHandle) -> Result<Value, String> {
    let directory = models_directory()?;
    let models = app.state::<Dictation>().inner().models.lock().map_err(|_| "Speech models are unavailable")?;
    let mut items = Vec::new();
    let mut saved: Vec<String> = match fs::read_dir(&directory) {
        Ok(entries) => entries.filter_map(Result::ok).filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .map(|entry| entry.file_name().to_string_lossy().into_owned()).filter(|name| !name.ends_with(".part") && !models.downloads.contains_key(name)).collect(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(format!("Could not read {}: {error}", directory.display())),
    };
    saved.sort();
    for file in saved { items.push(json!({ "file": file, "saved": true })); }
    for (file, download) in &models.downloads { items.push(json!({ "file": file, "saved": false, "received": download.received })); }
    for (file, error) in &models.errors { items.push(json!({ "file": file, "saved": false, "error": error })); }
    Ok(json!({ "directory": directory.to_string_lossy(), "items": items }))
}

fn publish_models(app: &AppHandle) {
    match models_state(app) {
        Ok(models) => if let Err(error) = app.emit("pi://dictation-models", models) { eprintln!("Could not publish the speech models: {error}"); },
        Err(error) => eprintln!("Could not read the speech models: {error}"),
    }
}

fn model_file(file: &str) -> Result<(), String> {
    let valid = file.chars().next().is_some_and(|first| first.is_ascii_alphanumeric()) && file.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) && !file.ends_with(".part");
    if valid { Ok(()) } else { Err("Invalid model file name".into()) }
}

#[tauri::command(async)]
pub(crate) fn dictation_models(app: AppHandle) -> Result<Value, String> { models_state(&app) }

#[tauri::command(async)]
pub(crate) fn dictation_model_save(app: AppHandle, file: String, url: String, size: u64, sha256: String) -> Result<(), String> {
    model_file(&file)?;
    let sha256 = sha256.to_ascii_lowercase();
    if !url.starts_with("https://") || sha256.len() != 64 || !sha256.chars().all(|c| c.is_ascii_hexdigit()) || size == 0 { return Err("Invalid model download".into()); }
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut models = app.state::<Dictation>().inner().models.lock().map_err(|_| "Speech models are unavailable")?;
        if models.downloads.contains_key(&file) { return Err("This model is already being saved".into()); }
        models.errors.remove(&file);
        models.downloads.insert(file.clone(), Download { received: 0, cancelled: cancelled.clone() });
    }
    publish_models(&app);
    tauri::async_runtime::spawn(async move {
        let directory = models_directory();
        let result = match &directory {
            Ok(directory) => save_model(&app, &file, &url, size, &sha256, directory, &cancelled).await,
            Err(error) => Err(error.clone()),
        };
        let mut error = if cancelled.load(Ordering::SeqCst) { None } else { result.err() };
        if let Ok(directory) = &directory {
            let part = directory.join(format!("{file}.part"));
            if part.exists() { if let Err(failure) = fs::remove_file(&part) { error.get_or_insert(format!("Could not remove {}: {failure}", part.display())); } }
        }
        if let Ok(mut models) = app.state::<Dictation>().inner().models.lock() {
            models.downloads.remove(&file);
            if let Some(error) = error { models.errors.insert(file, error); }
        }
        publish_models(&app);
    });
    Ok(())
}

async fn save_model(app: &AppHandle, file: &str, url: &str, size: u64, sha256: &str, directory: &Path, cancelled: &AtomicBool) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|error| format!("Could not create {}: {error}", directory.display()))?;
    let part = directory.join(format!("{file}.part"));
    let mut response = reqwest::get(url).await.map_err(|error| format!("The download failed: {error}"))?;
    if !response.status().is_success() { return Err(format!("The download failed with HTTP {}", response.status())); }
    let mut output = tokio::fs::File::create(&part).await.map_err(|error| format!("Could not write {}: {error}", part.display()))?;
    let mut digest = Sha256::new();
    let (mut received, mut shown) = (0u64, u64::MAX);
    while let Some(chunk) = response.chunk().await.map_err(|error| format!("The download failed: {error}"))? {
        if cancelled.load(Ordering::SeqCst) { return Err("Cancelled".into()); }
        received += chunk.len() as u64;
        if received > size { return Err("The download is larger than expected".into()); }
        digest.update(&chunk);
        output.write_all(&chunk).await.map_err(|error| format!("Could not write {}: {error}", part.display()))?;
        let percent = received * 100 / size;
        if percent != shown {
            shown = percent;
            if let Ok(mut models) = app.state::<Dictation>().inner().models.lock() { if let Some(download) = models.downloads.get_mut(file) { download.received = received; } }
            publish_models(app);
        }
    }
    output.sync_all().await.map_err(|error| format!("Could not write {}: {error}", part.display()))?;
    if received != size { return Err("The download is incomplete".into()); }
    let actual: String = digest.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
    if actual != sha256 { return Err("The download does not match its checksum".into()); }
    let target = directory.join(file);
    fs::rename(&part, &target).map_err(|error| format!("Could not save {}: {error}", target.display()))
}

#[tauri::command(async)]
pub(crate) fn dictation_model_cancel(app: AppHandle, file: String) -> Result<(), String> {
    model_file(&file)?;
    let models = app.state::<Dictation>().inner().models.lock().map_err(|_| "Speech models are unavailable")?;
    if let Some(download) = models.downloads.get(&file) { download.cancelled.store(true, Ordering::SeqCst); }
    Ok(())
}

#[tauri::command(async)]
pub(crate) fn dictation_model_remove(app: AppHandle, file: String) -> Result<(), String> {
    model_file(&file)?;
    {
        let mut models = app.state::<Dictation>().inner().models.lock().map_err(|_| "Speech models are unavailable")?;
        if models.downloads.contains_key(&file) { return Err("Stop saving this model first".into()); }
        models.errors.remove(&file);
    }
    let target = models_directory()?.join(&file);
    match fs::remove_file(&target) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Could not remove {}: {error}", target.display())),
    }
    publish_models(&app);
    Ok(())
}
