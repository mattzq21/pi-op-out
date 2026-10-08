use std::{collections::{HashMap, HashSet}, process::Command, thread};
use crate::SessionSummary;
use super::{ProjectKind, MAX_GIT_PATH_LIST_BYTES};
use super::worktree_setup::run_limited;

fn project_kind_from_flag(flag: &[u8]) -> Option<ProjectKind> {
    match flag { b"no-repo" => Some(ProjectKind::NoRepo), b"main" => Some(ProjectKind::Main), b"worktree" => Some(ProjectKind::Worktree), _ => None }
}

fn inspect_project_batches(directories: &[String], script: &str, command: &mut impl FnMut(&str, &[String]) -> Command) -> Result<Vec<(Vec<String>, crate::git_ops::worktree_setup::LimitedOutput)>, String> {
    let mut outputs = Vec::new();
    for group in directories.chunks(64) {
        let commands = group.chunks(16).map(|batch| (batch.to_vec(), command(script, batch))).collect::<Vec<_>>();
        let completed = thread::scope(|scope| {
            let workers = commands.into_iter().map(|(batch, mut command)| scope.spawn(move || {
                run_limited(&mut command, MAX_GIT_PATH_LIST_BYTES, "Could not inspect session projects").map(|output| (batch, output))
            })).collect::<Vec<_>>();
            workers.into_iter().map(|worker| worker.join().map_err(|_| "Project inspection worker panicked".to_string())?).collect::<Result<Vec<_>, String>>()
        })?;
        outputs.extend(completed);
    }
    Ok(outputs)
}

pub(crate) fn inspect_session_projects_with(sessions: &mut [SessionSummary], mut command: impl FnMut(&str, &[String]) -> Command) -> Result<(), String> {
    let mut directories = sessions.iter().map(|session| session.cwd.clone()).collect::<HashSet<_>>().into_iter().collect::<Vec<_>>();
    directories.sort();
    let script = r#"previous_git_dir=
    for path do
        if [ ! -d "$path" ]; then printf 'missing\000\000\000\000'; continue; fi
        git_dir=$(git -C "$path" rev-parse --absolute-git-dir 2>/dev/null) || { printf 'no-repo\000\000\000\000'; continue; }
        if [ "$git_dir" != "$previous_git_dir" ] || [ -n "${GIT_DIR+x}${GIT_WORK_TREE+x}${GIT_COMMON_DIR+x}" ]; then
            common_dir=$(git -C "$path" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || { printf 'unknown\000\000\000\000'; continue; }
            if [ "$git_dir" = "$common_dir" ]; then project_kind=main; else project_kind=worktree; fi
            project_root=$(git -C "$path" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')
            branch=$(git -C "$path" symbolic-ref --quiet --short HEAD 2>/dev/null) || branch=$(git -C "$path" rev-parse --short HEAD 2>/dev/null | sed 's/^/Detached at /')
            worktree_root=$(git -C "$path" rev-parse --show-toplevel 2>/dev/null)
            previous_git_dir=$git_dir
        fi
        printf '%s\000%s\000%s\000%s\000' "$project_kind" "$project_root" "$branch" "$worktree_root"
    done"#;
    let mut projects = HashMap::new();
    for (batch, output) in inspect_project_batches(&directories, script, &mut command)? {
        if !output.status.success() { return Err(format!("Could not inspect session projects: {}", String::from_utf8_lossy(&output.stderr).trim())); }
        let fields = output.stdout.strip_suffix(&[0]).ok_or("Incomplete session project details")?.split(|byte| *byte == 0).collect::<Vec<_>>();
        if fields.len() != batch.len() * 4 { return Err("Could not inspect every session project".into()); }
        for (path, details) in batch.iter().zip(fields.chunks_exact(4)) {
            let flag = details[0];
            let project_root = (!details[1].is_empty()).then(|| String::from_utf8_lossy(details[1]).into_owned());
            let branch = (!details[2].is_empty()).then(|| String::from_utf8_lossy(details[2]).into_owned());
            let worktree_root = (!details[3].is_empty()).then(|| String::from_utf8_lossy(details[3]).into_owned());
            let kind = project_kind_from_flag(flag);
            projects.insert(path.clone(), (flag != b"missing", kind, project_root, branch, worktree_root));
        }
    }
    for session in sessions {
        if let Some((exists, kind, project_root, branch, worktree_root)) = projects.get(session.cwd.as_str()) { session.cwd_exists = *exists; session.project_kind = *kind; session.project_root = project_root.clone(); session.branch = branch.clone(); session.worktree_root = worktree_root.clone(); }
    }
    Ok(())
}
