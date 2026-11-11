//! The reader window. It is made hidden at launch and hidden again on close.
//! A document then opens without waiting for a webview to start.

use crate::lock::Locked;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, WebviewWindow, Window};

use crate::markdown::{self, Node};
use crate::fly::{Landing, Picture};
use crate::zoom::CssRect;

/// The SVG icon of the file last opened from a listing, with the file path. It flies back on close.
static ICON: Mutex<Option<(String, Vec<u8>)>> = Mutex::new(None);

pub const LABEL: &str = "reader";

/// Keep in step with `MARKDOWN_EXTS` in src/util/kinds.ts.
const MARKDOWN_EXTS: &[&str] = &["md", "markdown", "mdown", "mkd", "mkdn", "mdwn"];
/// Keep in step with `TEXT_EXTS` in src/util/kinds.ts.
const TEXT_EXTS: &[&str] = &["txt", "text", "log"];
const MAX_BYTES: u64 = 8 * 1024 * 1024;
/// Notebooks hold their plots, so they can be bigger.
const MAX_NOTEBOOK_BYTES: u64 = 64 * 1024 * 1024;
const SNIFF_BYTES: usize = 8192;

/// Keep in step with `CODE_EXTS` in src/util/kinds.ts.
fn code_lang(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "py" | "pyw" | "pyi" => "python",
        "js" | "mjs" | "cjs" | "jsx" => "javascript",
        "ts" | "mts" | "cts" | "tsx" => "typescript",
        "json" | "jsonc" => "json",
        "css" => "css",
        "scss" => "scss",
        "less" => "less",
        "xml" => "xml",
        "yaml" | "yml" => "yaml",
        "toml" | "ini" | "cfg" | "conf" | "properties" => "ini",
        "sh" | "bash" | "zsh" | "ksh" => "bash",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" | "hh" | "hxx" => "cpp",
        "m" | "mm" => "objectivec",
        "cs" => "csharp",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "swift" => "swift",
        "go" => "go",
        "rs" => "rust",
        "rb" => "ruby",
        "php" => "php",
        "pl" | "pm" => "perl",
        "lua" => "lua",
        "r" => "r",
        "sql" => "sql",
        "graphql" | "gql" => "graphql",
        "diff" | "patch" => "diff",
        "mk" => "makefile",
        "vb" => "vbnet",
        _ => return None,
    })
}

#[derive(Debug, PartialEq)]
enum Kind {
    Markdown,
    Text,
    Code(&'static str),
    Notebook,
    Data(crate::data::Data),
}

fn kind_of(p: &Path) -> Option<Kind> {
    let ext = p.extension()?.to_str()?.to_ascii_lowercase();
    if MARKDOWN_EXTS.contains(&ext.as_str()) {
        Some(Kind::Markdown)
    } else if TEXT_EXTS.contains(&ext.as_str()) {
        Some(Kind::Text)
    } else if ext == "ipynb" {
        Some(Kind::Notebook)
    } else {
        code_lang(&ext)
            .map(Kind::Code)
            .or_else(|| crate::data::kind_of(&ext).map(Kind::Data))
    }
}

/// Hold while the window is looked up, made or marked ready. An open must not happen between the page listening and taking missed opens.
static OPENING: Mutex<()> = Mutex::new(());
/// Until the page listens for `reader:open`, opens wait in `windows`.
static READY: AtomicBool = AtomicBool::new(false);
/// Changes on every open and close. A late zoom or fallback show checks it.
static GENERATION: AtomicU64 = AtomicU64::new(0);
static DIRTY: AtomicBool = AtomicBool::new(false);
static NEXT_TMP: AtomicU64 = AtomicU64::new(1);
/// The files the reader window may read and save. Rust holds this list, so a hostile page cannot read other files.
static FILES: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());
/// The only links `open_web_link` opens.
static URLS: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

fn grant(path: &Path) {
    if let Ok(path) = fs::canonicalize(path) {
        FILES.locked().insert(path);
    }
}

/// Other windows have their own commands and checks.
pub fn check_granted(window: &str, path: &Path) -> Result<(), String> {
    let granted = || fs::canonicalize(path).is_ok_and(|p| FILES.locked().contains(&p));
    if window != LABEL || granted() {
        Ok(())
    } else {
        Err("the reader only opens documents it was given or that they link to".into())
    }
}

/// Resolve as `resolveHref` in MarkdownView.tsx does. Anchors and other schemes go nowhere.
#[derive(Debug, PartialEq)]
enum Link {
    Web(String),
    File(PathBuf),
}

fn link_target(href: &str, dir: &Path) -> Option<Link> {
    let h = href.trim();
    let scheme = h.split_once(':').map(|(s, _)| s).filter(|s| {
        s.starts_with(|c: char| c.is_ascii_alphabetic())
            && s.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    });
    let rel = match scheme.map(str::to_ascii_lowercase).as_deref() {
        Some("http" | "https" | "mailto") => return Some(Link::Web(h.to_string())),
        // `file://host/a/b` is `/a/b`, as `new URL` reads it.
        Some("file") => match h[5..].strip_prefix("//") {
            Some(rest) => &rest[rest.find('/')?..],
            None => &h[5..],
        },
        Some(_) => return None,
        None => h,
    };
    let rel = percent_decode(rel.split('#').next()?.split('?').next()?);
    if rel.is_empty() {
        return None;
    }
    Some(Link::File(if rel.starts_with('/') { PathBuf::from(rel) } else { dir.join(rel) }))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = b.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok());
        match (b[i], hex) {
            (b'%', Some(v)) => {
                out.push(v);
                i += 3;
            }
            (c, _) => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Grant linked files only if `files` is true. A document in another window grants no files.
fn grant_links(path: &Path, body: &Body, files: bool) {
    fn hrefs<'a>(v: &'a serde_json::Value, out: &mut Vec<&'a str>) {
        match v {
            serde_json::Value::Object(m) => {
                if let Some(serde_json::Value::String(h)) = m.get("href") {
                    out.push(h);
                }
                m.values().for_each(|v| hrefs(v, out));
            }
            serde_json::Value::Array(a) => a.iter().for_each(|v| hrefs(v, out)),
            _ => {}
        }
    }
    let (Some(dir), Ok(v)) = (path.parent(), serde_json::to_value(body)) else { return };
    let mut found = vec![];
    hrefs(&v, &mut found);
    for href in found {
        match link_target(href, dir) {
            Some(Link::Web(url)) => {
                URLS.locked().insert(url);
            }
            Some(Link::File(p)) if files => grant(&p),
            _ => {}
        }
    }
}

#[tauri::command]
pub fn open_web_link(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !URLS.locked().contains(&url) {
        return Err("not a link in this document".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Callers hold `OPENING`.
fn build(app: &AppHandle) -> Result<WebviewWindow, String> {
    let mut cfg = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or("no window config")?;
    cfg.label = LABEL.to_string();
    cfg.width = 880.0;
    cfg.height = 900.0;
    cfg.min_width = Some(420.0);
    cfg.min_height = Some(320.0);
    cfg.center = true;
    cfg.visible = false;
    cfg.transparent = false;
    cfg.window_effects = None;
    crate::webview::build(app, cfg)
}

pub fn prewarm(app: &AppHandle) {
    let _guard = OPENING.locked();
    if app.get_webview_window(LABEL).is_none() {
        let _ = build(app);
    }
}

/// `from` is where the calling page draws the file icon. The window zooms up from near it.
#[tauri::command]
pub async fn open_reader(
    app: AppHandle,
    window: WebviewWindow,
    path: String,
    from: Option<CssRect>,
    icon: Option<String>,
    edit: Option<bool>,
) -> Result<bool, String> {
    grant(Path::new(&path));
    let msg = serde_json::json!({ "path": path, "edit": edit.unwrap_or(false) });
    let icon = from
        .filter(|_| !crate::zoom::reduce_motion())
        .and(icon)
        .filter(|svg| !svg.is_empty())
        .map(String::into_bytes);
    let flown = icon.is_some();
    *ICON.locked() = icon.clone().map(|i| (path.clone(), i));
    crate::fly::set_opener(LABEL, from.map(|_| window.label().to_string()));
    let _guard = OPENING.locked();
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let win = match app.get_webview_window(LABEL) {
        Some(win) => win,
        None => build(&app)?,
    };
    let arrive = {
        let (w, source) = (win.clone(), window.clone());
        move |show: bool| {
            crate::fly::cancel();
            if let (Some(icon), Some(from)) = (icon, from) {
                let picture = Picture::Icon(icon);
                if crate::fly::fly_in(&w, &source, from, &picture, Landing::Badge) {
                    return;
                }
                let _ = source.emit_to(source.label(), "viewer:flown", ());
            }
            if let Some(from) = from {
                crate::zoom::aim(&w, &source, from);
            }
            if show {
                crate::zoom::show(&w);
            }
        }
    };
    if READY.load(Ordering::SeqCst) {
        win.emit_to(LABEL, "reader:open", msg).map_err(|e| e.to_string())?;
        let _ = win.run_on_main_thread(move || arrive(true));
    } else {
        crate::windows::stash(LABEL, msg);
        let w = win.clone();
        let _ = w.run_on_main_thread(move || arrive(false));
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(3));
            let current = GENERATION.load(Ordering::SeqCst) == generation;
            if current && !win.is_visible().unwrap_or(true) {
                let w = win.clone();
                let _ = win.run_on_main_thread(move || crate::zoom::show(&w));
            }
        });
    }
    Ok(flown)
}

/// Return the document asked for before the page listened. Async: the main thread can hold the lock in `build`.
#[tauri::command(async)]
pub fn reader_ready() -> Option<serde_json::Value> {
    let _guard = OPENING.locked();
    READY.store(true, Ordering::SeqCst);
    crate::windows::take(LABEL)
}

/// Run on the main thread. Unsaved edits make the page ask first.
pub fn close_requested(win: &Window) {
    if DIRTY.load(Ordering::SeqCst) {
        let _ = win.emit_to(LABEL, "reader:confirm-close", ());
        return;
    }
    crate::fly::cancel();
    FILES.locked().clear();
    URLS.locked().clear();
    // A close changes the generation too. A pending fallback show from the last open must not show the window.
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let still_closing = move || GENERATION.load(Ordering::SeqCst) == generation;
    let hidden = |w: &Window| {
        let _ = w.emit_to(LABEL, "reader:hidden", ());
    };
    let shown = crate::fly::shown_path(LABEL);
    let picture = ICON
        .locked()
        .clone()
        .filter(|(path, _)| shown.as_deref() == Some(path.as_str()))
        .map(|(_, icon)| Picture::Icon(icon));
    if !crate::fly::fly_back(win, picture, Landing::Badge, still_closing, hidden) {
        crate::zoom::hide(win, still_closing, hidden);
    }
}

pub fn forget() {
    READY.store(false, Ordering::SeqCst);
    DIRTY.store(false, Ordering::SeqCst);
}

#[derive(serde::Serialize, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Body {
    Markdown { blocks: Vec<Node> },
    Text { text: String },
    Code { lang: &'static str, text: String },
    Notebook(crate::notebook::Notebook),
    #[serde(untagged)]
    Data(Box<crate::data::Body>),
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    #[serde(flatten)]
    body: Body,
    modified: f64,
}

#[tauri::command]
pub async fn read_document(window: Window, path: String) -> Result<Document, String> {
    if crate::watcher::is_ejecting(&path) {
        return Err("volume is being ejected".to_string());
    }
    check_granted(window.label(), Path::new(&path))?;
    let reader = window.label() == LABEL;
    crate::jobs::blocking(move || {
        let doc = read(Path::new(&path))?;
        grant_links(Path::new(&path), &doc.body, reader);
        Ok(doc)
    })
    .await?
}

/// A .ts file can be video. Open it in its app if it is not text.
#[tauri::command]
pub async fn is_text_file(path: String) -> bool {
    crate::jobs::blocking(move || {
        use std::io::Read;
        let mut head = Vec::with_capacity(SNIFF_BYTES);
        fs::File::open(&path)
            .and_then(|f| f.take(SNIFF_BYTES as u64).read_to_end(&mut head))
            .is_ok_and(|_| decode(&head).is_ok())
    })
    .await
    .unwrap_or(false)
}

/// Drop a trailing odd byte.
fn utf16_units(bytes: &[u8], little: bool) -> Vec<u16> {
    bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&c| if little { u16::from_le_bytes(c) } else { u16::from_be_bytes(c) })
        .collect()
}

/// A NUL byte early on marks a binary file.
fn decode(bytes: &[u8]) -> Result<String, String> {
    let utf16 = |rest: &[u8], little: bool| String::from_utf16_lossy(&utf16_units(rest, little));
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return Ok(utf16(rest, true));
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return Ok(utf16(rest, false));
    }
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if bytes[..bytes.len().min(SNIFF_BYTES)].contains(&0) {
        return Err("it looks like a binary file".into());
    }
    Ok(String::from_utf8_lossy(bytes).into_owned())
}

fn read(path: &Path) -> Result<Document, String> {
    let kind = path
        .is_absolute()
        .then(|| kind_of(path))
        .flatten()
        .ok_or("Doftar's reader doesn't show this kind of file")?;
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if crate::thumbs::is_dataless(&meta) {
        return Err("the file is not downloaded".into());
    }
    let modified = modified_ms(&meta);
    // Read only the start of a data file.
    if let Kind::Data(data) = kind {
        return Ok(Document { body: Body::Data(Box::new(crate::data::read(path, data)?)), modified });
    }
    if meta.len() > if kind == Kind::Notebook { MAX_NOTEBOOK_BYTES } else { MAX_BYTES } {
        return Err("the file is too large to show".into());
    }
    let text = decode(&fs::read(path).map_err(|e| e.to_string())?)?;
    let body = match kind {
        Kind::Markdown => Body::Markdown { blocks: markdown::parse(&text) },
        Kind::Text => Body::Text { text },
        Kind::Code(lang) => Body::Code { lang, text },
        Kind::Notebook => Body::Notebook(crate::notebook::parse(&text)?),
        Kind::Data(_) => unreachable!("read above"),
    };
    Ok(Document { body, modified })
}

#[tauri::command]
pub fn reader_set_dirty(dirty: bool) {
    DIRTY.store(dirty, Ordering::SeqCst);
}

pub fn is_dirty() -> bool {
    DIRTY.load(Ordering::SeqCst)
}

fn modified_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_millis() as f64)
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    text: String,
    /// See `jobs::revision`. Send it back with a save.
    rev: String,
    /// Kept on save, like `crlf`.
    encoding: &'static str,
    crlf: bool,
}

/// Never decode lossily. The saved text must equal the shown text.
fn read_text_sync(path: &Path) -> Result<TextFile, String> {
    let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if crate::thumbs::is_dataless(&meta) {
        return Err("the file is not downloaded".into());
    }
    if meta.len() > MAX_BYTES {
        return Err("the file is too large to edit".into());
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let utf16 = bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]);
    let text = if utf16 {
        let (little, rest) = (bytes[0] == 0xFF, &bytes[2..]);
        if rest.len() % 2 != 0 {
            return Err("it isn't valid UTF-16 text".into());
        }
        String::from_utf16(&utf16_units(rest, little)).map_err(|_| "it isn't valid UTF-16 text")?
    } else {
        let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
        if bytes.contains(&0) {
            return Err("it looks like a binary file".into());
        }
        String::from_utf8(bytes.to_vec()).map_err(|_| "it isn't UTF-8 text")?
    };
    let crlf = text.contains("\r\n");
    Ok(TextFile { text, rev: crate::jobs::revision(&meta), encoding: Encoding::of(&bytes).label(), crlf })
}

#[tauri::command]
pub async fn read_text(window: Window, path: String) -> Result<TextFile, String> {
    if crate::watcher::is_ejecting(&path) {
        return Err("volume is being ejected".to_string());
    }
    check_granted(window.label(), Path::new(&path))?;
    crate::jobs::blocking(move || read_text_sync(Path::new(&path))).await?
}

/// How a text file is stored. A save writes it back the same way.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Encoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
}

impl Encoding {
    fn of(bytes: &[u8]) -> Self {
        if bytes.starts_with(&[0xFF, 0xFE]) {
            Self::Utf16Le
        } else if bytes.starts_with(&[0xFE, 0xFF]) {
            Self::Utf16Be
        } else if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
            Self::Utf8Bom
        } else {
            Self::Utf8
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Utf8 => "UTF-8",
            Self::Utf8Bom => "UTF-8 with BOM",
            Self::Utf16Le => "UTF-16 LE",
            Self::Utf16Be => "UTF-16 BE",
        }
    }

    fn encode(self, text: &str) -> Vec<u8> {
        match self {
            Self::Utf8 => text.as_bytes().to_vec(),
            Self::Utf8Bom => [&[0xEF, 0xBB, 0xBF][..], text.as_bytes()].concat(),
            Self::Utf16Le => [0xFF, 0xFE].into_iter().chain(text.encode_utf16().flat_map(u16::to_le_bytes)).collect(),
            Self::Utf16Be => [0xFE, 0xFF].into_iter().chain(text.encode_utf16().flat_map(u16::to_be_bytes)).collect(),
        }
    }
}

/// Keep the encoding, CRLF line endings and final newline of `old`. An empty `old` gives UTF-8, LF and a final newline.
fn saved_text(text: &str, old: &[u8]) -> Vec<u8> {
    let encoding = Encoding::of(old);
    // Only the line endings and the last character of `old` matter, so a lossy decode is fine.
    let old = decode(old).unwrap_or_default();
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut out = text.replace("\r\n", "\n").replace('\r', "\n");
    if !out.is_empty() && !out.ends_with('\n') && matches!(old.chars().last(), None | Some('\n' | '\r')) {
        out.push('\n');
    }
    if old.contains("\r\n") {
        out = out.replace('\n', "\r\n");
    }
    encoding.encode(&out)
}

/// Write beside the file, then swap. A failed save leaves the file as it was.
/// Refuse if the file changed since `rev`, unless `rev` is `None`.
fn write_text_sync(path: &Path, text: &str, rev: Option<&str>) -> Result<String, String> {
    if !path.is_absolute() {
        return Err("invalid path".into());
    }
    // Resolve the link. Keep the symlink in place.
    let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
    crate::guard::check(&path)?;
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    let unchanged = || match rev {
        Some(rev) if fs::metadata(&path).map(|m| crate::jobs::revision(&m)).ok().as_deref() != Some(rev) => {
            Err(CHANGED.to_string())
        }
        _ => Ok(()),
    };
    unchanged()?;
    let old = fs::read(&path).map_err(|e| e.to_string())?;
    let dir = path.parent().ok_or("invalid path")?;
    let name = path.file_name().ok_or("invalid path")?.to_string_lossy();
    let tmp = dir.join(format!(
        ".{name}.doftar-save-{}-{}",
        std::process::id(),
        NEXT_TMP.fetch_add(1, Ordering::Relaxed)
    ));
    let res = (|| {
        use std::io::Write;
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(&saved_text(text, &old)).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
        // Check again. The file can change during the write.
        unchanged()?;
        crate::imgedit::replace_file(&path, &tmp)
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res?;
    fs::metadata(&path).map(|m| crate::jobs::revision(&m)).map_err(|e| e.to_string())
}

const CHANGED: &str = "changed-on-disk";

#[tauri::command]
pub async fn write_text(window: Window, path: String, text: String, rev: Option<String>) -> Result<String, String> {
    if crate::watcher::is_ejecting(&path) {
        return Err("volume is being ejected".to_string());
    }
    check_granted(window.label(), Path::new(&path))?;
    crate::jobs::blocking(move || write_text_sync(Path::new(&path), &text, rev.as_deref())).await?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("doftar-reader-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_each_kind_its_own_way() {
        let dir = scratch("kinds");
        let md = dir.join("README.MD");
        fs::write(&md, "# Hi\n").unwrap();
        let doc = read(&md).unwrap();
        let Body::Markdown { blocks } = &doc.body else { panic!("{doc:?}") };
        assert!(matches!(&blocks[0], Node::Heading { level: 1, .. }));
        assert!(doc.modified > 0.0);

        let txt = dir.join("notes.txt");
        fs::write(&txt, "# Hi\n").unwrap();
        assert!(matches!(read(&txt).unwrap().body, Body::Text { text } if text == "# Hi\n"));
        let py = dir.join("tool.PY");
        fs::write(&py, "print(1)\n").unwrap();
        assert!(matches!(read(&py).unwrap().body, Body::Code { lang: "python", .. }));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn decodes_utf16_and_refuses_binary() {
        let dir = scratch("decode");
        let le = dir.join("le.txt");
        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend("hé".encode_utf16().flat_map(u16::to_le_bytes));
        fs::write(&le, bytes).unwrap();
        assert!(matches!(read(&le).unwrap().body, Body::Text { text } if text == "hé"));
        let bom = dir.join("bom.txt");
        fs::write(&bom, b"\xEF\xBB\xBFhi").unwrap();
        assert!(matches!(read(&bom).unwrap().body, Body::Text { text } if text == "hi"));

        // An MPEG transport stream has the TypeScript extension.
        let video = dir.join("clip.ts");
        fs::write(&video, [0x47, 0x40, 0x00, 0x10, 0x00, 0x00, 0xB0]).unwrap();
        assert!(read(&video).is_err());
        let is_text =
            |p: &Path| tauri::async_runtime::block_on(is_text_file(p.to_string_lossy().into()));
        assert!(!is_text(&video));
        assert!(is_text(&le));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn saves_text_safely() {
        // An empty file gets LF and a final newline.
        assert_eq!(saved_text("a\r\nb\rc", b""), b"a\nb\nc\n");
        assert_eq!(saved_text("\u{feff}x\n\n", b""), b"x\n\n");
        assert_eq!(saved_text("", b""), b"");
        // Otherwise keep the byte order mark, line endings and final newline.
        assert_eq!(saved_text("a\nb", b"\xEF\xBB\xBFold\r\n"), b"\xEF\xBB\xBFa\r\nb\r\n");
        assert_eq!(saved_text("a\nb", b"old\nfile\n"), b"a\nb\n");
        assert_eq!(saved_text("a\nb", b"old"), b"a\nb");
        // UTF-16 stays UTF-16, in its byte order.
        assert_eq!(saved_text("a\nb", b"\xFF\xFEo\0\r\0\n\0"), b"\xFF\xFEa\0\r\0\n\0b\0\r\0\n\0");
        assert_eq!(saved_text("a", b"\xFE\xFF\0o"), b"\xFE\xFF\0a");

        let dir = scratch("save");
        let f = dir.join("notes.md");
        fs::write(&f, b"\xEF\xBB\xBFold\r\n").unwrap();
        let read = read_text_sync(&f).unwrap();
        assert_eq!(read.text, "old\r\n");
        // A save follows the link.
        let link = dir.join("link.md");
        std::os::unix::fs::symlink(&f, &link).unwrap();
        let after = write_text_sync(&link, "new\r\nline", Some(&read.rev)).unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read(&f).unwrap(), b"\xEF\xBB\xBFnew\r\nline\r\n");
        assert_ne!(after, read.rev);
        // Refuse a changed file unless `rev` is `None`.
        assert_eq!(write_text_sync(&f, "x", Some(&read.rev)).unwrap_err(), CHANGED);
        // Refuse a replaced file with the same modified time.
        let other = dir.join("other.md");
        fs::write(&other, "other\n").unwrap();
        let other_file = fs::File::options().write(true).open(&other).unwrap();
        other_file.set_modified(fs::metadata(&f).unwrap().modified().unwrap()).unwrap();
        fs::rename(&other, &f).unwrap();
        assert_eq!(write_text_sync(&f, "x", Some(&after)).unwrap_err(), CHANGED);
        assert_eq!(fs::read_to_string(&f).unwrap(), "other\n");
        write_text_sync(&f, "x", None).unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "x\n");
        // No temporary file stays.
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);

        fs::write(&f, [0xC3, 0x28]).unwrap();
        assert!(read_text_sync(&f).is_err());
        fs::write(&f, [0xFF, 0xFE, b'h', 0, b'i', 0]).unwrap();
        assert_eq!(read_text_sync(&f).unwrap().text, "hi");
        // An unpaired surrogate or an odd trailing byte is not text.
        fs::write(&f, [0xFF, 0xFE, 0x00, 0xD8, b'a', 0]).unwrap();
        assert!(read_text_sync(&f).is_err());
        fs::write(&f, [0xFF, 0xFE, b'a', 0, 7]).unwrap();
        assert!(read_text_sync(&f).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn grants_only_what_documents_link_to() {
        let dir = scratch("grants");
        let (doc, other, secret) = (dir.join("a b.md"), dir.join("other.md"), dir.join("secret.yml"));
        fs::write(&doc, "[o](other.md#x) [w](https://example.com/p) [js](javascript:x()) [f](file:///etc/hosts)\n").unwrap();
        fs::write(&other, "").unwrap();
        fs::write(&secret, "").unwrap();
        let d = dir.as_path();
        assert_eq!(link_target("a%20b.md?x#y", d), Some(Link::File(d.join("a b.md"))));
        assert_eq!(link_target("file://host/a/b", d), Some(Link::File("/a/b".into())));
        assert_eq!(link_target("#top", d), None);
        assert_eq!(link_target("data:text/html,x", d), None);
        assert_eq!(link_target(" MailTo:x@y ", d), Some(Link::Web("MailTo:x@y".into())));

        grant(&doc);
        assert!(check_granted(LABEL, &doc).is_ok());
        assert!(check_granted(LABEL, &other).is_err());
        grant_links(&doc, &read(&doc).unwrap().body, true);
        assert!(check_granted(LABEL, &other).is_ok());
        assert!(check_granted(LABEL, Path::new("/etc/hosts")).is_ok());
        assert!(check_granted(LABEL, &secret).is_err());
        assert!(check_granted("main", &secret).is_ok());
        assert!(URLS.locked().contains("https://example.com/p"));
        assert!(!URLS.locked().iter().any(|u| u.starts_with("javascript")));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_preview_allows_its_web_links_but_grants_no_files() {
        let dir = scratch("preview");
        let (doc, linked) = (dir.join("preview.md"), dir.join("linked.md"));
        fs::write(&doc, "[l](linked.md) [w](https://example.com/preview)\n").unwrap();
        fs::write(&linked, "").unwrap();
        grant_links(&doc, &read(&doc).unwrap().body, false);
        assert!(URLS.locked().contains("https://example.com/preview"));
        assert!(check_granted(LABEL, &linked).is_err());
        assert!(check_granted(LABEL, &doc).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_only_files_it_knows() {
        let dir = scratch("refuse");
        let other = dir.join("photo.heic");
        fs::write(&other, "x").unwrap();
        assert!(read(&other).is_err());
        assert!(read(Path::new("relative.md")).is_err());
        fs::create_dir(dir.join("folder.md")).unwrap();
        assert!(read(&dir.join("folder.md")).is_err());
        assert!(read(&dir.join("missing.md")).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }
}
