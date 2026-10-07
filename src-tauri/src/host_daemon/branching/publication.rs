use super::super::{controller::Host, protocol::Result};
use serde_json::json;
use std::{fs, io::Write, path::Path};

pub(super) fn publish(host: &Host, source: &str, branch: &Path, session_id: &str, destination: &Path, ephemeral: bool) -> Result<()> {
    if ephemeral {
        let root = host.storage_root();
        let _publication = super::super::reference_publication::lock(&root)?;
        super::super::reference_publication::register_transcript(&root, destination)?;
        return publish_ephemeral(source, branch, session_id, destination);
    }
    crate::git_diff_retry::retry_pending_git_diffs(source, None)?;
    let request = json!({"root":host.storage_root(),"source":source,"branch":branch,"sessionId":session_id,"destination":destination});
    match publication_request(&request) {
        Ok(_) => Ok(()),
        Err(error) => {
            let mut result = request;
            result["action"] = json!("result");
            match publication_request(&result).and_then(|output| serde_json::from_slice::<bool>(&output).map_err(|error| error.to_string())) {
                Ok(true) => Ok(()),
                Ok(false) => Err(error),
                Err(recovery) => Err(format!("{error}; fork recovery is pending: {recovery}")),
            }
        },
    }
}

fn publication_request(request: &serde_json::Value) -> Result<Vec<u8>> {
    let output = crate::node_command()
        .args(["-e", include_str!("../../../resources/publish-fork.bundle.mjs"), &request.to_string()])
        .output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!("Could not publish conversation branch: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(output.stdout)
}

pub(super) fn recover(host: &Host) -> Result<()> {
    publication_request(&json!({"action":"recover","root":host.storage_root()})).map(|_| ())
}

fn publish_ephemeral(source: &str, branch: &Path, session_id: &str, destination: &Path) -> Result<()> {
    let contents = fs::read(branch).map_err(|error| error.to_string())?;
    let newline = contents.iter().position(|byte| *byte == b'\n').ok_or("Branch session header is missing")?;
    let mut header: serde_json::Value = serde_json::from_slice(&contents[..newline]).map_err(|error| error.to_string())?;
    if header["type"] != "session" || header["id"] != session_id { return Err("Branch session identity changed".into()); }
    header["parentSession"] = json!(source);
    let temporary = destination.with_extension(format!("{}.pending", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = super::private_file(&temporary)?;
        writeln!(file, "{header}").and_then(|_| file.write_all(&contents[newline + 1..])).and_then(|_| file.sync_all()).map_err(|error| error.to_string())?;
        fs::hard_link(&temporary, destination).map_err(|error| error.to_string())
    })();
    let cleanup = fs::remove_file(&temporary).map_err(|error| error.to_string());
    result.and(cleanup)
}

pub(super) fn remove(host: &Host, path: &Path, ephemeral: bool) -> Result<()> {
    if !ephemeral { return publication_request(&json!({"action":"remove","root":host.storage_root(),"destination":path})).map(|_| ()); }
    for file in [path.to_owned(), path.with_extension("diffs.json")] {
        match fs::remove_file(file) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.to_string()),
            _ => {},
        }
    }
    let parent = path.parent().ok_or("Branch publication directory is missing")?;
    fs::File::open(parent).and_then(|directory| directory.sync_all()).map_err(|error| error.to_string())
}
