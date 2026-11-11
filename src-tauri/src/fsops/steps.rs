//! Undo steps, rename and creating items.

use super::*;

/// True for a case-only rename on a case-insensitive volume, where `to` already is the file.
/// On a case-sensitive volume the two names are distinct files.
pub(super) fn same_file_case_only(from: &Path, to: &Path) -> bool {
    match (fs::symlink_metadata(from), fs::symlink_metadata(to)) {
        // A file with other hard links needs matching letters.
        // APFS also ignores Unicode normalization, which lowercasing does not.
        (Ok(a), Ok(b)) if a.dev() == b.dev() && a.ino() == b.ino() => {
            a.is_dir() || a.nlink() == 1 || path_str(from).to_lowercase() == path_str(to).to_lowercase()
        }
        _ => false,
    }
}

/// A case-only rename may land on itself. Any other rename must not overwrite.
pub(super) fn rename_new(from: &Path, to: &Path) -> std::io::Result<()> {
    if same_file_case_only(from, to) {
        fs::rename(from, to)
    } else {
        rename_excl(from, to)
    }
}

pub(super) fn move_exact(from: &Path, to: &Path, job: &Job) -> Result<(), String> {
    guard::check(from)?;
    if exists(to) && !same_file_case_only(from, to) {
        return Err(format!("An item named \"{}\" already exists", label(to)));
    }
    if !exists(from) {
        return Err("it is no longer there".to_string());
    }
    match rename_new(from, to) {
        Ok(()) => Ok(()),
        Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {
            let dir = to.parent().ok_or_else(|| "invalid destination".to_string())?;
            let partial = partial_path(dir);
            let done = copy_verified(from, &partial, job).and_then(|rev| rename_excl(&partial, to).map(|()| rev));
            let original = match done {
                Ok(rev) => rev,
                Err(e) => {
                    remove_path(&partial);
                    return Err(strerr(e));
                }
            };
            if tree_revision(from).ok().as_ref() != Some(&original) {
                return Err("copied, but the original changed meanwhile, so it was kept too".to_string());
            }
            remove_path_checked(from).map_err(strerr)
        }
        Err(e) => Err(strerr(e)),
    }
}

pub(super) fn same_item(path: &str, id: &Option<String>) -> Result<(), String> {
    match id {
        Some(id) if exists(Path::new(path)) && jobs::file_id(Path::new(path)).as_ref() != Some(id) => {
            Err("it has been replaced by another item since".to_string())
        }
        _ => Ok(()),
    }
}

pub(super) fn apply_step(step: &Step, job: &Job) -> Result<Option<Step>, String> {
    match step {
        Step::Move { from, to, id } => {
            same_item(from, id)?;
            move_exact(Path::new(from), Path::new(to), job)?;
            Ok(Some(Step::moved(to.clone(), from.clone())))
        }
        Step::Copy { from, to } => {
            if exists(Path::new(to)) {
                return Err(format!(
                    "An item named \"{}\" already exists",
                    label(Path::new(to))
                ));
            }
            copy_item(Path::new(from), Path::new(to), job).map_err(|e| {
                if e.kind() != std::io::ErrorKind::AlreadyExists {
                    remove_path(Path::new(to));
                }
                strerr(e)
            })?;
            Ok(Some(Step::trash(to.clone())))
        }
        Step::Trash { path, id } => {
            same_item(path, id)?;
            match trash_one(path) {
                Ok(trashed) => Ok(trashed.map(|t| Step::moved(t, path.clone()))),
                // No Trash on the volume. Set the item aside for redo.
                Err(e) if e == NO_TRASH => {
                    let aside = set_aside(Path::new(path)).map_err(strerr)?;
                    Ok(Some(Step::moved(path_str(&aside), path.clone())))
                }
                Err(e) => Err(e),
            }
        }
    }
}

pub(super) fn run_steps(steps: &[Step], job: &JobGuard) -> OpResult {
    job.set_items_total(steps.len());
    jobs::start_scan(
        job,
        steps
            .iter()
            .filter_map(|s| match s {
                Step::Copy { from, .. } => Some(from.clone()),
                _ => None,
            })
            .collect(),
        None,
    );
    let mut res = OpResult::default();
    for (i, step) in steps.iter().enumerate() {
        if job.cancelled() {
            res.cancelled = true;
            res.left = steps[i..].to_vec();
            break;
        }
        let (Step::Move { to: subject, .. } | Step::Copy { to: subject, .. } | Step::Trash { path: subject, .. }) =
            step;
        job.set_current(&label(Path::new(subject)));
        match apply_step(step, job) {
            Ok(Some(inverse)) => res.inverse.push(inverse),
            Ok(None) => {}
            Err(_) if job.cancelled() => {
                res.cancelled = true;
                res.left = steps[i..].to_vec();
                break;
            }
            Err(e) => {
                res.errors.push(format!("\"{}\": {e}", label(Path::new(subject))));
                res.failed.push(step.clone());
            }
        }
        job.item_done();
    }
    res.inverse.reverse();
    res
}

#[tauri::command]
pub async fn apply_steps(
    steps: Vec<Step>,
    job_id: u64,
    on_progress: Channel<Progress>,
) -> Result<OpResult, String> {
    jobs::blocking(move || {
        let job = jobs::begin(job_id, on_progress);
        run_steps(&steps, &job)
    })
    .await
}

pub(super) fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." {
        return Err(format!("\"{name}\" isn't a valid name"));
    }
    if name.contains('/') || name.contains(':') || name.contains('\0') {
        return Err("A name can't contain a slash (/) or colon (:)".to_string());
    }
    if name.len() > 255 {
        return Err("That name is too long".to_string());
    }
    Ok(())
}

#[tauri::command(async)]
/// True when another item holds the name, by the volume's own rules for case and Unicode spelling.
pub fn rename_taken(from: String, to: String) -> bool {
    let dest = Path::new(&to);
    exists(dest) && !same_file_case_only(Path::new(&from), dest)
}

#[tauri::command(async)]
/// Returns the step that undoes the rename.
pub fn rename_path(from: String, to: String) -> Result<Step, String> {
    let dest = Path::new(&to);
    validate_name(&label(dest))?;
    if Path::new(&from).parent() != dest.parent() {
        return Err("A name can't contain a slash (/) or colon (:)".to_string());
    }
    if rename_taken(from.clone(), to.clone()) {
        let name = dest
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        return Err(format!("An item named \"{}\" already exists", name));
    }
    guard::check(Path::new(&from)).map_err(|e| format!("\"{}\": {e}", label(Path::new(&from))))?;
    rename_new(Path::new(&from), dest).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            format!("An item named \"{}\" already exists", label(dest))
        } else {
            strerr(e)
        }
    })?;
    Ok(Step::moved(to, from))
}

#[tauri::command(async)]
/// Returns the step that undoes the new folder.
pub fn create_dir(parent: String) -> Result<Step, String> {
    let p = Path::new(&parent);
    let name = unique_name(p, "New folder", "");
    let full = p.join(&name);
    fs::create_dir(&full).map_err(strerr)?;
    Ok(Step::trash(path_str(&full)))
}

#[tauri::command(async)]
/// Returns the step that undoes the new file.
pub fn create_file(parent: String) -> Result<Step, String> {
    let p = Path::new(&parent);
    let name = unique_name(p, "New Text Document", ".txt");
    let full = p.join(&name);
    // `create_new` fails on a symlink in the way. It does not write through it.
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&full)
        .map_err(strerr)?;
    Ok(Step::trash(path_str(&full)))
}

/// Writes `text` to a new file `<base><ext>` in `parent`. Numbers the name if taken. Returns the path.
#[tauri::command]
pub async fn create_text_file(parent: String, base: String, ext: String, text: String) -> Result<String, String> {
    jobs::blocking(move || {
        use std::io::Write;
        // Accept a name only. A path such as "../x" can escape `parent`.
        validate_name(&format!("{base}{ext}"))?;
        let p = Path::new(&parent);
        let full = p.join(unique_name(p, &base, &ext));
        // Check the new file, not `parent`. Home folders such as Downloads are protected.
        guard::check(&full)?;
        let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&full).map_err(strerr)?;
        f.write_all(text.as_bytes()).map_err(strerr)?;
        Ok(path_str(&full))
    })
    .await?
}

