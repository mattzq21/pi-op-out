use serde::{Deserialize, Serialize};

pub(crate) mod worktree_setup;
pub(crate) mod worktrees;
pub(crate) mod project_branches;
pub(crate) mod project_inspection;
pub(crate) mod archive_worktrees;

pub(crate) const MAX_GIT_PATH_LIST_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ProjectKind { NoRepo, Main, Worktree }

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
