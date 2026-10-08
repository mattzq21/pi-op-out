use serde_json::{json, Value};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{fs::File, io::Read, path::Path};

const IMAGE_LIMIT: u64 = 10 * 1024 * 1024;

pub(crate) fn read_image(app: super::AppHandle, cwd: &str, path: &str, host_id: &str) -> Result<Value, String> {
    let bytes = if host_id == "local" { read_local_image(cwd, path)? } else { read_remote_image(app, cwd, path, host_id)? };
    if bytes.len() as u64 > IMAGE_LIMIT { return Err("Image is larger than 10 MB".into()); }
    let mime = image_mime(&bytes)?;
    Ok(json!(format!("data:{mime};base64,{}", STANDARD.encode(bytes))))
}

fn read_local_image(cwd: &str, path: &str) -> Result<Vec<u8>, String> {
    let requested = Path::new(path);
    let target = if requested.is_absolute() { requested.to_path_buf() } else { Path::new(cwd).join(requested) };
    let file = File::open(target).map_err(|error| format!("Could not read image: {error}"))?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() { return Err("Select a regular image file".into()); }
    if metadata.len() > IMAGE_LIMIT { return Err("Image is larger than 10 MB".into()); }
    let mut bytes = Vec::new();
    file.take(IMAGE_LIMIT + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    Ok(bytes)
}

fn read_remote_image(app: super::AppHandle, cwd: &str, path: &str, host_id: &str) -> Result<Vec<u8>, String> {
    let settings = super::load_app_settings(app)?;
    let host = super::remote_host(&settings, host_id)?;
    let script = r#"const fs=require('fs'),p=require('path');const fd=fs.openSync(p.resolve(process.argv[1],process.argv[2]),'r');const s=fs.fstatSync(fd);if(!s.isFile()||s.size>10485760)throw Error('Select an image file up to 10 MB');const b=Buffer.alloc(10485761);let n=0,k;while(n<b.length&&(k=fs.readSync(fd,b,n,b.length-n,null)))n+=k;fs.closeSync(fd);process.stdout.write(b.subarray(0,n));"#;
    let command = format!("node -e {} {} {}", super::shell_quote(script), super::shell_quote(cwd), super::shell_quote(path));
    let output = super::run_limited(super::ssh(host).arg(super::remote_login_command(&command)), IMAGE_LIMIT as usize + 1, "Could not read image")?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    Ok(output.stdout)
}

fn image_mime(bytes: &[u8]) -> Result<&'static str, String> {
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") { "image/png" }
        else if bytes.starts_with(b"\xff\xd8\xff") { "image/jpeg" }
        else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") { "image/gif" }
        else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") { "image/webp" }
        else { return Err("Unsupported image format".into()); };
    Ok(mime)
}
