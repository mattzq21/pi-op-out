use std::collections::HashMap;
use serde::{Deserialize, Serialize};

pub(crate) mod worktree_setup;
pub(crate) mod snapshot_capture;
pub(crate) mod git_diff_retry;
pub(crate) mod worktrees;
pub(crate) mod project_branches;
pub(crate) mod project_inspection;
pub(crate) mod archive_worktrees;
pub(crate) mod git_diffs;

pub(crate) const MAX_GIT_CHANGED_PATHS: usize = 4096;
pub(crate) const MAX_GIT_PATH_LIST_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_GIT_SNAPSHOT_BYTES: u64 = 32 * 1024 * 1024;
pub(crate) const MAX_GIT_FILE_BYTES: u64 = 16 * 1024 * 1024;
pub(crate) const MAX_GIT_PATCH_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_GIT_DIFFS_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ProjectKind { NoRepo, Main, Worktree }

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffToolPathMapping { pub(crate) tool_call_id: String, pub(crate) path: String, pub(crate) absolute_path: String, pub(crate) canonical_path: String }

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
pub(crate) enum GitDiffSnapshot {
    Legacy(String),
    Located {
        patch: String,
        #[serde(default, rename = "repositoryRoot", skip_serializing_if = "String::is_empty")]
        repository_root: String,
        #[serde(default, rename = "toolPaths", skip_serializing_if = "Vec::is_empty")]
        tool_paths: Vec<DiffToolPathMapping>,
    },
}

pub(crate) type GitDiffSnapshots = HashMap<String, GitDiffSnapshot>;

#[derive(Serialize, Deserialize)]
pub(crate) struct GitSnapshotToken { pub(crate) root: String, pub(crate) tree: String, #[serde(default)] pub(crate) repository_root: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitWorktree { pub(crate) branch: String, pub(crate) path: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitWorktreeRemoval {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) branch: Option<String>,
    pub(crate) branch_deleted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) warning: Option<String>,
}
