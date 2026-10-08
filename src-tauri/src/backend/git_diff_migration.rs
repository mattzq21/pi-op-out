use std::{cell::Cell, fmt, fs::{self, File}, io::{self, BufReader, Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}, rc::Rc};
use serde::de::{MapAccess, Visitor};
use serde_json::json;
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
            let Some((id, snapshot)) = map.next_entry::<String, crate::GitDiffSnapshot>()? else { break; };
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

fn publish(path: &Path, source: &mut File) -> Result<(), String> {
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = private_open(&temporary, true)?;
        file.write_all(HEADER).and_then(|_| file.write_all(b"{\"op\":\"begin\"}\n")).map_err(error)?;
        stream(source, &mut file)?;
        file.write_all(b"{\"op\":\"commit\"}\n").and_then(|_| file.sync_all()).map_err(error)?;
        fs::rename(&temporary, path).map_err(error)?;
        sync_parent(path)
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

fn stream(source: &mut File, file: &mut File) -> Result<(), String> {
    let count = Rc::new(Cell::new(0));
    let reader = Bounded { reader: BufReader::new(source), count: count.clone() };
    let mut decoder = serde_json::Deserializer::from_reader(reader);
    serde::Deserializer::deserialize_map(&mut decoder, Entries { file, count }).map_err(error)?;
    decoder.end().map_err(error)
}
