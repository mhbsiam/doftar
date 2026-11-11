//! Trash and permanent delete.

use super::*;

#[cfg(target_os = "macos")]
pub(super) fn trash_one(path: &str) -> Result<Option<String>, String> {
    use objc2::rc::Retained;
    use objc2_foundation::{NSFileManager, NSString, NSURL};

    guard::check(Path::new(path))?;
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    let mut resulting: Option<Retained<NSURL>> = None;
    NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&url, Some(&mut resulting))
        .map_err(|e| {
            // NSFeatureUnsupportedError. The volume has no Trash.
            if e.code() == 3328 {
                NO_TRASH.to_string()
            } else {
                e.localizedDescription().to_string()
            }
        })?;
    Ok(resulting.and_then(|u| u.path()).map(|p| p.to_string()))
}

pub(super) const NO_TRASH: &str = "its volume doesn't have a Trash";

#[cfg(not(target_os = "macos"))]
pub(super) fn trash_one(path: &str) -> Result<Option<String>, String> {
    guard::check(Path::new(path))?;
    trash::delete(path).map_err(|e| e.to_string())?;
    Ok(None)
}

#[tauri::command]
pub async fn trash_paths(paths: Vec<String>) -> Result<OpResult, String> {
    jobs::blocking(move || trash_paths_sync(&paths)).await
}

pub(super) fn trash_paths_sync(paths: &[String]) -> OpResult {
    let mut res = OpResult::default();
    for p in paths {
        match trash_one(p) {
            Ok(Some(trashed)) => res.inverse.push(Step::moved(trashed, p.clone())),
            Ok(None) => {}
            Err(e) if e == NO_TRASH => res.no_trash.push(p.clone()),
            Err(e) => res
                .errors
                .push(format!("\"{}\": {e}", label(Path::new(p)))),
        }
    }
    res
}

pub(super) fn remove_tree(path: &Path, job: &Job) -> std::io::Result<()> {
    if job.cancelled() {
        return Err(std::io::ErrorKind::Interrupted.into());
    }
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_dir() {
        return fs::remove_file(path);
    }
    for item in fs::read_dir(path)? {
        let item = item?;
        let p = item.path();
        job.set_current(&label(&p));
        remove_tree(&p, job)?;
    }
    fs::remove_dir(path)
}

#[tauri::command]
pub async fn delete_permanently(
    paths: Vec<String>,
    ids: Option<Vec<Option<String>>>,
    job_id: u64,
    on_progress: Channel<Progress>,
) -> Result<OpResult, String> {
    jobs::blocking(move || {
        let job = jobs::begin(job_id, on_progress);
        delete_permanently_sync(&paths, ids.as_deref(), &job)
    })
    .await
}

/// A `.git` holds history that nothing else has. It may only go to the Trash.
/// A `.git` already in a Trash may be deleted.
pub(super) fn keeps_history(path: &Path) -> Result<(), String> {
    let in_trash = path.components().any(|c| matches!(c.as_os_str().to_str(), Some(".Trash" | ".Trashes")));
    if !in_trash && label(path).eq_ignore_ascii_case(".git") {
        return Err("a repository's .git can't be deleted permanently; move it to the Trash instead".into());
    }
    Ok(())
}

/// `ids` are the `item_ids` of `paths` at confirmation. Keep an item that was replaced since.
pub(super) fn delete_permanently_sync(paths: &[String], ids: Option<&[Option<String>]>, job: &JobGuard) -> OpResult {
    job.set_items_total(paths.len());
    let mut res = OpResult::default();
    for (i, p) in paths.iter().enumerate() {
        if job.cancelled() {
            res.cancelled = true;
            break;
        }
        let path = Path::new(p);
        job.set_current(&label(path));
        let id = ids.and_then(|ids| ids.get(i)).cloned().flatten();
        // Remove a locked item as Empty Trash does.
        match same_item(p, &id)
            .and_then(|()| guard::check(path))
            .and_then(|()| keeps_history(path))
            .map_err(std::io::Error::other)
            .and_then(|()| crate::trash::retry_unlocked(path, || remove_tree(path, job)))
        {
            Ok(()) => {}
            Err(_) if job.cancelled() => {
                res.cancelled = true;
                break;
            }
            Err(e) => res.errors.push(format!("\"{}\": {e}", label(path))),
        }
        job.item_done();
    }
    res
}

