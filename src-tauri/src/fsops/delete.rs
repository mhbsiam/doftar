//! Trash and permanent delete.

use super::*;

#[cfg(target_os = "macos")]
pub(super) fn trash_one(path: &str) -> Result<Option<String>, String> {
    use objc2::rc::Retained;
    use objc2_foundation::{NSFileManager, NSString, NSURL};

    guard::check(&crate::paths::real(path))?;
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
    // Decode once: a bridge string may hold private-use chars for bytes that are not UTF-8,
    // and canonicalize, trash and the trashinfo lookup all need the real path.
    let src = crate::paths::real(path);
    guard::check(&src)?;
    let canon = fs::canonicalize(&src).ok();
    trash::delete(&src).map_err(|e| e.to_string())?;
    Ok(find_trashed(&src, canon.as_deref()))
}

/// `%XX` decoding for the `Path=` line of a `.trashinfo` file.
#[cfg(not(target_os = "macos"))]
fn unescape(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(h) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(h);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The freedesktop trash records each item's origin in `info/<name>.trashinfo`.
/// The newest record naming `src` (or its canonical form) tells where it landed.
#[cfg(not(target_os = "macos"))]
fn find_trashed(src: &Path, canon: Option<&Path>) -> Option<String> {
    let uid = unsafe { libc::getuid() };
    let mut infos = Vec::new();
    if let Ok(t) = crate::trash::user_trash() {
        infos.push(t.with_file_name("info"));
    }
    for vol in crate::trash::volume_roots() {
        infos.push(vol.join(format!(".Trash-{uid}/info")));
    }
    let matches = |info: &Path| -> Option<PathBuf> {
        let text = fs::read_to_string(info).ok()?;
        let origin = text
            .lines()
            .find_map(|l| l.strip_prefix("Path=").map(unescape))?;
        let origin = crate::paths::real(&origin);
        if !(origin == src || canon.is_some_and(|c| origin == c)) {
            return None;
        }
        let stem = info.file_name()?.to_string_lossy().strip_suffix(".trashinfo")?.to_string();
        Some(info.parent()?.parent()?.join("files").join(stem))
    };
    infos
        .iter()
        .filter_map(|d| fs::read_dir(d).ok())
        .flatten()
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if !p.extension().is_some_and(|x| x == "trashinfo") {
                return None;
            }
            let t = matches(&p)?;
            let at = e.metadata().ok()?.modified().ok()?;
            Some((at, t))
        })
        .max_by_key(|(t, _)| *t)
        .map(|(_, t)| crate::paths::encode(&t))
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
                .push(format!("\"{}\": {e}", label(&(crate::paths::real(p))))),
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
    let in_trash = path.components().any(|c| {
        let s = c.as_os_str().to_str();
        matches!(s, Some(".Trash" | ".Trashes"))
            // A drive's freedesktop Trash is .Trash-<uid>. On macOS that name is an ordinary folder.
            || (cfg!(not(target_os = "macos")) && s.is_some_and(|s| s.starts_with(".Trash-")))
    });
    #[cfg(not(target_os = "macos"))]
    let in_trash = in_trash || crate::trash::user_trash().ok().is_some_and(|t| path.starts_with(t));
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
        let path = crate::paths::real(p);
        job.set_current(&label(&(path)));
        let id = ids.and_then(|ids| ids.get(i)).cloned().flatten();
        // Remove a locked item as Empty Trash does.
        match same_item(p, &id)
            .and_then(|()| guard::check(&(path)))
            .and_then(|()| keeps_history(&(path)))
            .map_err(std::io::Error::other)
            .and_then(|()| crate::trash::retry_unlocked(&(path), || remove_tree(&(path), job)))
        {
            Ok(()) => {}
            Err(_) if job.cancelled() => {
                res.cancelled = true;
                break;
            }
            Err(e) => res.errors.push(format!("\"{}\": {e}", label(&(path)))),
        }
        job.item_done();
    }
    res
}


#[cfg(test)]
mod tests {
    use super::keeps_history;
    use std::path::Path;

    #[test]
    fn git_may_go_only_from_a_trash() {
        assert!(keeps_history(Path::new("/Users/a/repo/.git")).is_err());
        assert!(keeps_history(Path::new("/Users/a/.Trash/repo/.git")).is_ok());
        assert!(keeps_history(Path::new("/Volumes/X/.Trashes/501/repo/.git")).is_ok());
        // .Trash-<uid> is a Trash only on Linux.
        let drive_trash = keeps_history(Path::new("/Volumes/X/.Trash-1000/files/repo/.git"));
        assert_eq!(drive_trash.is_ok(), cfg!(not(target_os = "macos")));
    }
}
