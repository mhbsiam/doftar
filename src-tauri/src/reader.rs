//! Doftar's reader: one window that shows Markdown formatted (following
//! links between documents), plain text wrapped, and source code coloured by
//! language. Like the image viewer, the window is made hidden at launch and
//! hidden again on close, so a document opens without waiting for a webview
//! to start.

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, WebviewWindow, Window};

use crate::markdown::{self, Node};
use crate::fly::{Landing, Picture};
use crate::zoom::CssRect;

/// The icon of the file last opened from a listing, as the listing drew it
/// (SVG), with the file's path: for flying it back on closing, as long as
/// the page still shows that file.
static ICON: Mutex<Option<(String, Vec<u8>)>> = Mutex::new(None);

pub const LABEL: &str = "reader";

/// Markdown, shown formatted; keep in step with `MARKDOWN_EXTS` in src/util/kinds.ts.
const MARKDOWN_EXTS: &[&str] = &["md", "markdown", "mdown", "mkd", "mkdn", "mdwn"];
/// Plain text, shown wrapped; keep in step with `TEXT_EXTS` in src/util/kinds.ts.
const TEXT_EXTS: &[&str] = &["txt", "text", "log"];
/// Larger files are left to an editor.
const MAX_BYTES: u64 = 8 * 1024 * 1024;
/// How much of a file is looked at to tell text from binary.
const SNIFF_BYTES: usize = 8192;

/// The highlighter's language for source code with extension `ext`; keep in
/// step with `CODE_EXTS` in src/util/kinds.ts.
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

/// How the reader shows a kind of file.
#[derive(Debug, PartialEq)]
enum Kind {
    Markdown,
    Text,
    Code(&'static str),
}

fn kind_of(p: &Path) -> Option<Kind> {
    let ext = p.extension()?.to_str()?.to_ascii_lowercase();
    if MARKDOWN_EXTS.contains(&ext.as_str()) {
        Some(Kind::Markdown)
    } else if TEXT_EXTS.contains(&ext.as_str()) {
        Some(Kind::Text)
    } else {
        code_lang(&ext).map(Kind::Code)
    }
}

/// Held while the window is looked up, made or marked ready, so an open never
/// slips between the page starting to listen and taking what it missed.
static OPENING: Mutex<()> = Mutex::new(());
/// Set once the page listens for `reader:open`; until then opens wait in `windows`.
static READY: AtomicBool = AtomicBool::new(false);
/// Bumped on every open, so a close's zoom never hides a reopened window and
/// a fallback show never shows one closed since.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Makes the (hidden) reader window. Callers hold `OPENING`.
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

/// Makes the reader window ahead of time, hidden, so the first document
/// opens without waiting for a webview to start.
pub fn prewarm(app: &AppHandle) {
    let _guard = OPENING.lock().unwrap();
    if app.get_webview_window(LABEL).is_none() {
        let _ = build(app);
    }
}

/// Shows `path` in the reader window, making the window if it isn't there.
/// The window shows at once, zooming in while the page draws the document,
/// as the image viewer's does; a page still starting up shows it itself.
/// `from` is where the calling page draws the file's icon; the window zooms
/// up from near it.
#[tauri::command]
pub async fn open_reader(
    app: AppHandle,
    window: WebviewWindow,
    path: String,
    from: Option<CssRect>,
    icon: Option<String>,
) -> Result<bool, String> {
    let msg = serde_json::json!({ "path": path });
    let icon = from
        .filter(|_| !crate::zoom::reduce_motion())
        .and(icon)
        .filter(|svg| !svg.is_empty())
        .map(String::into_bytes);
    let flown = icon.is_some();
    *ICON.lock().unwrap() = icon.clone().map(|i| (path.clone(), i));
    crate::fly::set_opener(LABEL, from.map(|_| window.label().to_string()));
    let _guard = OPENING.lock().unwrap();
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let win = match app.get_webview_window(LABEL) {
        Some(win) => win,
        None => build(&app)?,
    };
    // Flies the icon in with the window fading up under it, or else zooms
    // the window up from near the icon.
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

/// Called by the page once it listens for `reader:open`; returns a document
/// asked for before then. Async so it never waits on the main thread while
/// `build` holds the lock there.
#[tauri::command(async)]
pub fn reader_ready() -> Option<serde_json::Value> {
    let _guard = OPENING.lock().unwrap();
    READY.store(true, Ordering::SeqCst);
    crate::windows::take(LABEL)
}

/// Closing zooms the window out and hides it, so the next document opens at
/// once; the page drops what it showed. A document opened meanwhile keeps
/// it up. Runs on the main thread.
pub fn close_requested(win: &Window) {
    crate::fly::cancel();
    // A close is a new turn too, so a pending fallback show from the last
    // open doesn't bring the window back up.
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let still_closing = move || GENERATION.load(Ordering::SeqCst) == generation;
    let hidden = |w: &Window| {
        let _ = w.emit_to(LABEL, "reader:hidden", ());
    };
    // The icon condenses out of the page and flies back to its row, when
    // the listing still shows it.
    let shown = crate::fly::shown_path(LABEL);
    let picture = ICON
        .lock()
        .unwrap()
        .clone()
        .filter(|(path, _)| shown.as_deref() == Some(path.as_str()))
        .map(|(_, icon)| Picture::Icon(icon));
    if !crate::fly::fly_back(win, picture, Landing::Badge, still_closing, hidden) {
        crate::zoom::hide(win, still_closing, hidden);
    }
}

/// The window went away (its page will start over when it is made again).
pub fn forget() {
    READY.store(false, Ordering::SeqCst);
}

/// What the page draws.
#[derive(serde::Serialize, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Body {
    Markdown { blocks: Vec<Node> },
    Text { text: String },
    Code { lang: &'static str, text: String },
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    #[serde(flatten)]
    body: Body,
    /// Last modified, in milliseconds since 1970, to tell when it changes.
    modified: f64,
}

/// The file at `path`, read for the reader.
#[tauri::command]
pub async fn read_document(path: String) -> Result<Document, String> {
    if crate::watcher::is_ejecting(&path) {
        return Err("volume is being ejected".to_string());
    }
    crate::jobs::blocking(move || read(Path::new(&path))).await?
}

/// Whether the start of `path` reads as text, so a file whose extension is
/// shared with a binary format (a .ts video) goes to its app instead.
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

/// `bytes` as text: UTF-8, or UTF-16 with a byte order mark. A NUL early on
/// marks a binary file.
fn decode(bytes: &[u8]) -> Result<String, String> {
    let utf16 = |rest: &[u8], little: bool| {
        let units: Vec<u16> = rest
            .chunks_exact(2)
            .map(|c| {
                if little {
                    u16::from_le_bytes([c[0], c[1]])
                } else {
                    u16::from_be_bytes([c[0], c[1]])
                }
            })
            .collect();
        String::from_utf16_lossy(&units)
    };
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
    if meta.len() > MAX_BYTES {
        return Err("the file is too large to show".into());
    }
    let text = decode(&fs::read(path).map_err(|e| e.to_string())?)?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_millis() as f64);
    let body = match kind {
        Kind::Markdown => Body::Markdown { blocks: markdown::parse(&text) },
        Kind::Text => Body::Text { text },
        Kind::Code(lang) => Body::Code { lang, text },
    };
    Ok(Document { body, modified })
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

        // An MPEG transport stream shares TypeScript's extension.
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
