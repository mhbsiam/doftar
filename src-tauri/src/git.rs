//! Read-only view of the Git repository of a folder.
//! libgit2 has no network transports here and runs no hooks, fsmonitor or filters.
//! The only write is `switch`.

use std::collections::HashMap;
use std::path::Path;

use git2::build::CheckoutBuilder;
use git2::{BranchType, Repository, RepositoryState, Sort, Status, StatusOptions};
use serde::Serialize;

use crate::jobs;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    /// The short commit id when HEAD is detached.
    branch: String,
    detached: bool,
    upstream: Option<String>,
    ahead: usize,
    behind: usize,
    /// Ignored items are not counted.
    changes: usize,
    files: HashMap<String, &'static str>,
}

fn code(s: Status) -> Option<&'static str> {
    if s.is_conflicted() {
        Some("conflicted")
    } else if s.is_wt_new() {
        Some("untracked")
    } else if s.is_index_new() {
        Some("added")
    } else if s.intersects(
        Status::WT_MODIFIED
            | Status::WT_RENAMED
            | Status::WT_TYPECHANGE
            | Status::INDEX_MODIFIED
            | Status::INDEX_RENAMED
            | Status::INDEX_TYPECHANGE,
    ) {
        Some("modified")
    } else {
        None
    }
}

fn branch_of(repo: &Repository) -> (String, bool, Option<String>, usize, usize) {
    let head = match repo.head() {
        Ok(h) => h,
        // A new repository has no commits. HEAD still names its branch.
        Err(_) => {
            let name = repo
                .find_reference("HEAD")
                .ok()
                .and_then(|r| r.symbolic_target().ok().flatten().map(|t| t.trim_start_matches("refs/heads/").to_string()))
                .unwrap_or_default();
            return (name, false, None, 0, 0);
        }
    };
    if !head.is_branch() {
        let id = head.target().map(|o| o.to_string()[..7].to_string()).unwrap_or_default();
        return (id, true, None, 0, 0);
    }
    let name = head.shorthand().unwrap_or_default().to_string();
    let branch = git2::Branch::wrap(head);
    let Ok(up) = branch.upstream() else { return (name, false, None, 0, 0) };
    let up_name = up.name().ok().flatten().map(str::to_string);
    let (ahead, behind) = match (branch.get().target(), up.get().target()) {
        (Some(l), Some(u)) => repo.graph_ahead_behind(l, u).unwrap_or((0, 0)),
        _ => (0, 0),
    };
    (name, false, up_name, ahead, behind)
}

pub fn info(dir: &Path) -> Option<GitInfo> {
    let repo = Repository::discover(dir).ok()?;
    // Bare repositories and folders inside `.git` have no working files.
    let workdir = repo.workdir()?.canonicalize().ok()?;
    let dir = dir.canonicalize().ok()?;
    if dir.starts_with(repo.path().canonicalize().ok()?) {
        return None;
    }
    let rel = dir.strip_prefix(&workdir).ok()?;
    let prefix = if rel.as_os_str().is_empty() {
        String::new()
    } else {
        format!("{}/", rel.to_str()?)
    };

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(false)
        .include_ignored(false)
        .exclude_submodules(true);
    if !prefix.is_empty() {
        // Match literally. Names like `[draft]` are not patterns.
        opts.pathspec(&prefix).disable_pathspec_match(true);
    }
    let statuses = repo.statuses(Some(&mut opts)).ok()?;

    let mut files: HashMap<String, &'static str> = HashMap::new();
    let mut changes = 0;
    for e in statuses.iter() {
        let Ok(path) = e.path() else { continue };
        let Some(inside) = path.strip_prefix(prefix.as_str()) else { continue };
        if inside.is_empty() {
            // The folder is untracked, so all its unignored contents are untracked.
            for child in std::fs::read_dir(&dir).ok()?.flatten() {
                let Some(name) = child.file_name().to_str().map(str::to_string) else { continue };
                if !repo.status_should_ignore(Path::new(&format!("{prefix}{name}"))).unwrap_or(false) {
                    files.insert(name, "untracked");
                }
            }
            changes = files.len();
            break;
        }
        let Some(c) = code(e.status()) else {
            // Deleted: no row to mark. The parent folder changed.
            changes += 1;
            if let Some((child, _)) = inside.split_once('/') {
                files.entry(child.to_string()).or_insert("changed");
            }
            continue;
        };
        let (child, deeper) = match inside.split_once('/') {
            // An untracked folder is reported as `dir/`.
            Some((child, rest)) => (child, !rest.is_empty()),
            None => (inside, false),
        };
        changes += 1;
        let c = if deeper && c != "conflicted" { "changed" } else { c };
        let slot = files.entry(child.to_string()).or_insert(c);
        if c == "conflicted" {
            *slot = c;
        }
    }

    let (branch, detached, upstream, ahead, behind) = branch_of(&repo);
    Some(GitInfo { branch, detached, upstream, ahead, behind, changes, files })
}

#[tauri::command]
pub async fn git_info(path: String) -> Result<Option<GitInfo>, String> {
    jobs::blocking(move || info(Path::new(&path))).await
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    name: String,
    current: bool,
    upstream: Option<String>,
    ahead: usize,
    behind: usize,
    summary: String,
    /// Unix seconds of the last commit.
    time: i64,
    /// Another worktree that has this branch checked out.
    worktree: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    path: String,
    branch: String,
    main: bool,
    current: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    id: String,
    summary: String,
    author: String,
    time: i64,
    parents: Vec<String>,
    refs: Vec<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    root: String,
    branches: Vec<Branch>,
    remotes: usize,
    worktrees: Vec<Worktree>,
    stashes: Vec<String>,
    commits: Vec<Commit>,
}

const LOG_LIMIT: usize = 200;

fn worktrees(repo: &Repository) -> Vec<Worktree> {
    let here = repo.workdir().and_then(|p| p.canonicalize().ok());
    let mut out = Vec::new();
    let mut push = |r: &Repository, path: &Path, main: bool| {
        let Ok(path) = path.canonicalize() else { return };
        out.push(Worktree {
            branch: branch_of(r).0,
            current: here.as_deref() == Some(path.as_path()),
            path: path.to_string_lossy().into_owned(),
            main,
        });
    };
    // The common directory is the `.git` of the main worktree.
    if let Ok(main) = Repository::open(repo.commondir()) {
        if let Some(w) = main.workdir() {
            push(&main, w, true);
        }
    }
    let names: Vec<String> = repo.worktrees().map(|a| a.iter().flatten().flatten().map(str::to_string).collect()).unwrap_or_default();
    for name in names {
        let Ok(wt) = repo.find_worktree(&name) else { continue };
        // Skip a worktree whose folder is gone.
        let Ok(r) = Repository::open_from_worktree(&wt) else { continue };
        push(&r, wt.path(), false);
    }
    out
}

pub fn overview(dir: &Path) -> Option<Overview> {
    let repo = Repository::discover(dir).ok()?;
    let root = repo.workdir()?.canonicalize().ok()?.to_string_lossy().into_owned();
    let trees = worktrees(&repo);

    let mut branches = Vec::new();
    for (b, _) in repo.branches(Some(BranchType::Local)).ok()?.flatten() {
        let Some(name) = b.name().ok().flatten().map(str::to_string) else { continue };
        let Ok(commit) = b.get().peel_to_commit() else { continue };
        let up = b.upstream().ok();
        let (ahead, behind) = up
            .as_ref()
            .and_then(|u| u.get().target())
            .and_then(|u| repo.graph_ahead_behind(commit.id(), u).ok())
            .unwrap_or((0, 0));
        branches.push(Branch {
            current: b.is_head(),
            upstream: up.and_then(|u| u.name().ok().flatten().map(str::to_string)),
            ahead,
            behind,
            summary: commit.summary().ok().flatten().unwrap_or_default().to_string(),
            time: commit.time().seconds(),
            worktree: trees.iter().find(|w| !w.current && w.branch == name).map(|w| w.path.clone()),
            name,
        });
    }
    branches.sort_by(|a, b| b.current.cmp(&a.current).then(b.time.cmp(&a.time)));
    let remotes = repo
        .branches(Some(BranchType::Remote))
        .map(|it| it.flatten().filter(|(b, _)| b.get().kind() == Some(git2::ReferenceType::Direct)).count())
        .unwrap_or(0);

    let mut refs: HashMap<git2::Oid, Vec<String>> = HashMap::new();
    for r in repo.references().ok()?.flatten() {
        if r.kind() != Some(git2::ReferenceType::Direct) || r.is_note() {
            continue;
        }
        let (Ok(name), Ok(c)) = (r.shorthand(), r.peel_to_commit()) else { continue };
        refs.entry(c.id()).or_default().push(name.to_string());
    }
    let mut walk = repo.revwalk().ok()?;
    // Topological order makes libgit2 walk all history first.
    walk.set_sorting(Sort::TIME).ok()?;
    let _ = walk.push_head();
    for (b, _) in repo.branches(Some(BranchType::Local)).ok()?.flatten() {
        if let Some(id) = b.get().target() {
            let _ = walk.push(id);
        }
    }
    let commits = walk
        .flatten()
        .take(LOG_LIMIT)
        .filter_map(|id| repo.find_commit(id).ok())
        .map(|c| Commit {
            id: c.id().to_string(),
            summary: c.summary().ok().flatten().unwrap_or_default().to_string(),
            author: c.author().name().unwrap_or_default().to_string(),
            time: c.time().seconds(),
            parents: c.parent_ids().map(|p| p.to_string()).collect(),
            refs: refs.remove(&c.id()).unwrap_or_default(),
        })
        .collect();

    // `stash_foreach` needs a mutable handle. Open the repository again.
    let mut stashes = Vec::new();
    if let Ok(mut r) = Repository::open(repo.path()) {
        let _ = r.stash_foreach(|_, msg, _| {
            stashes.push(msg.to_string());
            true
        });
    }
    Some(Overview { root, branches, remotes, worktrees: trees, stashes, commits })
}

#[tauri::command]
pub async fn git_overview(path: String) -> Result<Option<Overview>, String> {
    jobs::blocking(move || overview(Path::new(&path))).await
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    /// Folder name of the main worktree.
    repo: String,
    /// The short commit id when HEAD is detached.
    branch: String,
    detached: bool,
    /// Ignored items are not counted. An untracked folder counts once.
    changes: usize,
    /// Commits that no other branch or remote branch has. Capped at `UNIQUE_LIMIT`.
    unique: usize,
    locked: bool,
}

const UNIQUE_LIMIT: usize = 1000;

/// None if `dir` is not a linked worktree.
pub fn worktree_status(dir: &Path) -> Option<WorktreeStatus> {
    let repo = Repository::open(dir).ok()?;
    if !repo.is_worktree() {
        return None;
    }
    let common = repo.commondir().canonicalize().ok()?;
    let repo_name = common.parent()?.file_name()?.to_string_lossy().into_owned();
    let locked = git2::Worktree::open_from_repository(&repo)
        .ok()
        .and_then(|w| w.is_locked().ok())
        .is_some_and(|l| !matches!(l, git2::WorktreeLockStatus::Unlocked));

    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(false).include_ignored(false).exclude_submodules(true);
    let changes = repo.statuses(Some(&mut opts)).ok()?.len();

    let (branch, detached, ..) = branch_of(&repo);
    let unique = (|| {
        let head = repo.head().ok()?;
        let own = head.name().ok().map(str::to_string);
        let mut walk = repo.revwalk().ok()?;
        walk.push(head.target()?).ok()?;
        for r in repo.references().ok()?.flatten() {
            let Ok(name) = r.name() else { continue };
            let other = name.starts_with("refs/remotes/") || name.starts_with("refs/heads/");
            if other && Some(name) != own.as_deref() {
                if let Ok(c) = r.peel_to_commit() {
                    let _ = walk.hide(c.id());
                }
            }
        }
        Some(walk.take(UNIQUE_LIMIT).count())
    })()
    .unwrap_or(0);
    Some(WorktreeStatus { repo: repo_name, branch, detached, changes, unique, locked })
}

#[tauri::command]
pub async fn git_worktree_status(path: String) -> Result<Option<WorktreeStatus>, String> {
    jobs::blocking(move || worktree_status(Path::new(&path))).await
}

/// Check out local branch `name`. Refuse if uncommitted edits would be overwritten.
pub fn switch(dir: &Path, name: &str) -> Result<(), String> {
    let repo = Repository::discover(dir).map_err(|e| e.message().to_string())?;
    let workdir = repo.workdir().ok_or("This repository has no working folder.")?;
    if repo.state() != RepositoryState::Clean {
        return Err("A merge, rebase or similar is in progress here. Finish it with git first.".into());
    }
    // libgit2 does not run filter drivers (Git LFS, git-crypt). Files would be written raw.
    // shortcut: reads only the top-level .gitattributes. Nested filter rules are missed.
    if std::fs::read_to_string(workdir.join(".gitattributes")).is_ok_and(|s| s.contains("filter=")) {
        return Err("This repository uses a Git filter such as LFS. Switch branches with git.".into());
    }
    // libgit2 fills in the left-out files of a sparse checkout. It cannot fetch missing objects.
    let config = repo.config().map_err(|e| e.message().to_string())?;
    if config.get_bool("core.sparseCheckout").unwrap_or(false) || config.get_string("extensions.partialclone").is_ok() {
        return Err("This is a sparse or partial clone. Switch branches with git.".into());
    }
    let branch = repo.find_branch(name, BranchType::Local).map_err(|e| e.message().to_string())?;
    if let Some(w) = worktrees(&repo).iter().find(|w| !w.current && w.branch == name) {
        return Err(format!("“{name}” is already checked out in {}.", w.path));
    }
    // Commits on a detached HEAD that no branch contains stay only in the reflog.
    if repo.head_detached().unwrap_or(false) {
        if let Some(head) = repo.head().ok().and_then(|h| h.target()) {
            let kept = repo.branches(Some(BranchType::Local)).map_err(|e| e.message().to_string())?.flatten().any(|(b, _)| {
                b.get().target().is_some_and(|t| t == head || repo.graph_descendant_of(t, head).unwrap_or(false))
            });
            if !kept {
                return Err("HEAD has commits on no branch. Create a branch for them with git first.".into());
            }
        }
    }
    let target = branch.get().name().map_err(|_| "Branch name isn't valid UTF-8.")?.to_string();
    let commit = branch.get().peel_to_commit().map_err(|e| e.message().to_string())?;
    // Unlike git, keep ignored files. A local `.env` survives.
    let mut checkout = CheckoutBuilder::new();
    checkout.safe().overwrite_ignored(false);
    repo.checkout_tree(commit.as_object(), Some(&mut checkout))
        .map_err(|e| {
            if e.code() == git2::ErrorCode::Conflict {
                "Local files would be overwritten. Commit, stash or move them first.".to_string()
            } else {
                e.message().to_string()
            }
        })?;
    repo.set_head(&target).map_err(|e| e.message().to_string())
}

#[tauri::command]
pub async fn git_switch(path: String, branch: String) -> Result<(), String> {
    jobs::blocking(move || switch(Path::new(&path), &branch)).await?
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    path: String,
    branch: String,
    /// No remotes.
    local_only: bool,
    /// Unix seconds of HEAD. None before the first commit.
    last_commit: Option<i64>,
}

const SKIP: &[&str] = &["Library", "node_modules", "target", "vendor", "venv", "Pods", "DerivedData"];
/// Packages that look like folders.
const BUNDLES: &[&str] = &["app", "photoslibrary", "musiclibrary", "tvlibrary", "photolibrary", "bundle", "framework", "xcarchive"];
const SCAN_DEPTH: usize = 7;

fn find_repos(dir: &Path, depth: usize, out: &mut Vec<std::path::PathBuf>) {
    // `.git` is a file in worktrees and submodules.
    if dir.join(".git").exists() {
        out.push(dir.to_path_buf());
        return;
    }
    if depth == 0 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name();
        let name = name.to_string_lossy();
        // `file_type` does not follow symlinks. Links cannot loop the walk.
        let is_dir = e.file_type().is_ok_and(|t| t.is_dir());
        let bundle = Path::new(&*name).extension().is_some_and(|x| BUNDLES.contains(&&*x.to_string_lossy()));
        if !is_dir || name.starts_with('.') || bundle || SKIP.contains(&&*name) {
            continue;
        }
        find_repos(&e.path(), depth - 1, out);
    }
}

/// Outermost Git repositories under `root`.
pub fn repos(root: &Path) -> Vec<Repo> {
    let mut found = Vec::new();
    find_repos(root, SCAN_DEPTH, &mut found);
    found
        .into_iter()
        .filter_map(|p| {
            let repo = Repository::open(&p).ok()?;
            Some(Repo {
                branch: branch_of(&repo).0,
                local_only: repo.remotes().map_or(true, |r| r.is_empty()),
                last_commit: repo.head().ok().and_then(|h| h.peel_to_commit().ok()).map(|c| c.time().seconds()),
                path: p.to_string_lossy().into_owned(),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn git_repos() -> Result<Vec<Repo>, String> {
    let home = dirs::home_dir().ok_or("No home folder")?;
    jobs::blocking(move || repos(&home)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn finds_outermost_repositories() {
        let base = std::env::temp_dir().join(format!("wf-repos-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        for d in ["a/inner", ".hidden/b", "node_modules/c", "x.app/d", "e f/g"] {
            fs::create_dir_all(base.join(d)).unwrap();
        }
        for d in ["a", "a/inner", ".hidden/b", "node_modules/c", "x.app/d", "e f/g"] {
            Repository::init(base.join(d)).unwrap();
        }
        let mut got: Vec<String> = repos(&base).into_iter().map(|r| r.path).collect();
        got.sort();
        let want: Vec<String> = ["a", "e f/g"].iter().map(|d| base.join(d).to_string_lossy().into_owned()).collect();
        assert_eq!(got, want);
        assert!(repos(&base).iter().all(|r| r.local_only && r.last_commit.is_none()));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn reports_branch_and_child_statuses() {
        let base = std::env::temp_dir().join(format!("wf-git-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("src/deep")).unwrap();
        let repo = Repository::init(&base).unwrap();
        fs::write(base.join("a.txt"), "1").unwrap();
        fs::write(base.join("src/deep/b.txt"), "1").unwrap();
        fs::write(base.join(".gitignore"), "*.log\n").unwrap();

        let fresh = info(&base).unwrap();
        assert!(!fresh.branch.is_empty());
        assert_eq!(fresh.files.get("a.txt"), Some(&"untracked"));

        let mut index = repo.index().unwrap();
        index.add_all(["*"], git2::IndexAddOption::DEFAULT, None).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::now("t", "t@example.com").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();

        fs::write(base.join("a.txt"), "2").unwrap();
        fs::write(base.join("src/deep/b.txt"), "2").unwrap();
        fs::write(base.join("new.txt"), "").unwrap();
        fs::write(base.join("x.log"), "").unwrap();

        let top = info(&base).unwrap();
        assert!(!top.detached);
        assert_eq!(top.files.get("a.txt"), Some(&"modified"));
        assert_eq!(top.files.get("src"), Some(&"changed"));
        assert_eq!(top.files.get("new.txt"), Some(&"untracked"));
        assert_eq!(top.files.get("x.log"), None);
        assert_eq!(top.files.get(".gitignore"), None);
        assert_eq!(top.changes, 3);

        let sub = info(&base.join("src")).unwrap();
        assert_eq!(sub.files.get("deep"), Some(&"changed"));
        assert_eq!(sub.files.len(), 1);
        assert_eq!(sub.changes, 1);

        let leaf = info(&base.join("src/deep")).unwrap();
        assert_eq!(leaf.files.get("b.txt"), Some(&"modified"));

        assert!(info(&base.join(".git")).is_none());
        fs::remove_dir_all(&base).unwrap();
    }

    fn commit_all(repo: &Repository, msg: &str) {
        let mut index = repo.index().unwrap();
        index.add_all(["*"], git2::IndexAddOption::DEFAULT, None).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::now("t", "t@example.com").unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<_> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents).unwrap();
    }

    #[test]
    fn overview_and_safe_switch() {
        let base = std::env::temp_dir().join(format!("wf-gitov-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let main_dir = base.join("repo");
        fs::create_dir_all(&main_dir).unwrap();
        let repo = Repository::init(&main_dir).unwrap();
        fs::write(main_dir.join("a.txt"), "1").unwrap();
        commit_all(&repo, "first");
        let first = repo.head().unwrap().shorthand().unwrap().to_string();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature", &head, false).unwrap();
        repo.branch("elsewhere", &head, false).unwrap();
        fs::write(main_dir.join("a.txt"), "2").unwrap();
        commit_all(&repo, "second");

        let wt_dir = base.join("wt");
        let wt_ref = repo.find_branch("elsewhere", BranchType::Local).unwrap();
        let mut opts = git2::WorktreeAddOptions::new();
        opts.reference(Some(wt_ref.get()));
        repo.worktree("wt", &wt_dir, Some(&opts)).unwrap();

        let ov = overview(&main_dir).unwrap();
        assert_eq!(ov.branches.len(), 3);
        assert!(ov.branches[0].current);
        assert_eq!(ov.branches[0].name, first);
        assert_eq!(ov.commits.len(), 2);
        assert_eq!(ov.commits[0].summary, "second");
        assert!(ov.commits[0].refs.contains(&first));
        assert_eq!(ov.commits[1].parents.len(), 0);
        assert_eq!(ov.worktrees.len(), 2);
        assert!(ov.worktrees[0].main && ov.worktrees[0].current);
        assert_eq!(ov.worktrees[1].branch, "elsewhere");
        let elsewhere = ov.branches.iter().find(|b| b.name == "elsewhere").unwrap();
        assert!(elsewhere.worktree.is_some());

        let from_wt = overview(&wt_dir).unwrap();
        assert!(from_wt.worktrees[1].current && !from_wt.worktrees[0].current);

        assert!(switch(&main_dir, "elsewhere").unwrap_err().contains("already checked out"));

        fs::write(main_dir.join("a.txt"), "mine").unwrap();
        assert!(switch(&main_dir, "feature").unwrap_err().contains("would be overwritten"));
        assert_eq!(fs::read_to_string(main_dir.join("a.txt")).unwrap(), "mine");

        fs::write(main_dir.join("a.txt"), "2").unwrap();
        switch(&main_dir, "feature").unwrap();
        assert_eq!(fs::read_to_string(main_dir.join("a.txt")).unwrap(), "1");
        assert_eq!(info(&main_dir).unwrap().branch, "feature");
        assert!(switch(&main_dir, "nope").is_err());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn worktree_status_counts_changes_and_unique_commits() {
        let (base, repo) = temp_repo("wts");
        fs::write(base.join("a.txt"), "1").unwrap();
        commit_all(&repo, "init");
        let wt_dir = base.with_file_name(format!("{}-wt", base.file_name().unwrap().to_string_lossy()));
        let _ = fs::remove_dir_all(&wt_dir);
        repo.worktree("feat", &wt_dir, None).unwrap();
        assert!(worktree_status(&base).is_none(), "the main worktree is not a linked one");

        let s = worktree_status(&wt_dir).unwrap();
        assert_eq!((s.branch.as_str(), s.changes, s.unique, s.locked), ("feat", 0, 0, false));
        assert_eq!(s.repo, base.file_name().unwrap().to_string_lossy());

        let wt = Repository::open(&wt_dir).unwrap();
        fs::write(wt_dir.join("b.txt"), "2").unwrap();
        commit_all(&wt, "work");
        fs::write(wt_dir.join("c.txt"), "3").unwrap();
        let s = worktree_status(&wt_dir).unwrap();
        assert_eq!((s.changes, s.unique), (1, 1), "an untracked file and a commit only feat has");

        repo.find_worktree("feat").unwrap().lock(None).unwrap();
        assert!(worktree_status(&wt_dir).unwrap().locked);
        fs::remove_dir_all(&wt_dir).unwrap();
        fs::remove_dir_all(&base).unwrap();
    }

    fn temp_repo(tag: &str) -> (std::path::PathBuf, Repository) {
        let dir = std::env::temp_dir().join(format!("wf-git{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let repo = Repository::init(&dir).unwrap();
        (dir, repo)
    }

    #[test]
    fn folder_names_are_not_patterns() {
        let (base, repo) = temp_repo("pat");
        for name in ["we[ir]d", "!bang", "a*b"] {
            fs::create_dir_all(base.join(name)).unwrap();
            fs::write(base.join(name).join("f.txt"), "1").unwrap();
        }
        fs::create_dir_all(base.join("weid")).unwrap();
        fs::write(base.join("weid/f.txt"), "1").unwrap();
        commit_all(&repo, "init");
        for name in ["we[ir]d", "!bang", "a*b", "weid"] {
            fs::write(base.join(name).join("f.txt"), "2").unwrap();
        }
        for name in ["we[ir]d", "!bang", "a*b"] {
            let got = info(&base.join(name)).unwrap();
            assert_eq!(got.files.get("f.txt"), Some(&"modified"), "{name}");
            assert_eq!(got.changes, 1, "{name}");
        }
        commit_all(&repo, "edit");
        fs::remove_file(base.join("weid/f.txt")).unwrap();
        let top = info(&base).unwrap();
        assert_eq!(top.files.get("weid"), Some(&"changed"));
        assert_eq!(top.changes, 1);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn inside_an_untracked_folder_everything_is_untracked() {
        let (base, repo) = temp_repo("unt");
        fs::write(base.join("a.txt"), "1").unwrap();
        fs::write(base.join(".gitignore"), "*.log\n").unwrap();
        commit_all(&repo, "init");
        fs::create_dir_all(base.join("new/deeper")).unwrap();
        fs::write(base.join("new/x.txt"), "").unwrap();
        fs::write(base.join("new/deeper/y.txt"), "").unwrap();
        fs::write(base.join("new/z.log"), "").unwrap();
        let got = info(&base.join("new")).unwrap();
        assert_eq!(got.files.get("x.txt"), Some(&"untracked"));
        assert_eq!(got.files.get("deeper"), Some(&"untracked"));
        assert_eq!(got.files.get("z.log"), None);
        assert_eq!(got.files.get(""), None);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn switch_keeps_local_files_and_refuses_risky_repos() {
        let (base, repo) = temp_repo("sw");
        fs::write(base.join("a.txt"), "1").unwrap();
        fs::write(base.join(".gitignore"), "secret.env\n").unwrap();
        commit_all(&repo, "init");
        let main = repo.head().unwrap().shorthand().unwrap().to_string();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("other", &head, false).unwrap();
        repo.set_head("refs/heads/other").unwrap();
        // `other` tracks files that are untracked or ignored on main.
        fs::write(base.join("b.txt"), "theirs").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("b.txt")).unwrap();
        fs::write(base.join("secret.env"), "theirs").unwrap();
        index.add_path(Path::new("secret.env")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::now("t", "t@example.com").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "other", &tree, &[&head]).unwrap();
        switch(&base, &main).unwrap();
        assert!(!base.join("b.txt").exists());

        fs::write(base.join("b.txt"), "mine").unwrap();
        assert!(switch(&base, "other").is_err());
        assert_eq!(fs::read_to_string(base.join("b.txt")).unwrap(), "mine");
        fs::remove_file(base.join("b.txt")).unwrap();

        fs::write(base.join("secret.env"), "mine").unwrap();
        assert!(switch(&base, "other").is_err());
        assert_eq!(fs::read_to_string(base.join("secret.env")).unwrap(), "mine");
        fs::remove_file(base.join("secret.env")).unwrap();

        repo.set_head_detached(head.id()).unwrap();
        fs::write(base.join("a.txt"), "loose").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("a.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let loose = repo.commit(Some("HEAD"), &sig, &sig, "loose", &tree, &[&head]).unwrap();
        assert!(switch(&base, &main).unwrap_err().contains("no branch"));
        repo.set_head_detached(head.id()).unwrap();
        repo.checkout_head(Some(CheckoutBuilder::new().force())).unwrap();
        switch(&base, &main).unwrap();
        let _ = loose;

        fs::write(base.join(".gitattributes"), "*.bin filter=crypt\n").unwrap();
        assert!(switch(&base, "other").is_err());
        fs::remove_file(base.join(".gitattributes")).unwrap();
        repo.config().unwrap().set_bool("core.sparseCheckout", true).unwrap();
        assert!(switch(&base, "other").is_err());
        repo.config().unwrap().set_bool("core.sparseCheckout", false).unwrap();
        switch(&base, "other").unwrap();
        fs::remove_dir_all(&base).unwrap();
    }
}
