//! Dictation on the desktop client: runs the speech engine chosen in the client preferences.
//! The engines are separately installed Python programs (transcribe.cpp or Cactus Needle). Each live dictation runs
//! the embedded worker script, which reads 16 kHz mono 16-bit audio on stdin and writes JSON lines on stdout.
use super::*;
use base64::Engine as _;
use std::io::{BufRead, BufReader, Read as _, Write as _};
use std::process::{Child, ChildStdin};

const WORKER: &str = include_str!("../resources/dictation-worker.py");
const BYTES_PER_SECOND: usize = 16000 * 2;
const MAX_STREAM_BYTES: usize = BYTES_PER_SECOND * 120;
const MAX_FEED_BYTES: usize = BYTES_PER_SECOND * 5;
const MAX_LINE_BYTES: usize = 256 * 1024;
const MAX_ERROR_BYTES: usize = 4096;
const PROBE_TIMEOUT: Duration = Duration::from_secs(120);
const FINISH_TIMEOUT: Duration = Duration::from_secs(120);
const IDLE_TIMEOUT: Duration = Duration::from_secs(15);
const UNCONFIGURED: &str = "No dictation model is configured";

/// The dictation fields of the client preferences. Empty strings mean "not set".
/// The model file names the engine type; args holds engine options such as "--language en".
#[derive(Clone, PartialEq)]
pub(crate) struct DictationSettings { pub program: String, pub model: String, pub args: String }

/// A speech-to-text setup that can run: the Python command, the model file and the language ("" lets the model choose).
#[derive(Clone)]
struct Engine { kind: String, executable: String, interpreter: Vec<String>, model: String, language: String }

/// What a loaded model reports: the languages it knows and whether it can detect the language.
struct Languages { languages: Vec<String>, detect: bool }

/// A running worker process.
struct Worker { child: Arc<Mutex<Child>>, stdin: Mutex<Option<ChildStdin>> }

/// The one live dictation. A new dictation from any window replaces it. idle closes it when no audio arrives for IDLE_TIMEOUT.
struct Stream { id: String, window: String, worker: Arc<Worker>, bytes: usize, finishing: bool, done: Option<mpsc::Receiver<Result<String, String>>>, idle: Option<tauri::async_runtime::JoinHandle<()>> }

struct State {
    settings: Option<DictationSettings>,
    generation: u64,
    engine: Option<Engine>,
    languages: Option<Languages>,
    error: Option<String>,
    loading: bool,
    stream: Option<Stream>,
}

pub(crate) struct Dictation { state: Mutex<State> }

impl Default for Dictation {
    fn default() -> Self {
        Self { state: Mutex::new(State { settings: None, generation: 0, engine: None, languages: None, error: None, loading: true, stream: None }) }
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
    let Some(mut stream) = state.stream.take() else { return };
    if let Some(idle) = stream.idle.take() { idle.abort(); }
    stream.worker.kill();
    if let Some(error) = error { stream_event(app, &stream.window, json!({ "id": stream.id, "error": error })); }
}

/// Restarts the wait for the next audio of this stream.
fn arm_idle(app: &AppHandle, stream: &mut Stream) {
    if let Some(idle) = stream.idle.take() { idle.abort(); }
    let (app, id) = (app.clone(), stream.id.clone());
    stream.idle = Some(tauri::async_runtime::spawn(async move {
        tokio::time::sleep(IDLE_TIMEOUT).await;
        let mut state = lock_state(&app);
        if state.stream.as_ref().is_some_and(|stream| stream.id == id && !stream.finishing) {
            close_stream(&app, &mut state, Some(&format!("Dictation stopped because no audio arrived for {} seconds", IDLE_TIMEOUT.as_secs())));
        }
    }));
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

/// The engine type of a model file: Cactus Needle reads .cact files and transcribe.cpp reads .gguf files.
fn engine_kind(model: &str) -> Result<&'static str, String> {
    match Path::new(model).extension().map(|extension| extension.to_string_lossy().to_lowercase()).as_deref() {
        Some("cact") => Ok("needle"),
        Some("gguf") => Ok("transcribe.cpp"),
        _ => Err(format!("Cannot tell the engine from the model file {model}. Use a .cact file (Cactus Needle) or a .gguf file (transcribe.cpp).")),
    }
}

/// Reads the engine arguments. The only argument is "--language <code>" (or "--language=<code>"); no language lets the model choose.
fn language_argument(args: &str) -> Result<String, String> {
    let mut words = args.split_whitespace();
    let mut language = String::new();
    while let Some(word) = words.next() {
        let value = match word.strip_prefix("--language") {
            Some("") => words.next().ok_or("The argument --language needs a language code, for example --language en")?.to_owned(),
            Some(rest) if rest.starts_with('=') => rest[1..].to_owned(),
            _ => return Err(format!("Unknown dictation argument {word}. The only argument is --language <code>.")),
        };
        language = value.to_lowercase();
    }
    Ok(language)
}

fn load_engine(settings: &DictationSettings) -> Result<(Engine, Languages), String> {
    if settings.model.is_empty() { return Err(UNCONFIGURED.into()); }
    let model = expand(&settings.model);
    if !Path::new(&model).is_file() { return Err(format!("The model file {model} does not exist")); }
    let kind = engine_kind(&model)?;
    let language = language_argument(&settings.args)?;
    let executables = candidates(kind, &settings.program);
    if executables.is_empty() {
        return Err(if settings.program.is_empty() { format!("Could not find {}. Install it or set its path.", program_name(kind)) } else { format!("The program {} does not exist", expand(&settings.program)) });
    }
    let mut failures = Vec::new();
    for executable in executables {
        let attempt = interpreter(kind, &executable).and_then(|interpreter| {
            let engine = Engine { kind: kind.to_owned(), executable: executable.clone(), interpreter, model: model.clone(), language: language.clone() };
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
    let mut stream = Stream { id: id.clone(), window: label, worker: Arc::new(worker), bytes: 0, finishing: false, done: Some(done), idle: None };
    arm_idle(&app, &mut stream);
    state.stream = Some(stream);
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
        let worker = stream.worker.clone();
        arm_idle(&app, stream);
        worker
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
        if let Some(idle) = stream.idle.take() { idle.abort(); }
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
