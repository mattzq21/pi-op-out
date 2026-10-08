use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

fn recovery_prefix(path: &Path) -> String {
    let name = path.file_name().unwrap_or_default().as_encoded_bytes();
    let label: String = path.file_name().unwrap_or_default().to_string_lossy().chars().take(24)
        .map(|character| if character.is_alphanumeric() || matches!(character, '.' | '-' | '_') { character } else { '_' }).collect();
    format!(".piop-recovery-{label}-{:x}-", Sha256::digest(name))
}

fn recoveries(root: &Path, path: &Path) -> Result<Vec<Value>, String> {
    let parent = path.parent().ok_or("Saved file has no parent directory")?;
    let prefix = recovery_prefix(path);
    let entries = fs::read_dir(parent).map_err(|error| error.to_string())?;
    let mut recoveries = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with(&prefix) { continue; }
        if recoveries.len() >= super::ENTRY_LIMIT { return Err("Too many saved versions to list; open the project directory to inspect them".into()); }
        recoveries.push(json!({ "path": super::relative(root, &entry.path()), "name": name }));
    }
    recoveries.sort_by(|left, right| right["name"].as_str().cmp(&left["name"].as_str()));
    Ok(recoveries)
}

pub(super) fn with_recoveries(mut result: Value, root: &Path, path: &Path) -> Value {
    match recoveries(root, path) {
        Ok(recoveries) => result["recoveries"] = json!(recoveries),
        Err(error) => {
            result["recoveries"] = json!([]);
            result["recoveryWarning"] = json!(format!("Could not list saved versions: {error}"));
        }
    }
    result
}

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
#[path = "project_file_exchange.rs"]
mod platform;

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(super) fn replace_file(_root: &Path, _path: &Path, _content: &str, _expected: &str) -> Result<Value, String> {
    Err("Protected file saves are unavailable on this platform".into())
}

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
pub(super) use protected::replace_file;

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
mod protected {
    use super::{json, platform, recovery_prefix, Path, Value};
    use platform::open_regular;
    use std::{fs::{self, File}, io::{Read, Write}, path::PathBuf, time::{SystemTime, UNIX_EPOCH}};

    struct Save {
        directory: File,
        parent: PathBuf,
        target: PathBuf,
        recovery: PathBuf,
        candidate: PathBuf,
        proposed: PathBuf,
        recovery_path: String,
        proposed_path: String,
        recovery_prefix: String,
    }

    impl Save {
        fn new(root: &Path, path: &Path) -> Result<Self, String> {
            let parent = path.parent().ok_or("Saved file has no parent directory")?.to_path_buf();
            let directory = platform::open_directory(&parent).map_err(|error| error.to_string())?;
            let name = path.file_name().ok_or("Saved file has no name")?;
            let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_millis();
            let recovery_prefix = recovery_prefix(path);
            let recovery_name = format!("{recovery_prefix}{timestamp:020}-{}", uuid::Uuid::new_v4());
            let anchored = platform::directory_path(&directory, &parent);
            let recovery_path = super::super::relative(root, &parent.join(&recovery_name));
            let proposed_name = format!("{recovery_name}-submitted");
            let proposed_path = super::super::relative(root, &parent.join(&proposed_name));
            let recovery = anchored.join(recovery_name);
            let candidate = platform::candidate_path(&recovery);
            Ok(Self { directory, parent, target: anchored.join(name), recovery, candidate, proposed: anchored.join(proposed_name), recovery_path, proposed_path, recovery_prefix })
        }

        fn prepare(&self, content: &str, expected: &str) -> Result<(), String> {
            let original = open_regular(&self.target).map_err(|error| error.to_string())?;
            check_revision(&original, expected)?;
            let permissions = original.metadata().map_err(|error| error.to_string())?.permissions();
            let mut file = platform::create_candidate(&self.candidate).map_err(|error| error.to_string())?;
            let mut proposed_created = false;
            let result = (|| {
                write_synced(&mut file, permissions.clone(), content)?;
                let mut proposed = platform::create_candidate(&self.proposed)?;
                proposed_created = true;
                write_synced(&mut proposed, permissions, content)?;
                platform::prepare_directory(&self.directory)?;
                check_revision(&open_regular(&self.target)?, expected).map_err(std::io::Error::other)
            })();
            drop(file);
            if let Err(error) = result {
                return Err(format!("Could not save file: {error}.{}", self.remove_unpublished(proposed_created)));
            }
            Ok(())
        }

        fn exchange(&self) -> std::io::Result<()> {
            platform::exchange(&self.directory, &self.target, &self.candidate, &self.recovery)
        }

        fn finish(&self, expected: &str, content: &str) -> Value {
            let mut warnings = Vec::new();
            let (conflict, retained) = self.inspect_recovery(expected, &mut warnings);
            let sync = self.sync(retained.as_ref());
            if let Err(error) = &sync { warnings.push(format!("The save completed, but durability could not be confirmed: {error}. Keep the recovery version and retry after resolving the synchronization error.")); }
            let changed_again = self.inspect_target(content, &mut warnings);
            json!({ "committed": true, "durable": sync.is_ok(), "conflict": conflict || changed_again, "recoveryPath": self.recovery_path, "proposedPath": self.proposed_path, "warning": warning(warnings) })
        }

        fn remove_unpublished(&self, proposed_created: bool) -> String {
            let paths = std::iter::once(&self.candidate).chain(proposed_created.then_some(&self.proposed));
            let errors: Vec<_> = paths.filter_map(|path| fs::remove_file(path).err().map(|error| error.to_string())).collect();
            if errors.is_empty() { String::new() } else { format!(" Unfinished save files remain in {}: {}.", self.parent.display(), errors.join("; ")) }
        }

        fn inspect_recovery(&self, expected: &str, warnings: &mut Vec<String>) -> (bool, Option<File>) {
            match open_regular(&self.recovery) {
                Ok(file) => {
                    let conflict = check_revision(&file, expected).is_err();
                    if conflict { warnings.push(format!("An external edit arrived while saving. Your save completed; the displaced version is preserved at {}. Review it before continuing.", self.recovery_path)); }
                    (conflict, Some(file))
                }
                Err(error) => {
                    warnings.push(format!("Your save completed, but the displaced entry could not be inspected at {}: {error}. Review it before continuing.", self.recovery_path));
                    (true, None)
                }
            }
        }

        fn sync(&self, retained: Option<&File>) -> Result<(), String> {
            let results = [
                retained.ok_or_else(|| "The retained version could not be opened for synchronization".to_string())
                    .and_then(|file| file.sync_all().map_err(|error| error.to_string())),
                self.sync_recoveries().map_err(|error| error.to_string()),
                self.directory.sync_all().map_err(|error| error.to_string()),
                crate::private_fs::sync_directory_ancestors(&self.parent),
            ];
            let errors: Vec<_> = results.into_iter().filter_map(Result::err).collect();
            if errors.is_empty() { Ok(()) } else { Err(errors.join("; ")) }
        }

        fn failed_exchange(&self, root: &Path, error: std::io::Error) -> Value {
            let unchanged = platform::definitely_unchanged(&error);
            let committed = unchanged.then_some(false);
            let outcome = if unchanged { "The file was not replaced" } else { "The save outcome could not be confirmed" };
            let retained = if self.recovery.exists() { &self.recovery } else { &self.candidate };
            let recovery_path = super::super::relative(root, &self.parent.join(retained.file_name().unwrap_or_default()));
            let sync_error = self.directory.sync_all().err().map(|error| format!(" Directory synchronization also failed: {error}.")).unwrap_or_default();
            json!({ "committed": committed, "durable": false, "conflict": true, "recoveryPath": recovery_path, "proposedPath": self.proposed_path, "warning": format!("{outcome}: {error}. Reload the file and inspect {recovery_path} before retrying. Your submitted contents are preserved at {}.{sync_error}", self.proposed_path) })
        }

        fn sync_recoveries(&self) -> std::io::Result<()> {
            let directory = self.recovery.parent().ok_or_else(|| std::io::Error::other("Saved version has no directory"))?;
            for entry in fs::read_dir(directory)? {
                let entry = entry?;
                if entry.file_name().to_string_lossy().starts_with(&self.recovery_prefix) { open_regular(&entry.path())?.sync_all()?; }
            }
            Ok(())
        }

        fn inspect_target(&self, content: &str, warnings: &mut Vec<String>) -> bool {
            match current_revision(&self.target) {
                Ok(current) if current == super::super::revision(content) => false,
                Ok(_) => {
                    warnings.push(format!("The file changed again after your save. Your submitted contents are preserved at {}. Reload it before continuing.", self.proposed_path));
                    true
                }
                Err(error) => {
                    warnings.push(format!("The save completed, but the current file could not be checked: {error}. Reload it before continuing."));
                    true
                }
            }
        }

        fn result(&self, mut publication: Value, proposed: &str) -> Value {
            let observed = open_regular(&self.target).map_err(|error| error.to_string()).and_then(super::super::read_text_file);
            match observed {
                Ok(content) => {
                    if publication["committed"] == true && content != proposed {
                        add_warning(&mut publication, &format!("The file changed again after your save. Your submitted contents are preserved at {}. The returned contents reflect the latest observation; reload it before continuing.", self.proposed_path));
                    }
                    json!({ "revision": super::super::revision(&content), "content": content, "publication": publication })
                }
                Err(error) => {
                    add_warning(&mut publication, &format!("Could not read the current file after the save attempt: {error}. Reload it before continuing."));
                    json!({ "revision": null, "content": null, "publication": publication })
                }
            }
        }
    }

    fn add_warning(publication: &mut Value, warning: &str) {
        let previous = publication["warning"].as_str().unwrap_or_default();
        publication["warning"] = json!(format!("{previous} {warning}").trim());
        publication["conflict"] = json!(true);
    }

    fn warning(warnings: Vec<String>) -> Option<String> {
        if warnings.is_empty() { None } else { Some(warnings.join(" ")) }
    }

    fn write_synced(file: &mut File, permissions: fs::Permissions, content: &str) -> std::io::Result<()> {
        file.set_permissions(permissions)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()
    }

    fn check_revision(file: &File, expected: &str) -> Result<(), String> {
        let mut bytes = Vec::new();
        file.take(super::super::FILE_LIMIT + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
        let current = std::str::from_utf8(&bytes).map_err(|error| error.to_string())?;
        if super::super::revision(current) != expected { return Err("This file changed on disk. Reload it before saving to avoid overwriting those changes.".into()); }
        Ok(())
    }

    fn current_revision(path: &Path) -> Result<String, String> {
        let file = open_regular(path).map_err(|error| error.to_string())?;
        let mut bytes = Vec::new();
        file.take(super::super::FILE_LIMIT + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
        let text = std::str::from_utf8(&bytes).map_err(|error| error.to_string())?;
        Ok(super::super::revision(text))
    }

    pub(in super::super) fn replace_file(root: &Path, path: &Path, content: &str, expected: &str) -> Result<Value, String> {
        let save = Save::new(root, path)?;
        save.prepare(content, expected)?;
        let publication = match save.exchange() {
            Ok(()) => save.finish(expected, content),
            Err(error) => save.failed_exchange(root, error),
        };
        Ok(save.result(publication, content))
    }
}
