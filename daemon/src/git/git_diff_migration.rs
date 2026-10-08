use std::{cell::Cell, fmt, fs::{self, File}, io::{self, BufReader, Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}, rc::Rc};
use serde::de::{MapAccess, Visitor};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use super::{HEADER, MAX_RECORD_BYTES, error, private_open, record_bytes, sync_parent};

struct Bounded<R> { reader: R, count: Rc<Cell<usize>> }

impl<R: Read> Read for Bounded<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let remaining = MAX_RECORD_BYTES.saturating_sub(self.count.get());
        if remaining == 0 { return Err(io::Error::other("Permanent diff limit: individual legacy record is too large; file preserved")); }
        let length = buffer.len().min(remaining);
        let read = self.reader.read(&mut buffer[..length])?;
        self.count.set(self.count.get() + read);
        Ok(read)
    }
}

struct Entries<'a> { file: &'a mut File, count: Rc<Cell<usize>> }

impl<'de> Visitor<'de> for Entries<'_> {
    type Value = ();
    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result { formatter.write_str("a legacy diff snapshot map") }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        loop {
            self.count.set(0);
            let Some((id, snapshot)) = map.next_entry::<String, crate::git::GitDiffSnapshot>()? else { break; };
            let bytes = record_bytes(&json!({"op":"set","id":id,"snapshot":snapshot})).map_err(serde::de::Error::custom)?;
            self.file.write_all(&bytes).map_err(serde::de::Error::custom)?;
        }
        Ok(())
    }
}

pub(super) fn legacy(path: &Path, source: &mut File) -> Result<bool, String> {
    let mut prefix = [0; 5]; let length = source.read(&mut prefix).map_err(error)?;
    source.seek(SeekFrom::Start(0)).map_err(error)?;
    if length == 0 || &prefix == b"PIOP-" { return Ok(false); }
    publish(path, source)?;
    Ok(true)
}

fn shard_directory(path: &Path) -> Result<PathBuf, String> {
    let filename = path.to_str().ok_or("Invalid diff journal path")?;
    let prefix = filename.strip_suffix(".diffs.json").ok_or("Invalid diff journal filename")?;
    Ok(PathBuf::from(format!("{prefix}.snapshots")).join("diffs"))
}

fn shard_files(path: &Path) -> Result<Vec<PathBuf>, String> {
    let directory = shard_directory(path)?;
    if !shard_directory_exists(&directory)? { return Ok(Vec::new()); }
    let mut files = Vec::new();
    for entry in fs::read_dir(directory).map_err(error)? {
        let entry = entry.map_err(error)?;
        if shard_name(&entry.file_name().to_string_lossy()) { files.push(entry.path()); }
    }
    files.sort();
    Ok(files)
}

fn shard_directory_exists(directory: &Path) -> Result<bool, String> {
    let metadata = match fs::symlink_metadata(directory) {
        Ok(metadata) => metadata,
        Err(cause) if cause.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(cause) => return Err(error(cause)),
    };
    if !metadata.is_dir() || fs::canonicalize(directory).map_err(error)? != directory { return Err("Invalid legacy diff shard directory; preserved".into()); }
    Ok(true)
}

fn shard_name(name: &str) -> bool {
    name.strip_suffix(".json").is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
}

pub(super) fn lock_shards(path: &Path) -> Result<Option<File>, String> {
    if shard_files(path)?.is_empty() { return Ok(None); }
    let directory = shard_directory(path)?;
    let lock = private_open(&directory.parent().ok_or("Diff shards have no parent")?.join("diff-write.lock"), false)?;
    lock.lock().map_err(error)?;
    Ok(Some(lock))
}

fn read_shard(path: &Path) -> Result<Value, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.custom_flags(libc::O_NOFOLLOW); }
    let file = options.open(path).map_err(error)?;
    let metadata = file.metadata().map_err(error)?;
    if !metadata.is_file() || metadata.len() > MAX_RECORD_BYTES as u64 { return Err("Invalid or oversized diff shard; preserved".into()); }
    let record: Value = serde_json::from_reader(file.take((MAX_RECORD_BYTES + 1) as u64)).map_err(error)?;
    let id = record["messageId"].as_str().ok_or("Diff shard has no message identity")?;
    let name = format!("{:x}.json", Sha256::digest(id.as_bytes()));
    if path.file_name().and_then(|value| value.to_str()) != Some(name.as_str()) { return Err("Invalid diff shard identity; preserved".into()); }
    serde_json::from_value::<crate::git::GitDiffSnapshot>(record["snapshot"].clone()).map_err(error)?;
    let record = json!({"op":"set","id":id,"snapshot":record["snapshot"]});
    record_bytes(&record)?;
    Ok(record)
}

pub(super) fn shards(path: &Path, file: &mut File) -> Result<(), String> {
    let files = shard_files(path)?;
    if files.is_empty() { return Ok(()); }
    let mut state = super::read_state(&mut *file, false, None)?;
    for source in files { migrate_shard(path, file, &mut state, &source)?; }
    file.seek(SeekFrom::Start(0)).map_err(error)?;
    Ok(())
}

fn migrate_shard(path: &Path, file: &mut File, state: &mut super::State, source: &Path) -> Result<(), String> {
    let record = read_shard(source)?;
    import_shard(file, state, &record, source)?;
    file.sync_all().map_err(error)?;
    sync_parent(path)?;
    fs::remove_file(source).map_err(error)?;
    sync_parent(source)
}

fn import_shard(file: &mut File, state: &mut super::State, record: &Value, source: &Path) -> Result<(), String> {
    let id = record["id"].as_str().ok_or("Diff shard has no identity")?;
    let hash = super::digest(&record["snapshot"])?;
    if let Some(existing) = state.digests.get(id) {
        if existing != &hash { return Err(format!("Diff shard conflicts with journal message {id}; both copies preserved at {}", source.display())); }
        return Ok(());
    }
    if state.done.contains(id) { return Err(format!("Diff shard conflicts with a completed journal message {id}; preserved at {}", source.display())); }
    append_shard(file, state, record)?;
    state.digests.insert(id.to_owned(), hash);
    Ok(())
}

fn append_shard(file: &mut File, state: &mut super::State, record: &Value) -> Result<(), String> {
    file.set_len(state.end).map_err(error)?;
    file.seek(SeekFrom::Start(state.end)).map_err(error)?;
    if state.end == 0 { file.write_all(HEADER).map_err(error)?; }
    super::write_transaction(file, std::slice::from_ref(record))?;
    state.end = file.stream_position().map_err(error)?;
    Ok(())
}

fn publish(path: &Path, source: &mut File) -> Result<(), String> {
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = private_open(&temporary, true)?;
        file.write_all(HEADER).and_then(|_| file.write_all(b"{\"op\":\"begin\"}\n")).map_err(error)?;
        stream(source, &mut file)?;
        stream_shards(path, &mut file)?;
        file.write_all(b"{\"op\":\"commit\"}\n").and_then(|_| file.sync_all()).map_err(error)?;
        fs::rename(&temporary, path).map_err(error)?;
        sync_parent(path)
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

fn stream_shards(path: &Path, file: &mut File) -> Result<(), String> {
    for source in shard_files(path)? { file.write_all(&record_bytes(&read_shard(&source)?)?).map_err(error)?; }
    Ok(())
}

fn stream(source: &mut File, file: &mut File) -> Result<(), String> {
    let count = Rc::new(Cell::new(0));
    let reader = Bounded { reader: BufReader::new(source), count: count.clone() };
    let mut decoder = serde_json::Deserializer::from_reader(reader);
    serde::Deserializer::deserialize_map(&mut decoder, Entries { file, count }).map_err(error)?;
    decoder.end().map_err(error)
}
