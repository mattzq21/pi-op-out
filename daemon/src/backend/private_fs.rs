include!("../../../shared/rust/private_fs.rs");

pub(super) fn atomic_write_private(path: &Path, body: &[u8]) -> Result<(), String> {
    match publish_private(path, body)?.error { Some(error) => Err(error), None => Ok(()) }
}
