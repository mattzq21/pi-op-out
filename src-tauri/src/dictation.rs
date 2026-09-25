use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use tokio::process::Command as AsyncCommand;

const MAX_AUDIO_BYTES: usize = 44 + 16000 * 2 * 120;
const MAX_TEXT_BYTES: u64 = 256 * 1024;

#[derive(Clone)]
struct Engine {
    executable: PathBuf,
    model: PathBuf,
}

pub(crate) struct DictationRuntime {
    engine: Mutex<Option<Engine>>,
    loading: AtomicBool,
    busy: tokio::sync::Semaphore,
}

impl Default for DictationRuntime {
    fn default() -> Self {
        Self { engine: Mutex::new(None), loading: AtomicBool::new(true), busy: tokio::sync::Semaphore::new(1) }
    }
}

pub(crate) fn configuration(app: &AppHandle) -> Value {
    let runtime = app.state::<DictationRuntime>();
    json!({"enabled": runtime.engine.lock().is_ok_and(|engine| engine.is_some()), "loading": runtime.loading.load(Ordering::Acquire)})
}

fn publish(app: &AppHandle) {
    let _ = app.emit("pi://dictation", configuration(app));
}

pub(crate) fn start(app: AppHandle) {
    tokio::spawn(async move {
        let found = tokio::task::spawn_blocking(candidates).await;
        if let Ok(Ok((executables, models))) = found {
            'search: for executable in executables {
                for model in &models {
                    let engine = Engine { executable: executable.clone(), model: model.clone() };
                    if transcribe(&engine, &silent_wav(), Duration::from_secs(90)).await.is_ok() {
                        if let Ok(mut current) = app.state::<DictationRuntime>().engine.lock() { *current = Some(engine); }
                        break 'search;
                    }
                }
            }
        }
        app.state::<DictationRuntime>().loading.store(false, Ordering::Release);
        publish(&app);
    });
}

fn candidates() -> Result<(Vec<PathBuf>, Vec<PathBuf>), String> {
    let home = home_dir()?;
    let name = format!("transcribe-cli{}", std::env::consts::EXE_SUFFIX);
    let mut executables = Vec::new();
    let mut directories: Vec<PathBuf> = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
    directories.extend([home.join(".local/bin"), PathBuf::from("/usr/local/bin")]);
    for directory in directories { executables.push(directory.join(&name)); }
    for root in [home.join("Applications/transcribe.cpp"), home.join("transcribe.cpp"), home.join("src/transcribe.cpp")] {
        for build in ["build", "build-cuda", "build-vulkan", "build-metal", "build-release"] {
            executables.push(root.join(build).join("bin").join(&name));
            executables.push(root.join(build).join("bin/Release").join(&name));
        }
    }
    let mut seen = HashSet::new();
    executables.retain(|path| path.is_file() && path.canonicalize().is_ok_and(|path| seen.insert(path)));
    if executables.is_empty() { return Ok((executables, Vec::new())); }
    let mut models: Vec<_> = WalkDir::new(home.join("Models/STT")).follow_links(true).max_depth(8).into_iter().filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && entry.path().extension().and_then(|ext| ext.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("gguf") || ext.eq_ignore_ascii_case("bin")))
        .filter_map(|entry| entry.metadata().ok().map(|metadata| (metadata.len(), entry.into_path())))
        .filter(|(size, _)| *size > 0).collect();
    models.sort();
    Ok((executables, models.into_iter().map(|(_, path)| path).collect()))
}

struct AudioFiles(PathBuf);
impl Drop for AudioFiles {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

fn prepare_audio_files() -> Result<AudioFiles, String> {
    let directory = std::env::temp_dir().join(format!("piop-dictation-{}", Uuid::new_v4()));
    fs::create_dir(&directory).map_err(|_| "Could not prepare dictation audio")?;
    let files = AudioFiles(directory);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&files.0, fs::Permissions::from_mode(0o700)).map_err(|_| "Could not protect dictation audio")?;
    }
    Ok(files)
}

fn read_transcript(output: &Path) -> Result<String, String> {
    let size = fs::metadata(output).map_err(|_| "Dictation returned no transcript")?.len();
    if size > MAX_TEXT_BYTES { return Err("Dictation returned too much text".into()); }
    fs::read_to_string(output).map(|text| text.trim().to_owned()).map_err(|_| "Could not read the transcript".into())
}

async fn transcribe(engine: &Engine, wav: &[u8], timeout: Duration) -> Result<String, String> {
    let files = prepare_audio_files()?;
    let audio = files.0.join("audio.wav");
    let output = files.0.join("transcript.txt");
    fs::write(&audio, wav).map_err(|_| "Could not write dictation audio")?;
    let mut child = AsyncCommand::new(&engine.executable).arg("--model").arg(&engine.model)
        .arg("--quiet").arg("--output").arg(&output).arg(&audio)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true)
        .spawn().map_err(|_| "Could not start dictation")?;
    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(result) => result.map_err(|_| "Dictation stopped unexpectedly")?,
        Err(_) => { let _ = child.kill().await; return Err("Dictation timed out".into()); }
    };
    if !status.success() { return Err("The speech model could not transcribe this recording".into()); }
    read_transcript(&output)
}

fn silent_wav() -> Vec<u8> {
    let size = 16000u32 * 2;
    let mut wav = Vec::with_capacity(size as usize + 44);
    wav.extend_from_slice(b"RIFF"); wav.extend_from_slice(&(size + 36).to_le_bytes()); wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes()); wav.extend_from_slice(&1u16.to_le_bytes()); wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&16000u32.to_le_bytes()); wav.extend_from_slice(&32000u32.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes()); wav.extend_from_slice(&16u16.to_le_bytes()); wav.extend_from_slice(b"data");
    wav.extend_from_slice(&size.to_le_bytes()); wav.resize(size as usize + 44, 0); wav
}

fn validate_wav(wav: &[u8]) -> Result<(), String> {
    if wav.len() < 46 || wav.len() > MAX_AUDIO_BYTES || wav.len() % 2 != 0 { return Err("Invalid dictation recording length".into()); }
    let header = silent_wav();
    if wav[..4] != header[..4] || wav[8..40] != header[8..40]
        || u32::from_le_bytes(wav[4..8].try_into().unwrap()) as usize != wav.len() - 8
        || u32::from_le_bytes(wav[40..44].try_into().unwrap()) as usize != wav.len() - 44 {
        return Err("Dictation requires 16 kHz mono PCM audio".into());
    }
    Ok(())
}

pub(crate) async fn dictate(app: AppHandle, audio: String) -> Result<Value, String> {
    if audio.len() > MAX_AUDIO_BYTES.div_ceil(3) * 4 { return Err("Dictation recording is too long".into()); }
    let wav = STANDARD.decode(audio).map_err(|_| "Invalid dictation audio")?;
    validate_wav(&wav)?;
    let runtime = app.state::<DictationRuntime>();
    let _permit = runtime.busy.try_acquire().map_err(|_| "Dictation is busy. Try again shortly.")?;
    let engine = runtime.engine.lock().map_err(|_| "Dictation is unavailable")?.clone().ok_or("Dictation is unavailable")?;
    transcribe(&engine, &wav, Duration::from_secs(180)).await.map(|text| json!({"text":text}))
}
