//! .docx text for Compare: one line per paragraph, with all tracked changes accepted.
//! Insertions stay. Deleted and moved-away text goes. A paragraph with a deleted mark joins the next.
//! Formatting and comments are not read.

use std::fs;
use std::io::{BufReader, Read};
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;

/// Read at most this much of `word/document.xml`. This stops a zip bomb.
const MAX_XML_BYTES: u64 = 64 * 1024 * 1024;

fn final_text(xml: &str) -> Result<String, String> {
    let mut reader = Reader::from_str(xml);
    let mut out = String::new();
    // Depth inside <w:del> or <w:moveFrom> (text is gone once accepted) or <mc:Fallback> (an old copy of a text box).
    let mut deleted = 0usize;
    let mut in_text = false;
    let mut in_ppr = false;
    // The paragraph mark is deleted, so the paragraph joins the next.
    let mut joins_next = false;
    loop {
        let ev = reader.read_event().map_err(|e| format!("it can't be read as a Word document ({e})"))?;
        match ev {
            Event::Start(e) => match e.local_name().as_ref() {
                "del" | "moveFrom" if in_ppr => joins_next = true,
                "del" | "moveFrom" | "Fallback" => deleted += 1,
                "t" => in_text = true,
                "pPr" => in_ppr = true,
                _ => {}
            },
            Event::Empty(e) => match e.local_name().as_ref() {
                "del" | "moveFrom" if in_ppr => joins_next = true,
                "tab" if deleted == 0 && !in_ppr => out.push('\t'),
                "br" | "cr" if deleted == 0 => out.push('\n'),
                _ => {}
            },
            Event::End(e) => match e.local_name().as_ref() {
                "del" | "moveFrom" if !in_ppr => deleted = deleted.saturating_sub(1),
                "Fallback" => deleted = deleted.saturating_sub(1),
                "t" => in_text = false,
                "pPr" => in_ppr = false,
                "p" if deleted > 0 => {}
                "p" => {
                    let joins = std::mem::take(&mut joins_next);
                    if !joins {
                        out.push('\n');
                    }
                }
                _ => {}
            },
            Event::Text(t) if in_text && deleted == 0 => out.push_str(&t.xml10_content()),
            Event::GeneralRef(r) if in_text && deleted == 0 => {
                if let Ok(Some(c)) = r.resolve_char_ref() {
                    out.push(c);
                } else if let Some(s) = quick_xml::escape::resolve_predefined_entity(&r.xml10_content()) {
                    out.push_str(s);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(out)
}

fn read_docx_sync(path: &Path) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if crate::thumbs::is_dataless(&meta) {
        return Err("the file is not downloaded".into());
    }
    let f = BufReader::new(fs::File::open(path).map_err(|e| e.to_string())?);
    let mut zip = zip::ZipArchive::new(f).map_err(|_| "it isn't a Word document".to_string())?;
    let part = zip.by_name("word/document.xml").map_err(|_| "it isn't a Word document".to_string())?;
    let mut xml = String::new();
    part.take(MAX_XML_BYTES + 1)
        .read_to_string(&mut xml)
        .map_err(|_| "it can't be read as a Word document".to_string())?;
    if xml.len() as u64 > MAX_XML_BYTES {
        return Err("the document is too large to compare".into());
    }
    final_text(&xml)
}

#[tauri::command]
pub async fn read_docx_text(path: String) -> Result<String, String> {
    if crate::watcher::is_ejecting(&path) {
        return Err("volume is being ejected".to_string());
    }
    crate::jobs::blocking(move || read_docx_sync(Path::new(&path))).await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn body(paras: &str) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{paras}</w:body></w:document>"#
        )
    }

    #[test]
    fn accepts_insertions_and_drops_deletions() {
        let xml = body(
            r#"<w:p><w:r><w:t xml:space="preserve">The fee is </w:t></w:r><w:del w:id="1" w:author="A"><w:r><w:delText>ten</w:delText></w:r></w:del><w:ins w:id="2" w:author="B"><w:r><w:t>twelve</w:t></w:r></w:ins><w:r><w:t xml:space="preserve"> dollars.</w:t></w:r></w:p><w:p><w:r><w:t>Next</w:t></w:r></w:p>"#,
        );
        assert_eq!(final_text(&xml).unwrap(), "The fee is twelve dollars.\nNext\n");
    }

    #[test]
    fn moved_text_lands_once_and_deleted_marks_join_paragraphs() {
        let xml = body(
            r#"<w:p><w:pPr><w:rPr><w:del w:id="3" w:author="A"/></w:rPr></w:pPr><w:r><w:t>One</w:t></w:r></w:p><w:p><w:moveFrom w:id="4"><w:r><w:t>Gone</w:t></w:r></w:moveFrom><w:r><w:t xml:space="preserve"> two</w:t></w:r><w:moveTo w:id="5"><w:r><w:t xml:space="preserve"> moved</w:t></w:r></w:moveTo></w:p>"#,
        );
        assert_eq!(final_text(&xml).unwrap(), "One two moved\n");
    }

    #[test]
    fn text_box_text_is_read_once() {
        let box_para = |w: &str| format!(r#"<w:txbxContent><w:p><w:r><w:t>{w}</w:t></w:r></w:p></w:txbxContent>"#);
        let xml = body(&format!(
            r#"<w:p><w:r><w:t xml:space="preserve">Before </w:t></w:r><w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="wps"><w:drawing>{}</w:drawing></mc:Choice><mc:Fallback><w:pict>{}</w:pict></mc:Fallback></mc:AlternateContent></w:r><w:r><w:t xml:space="preserve"> after</w:t></w:r></w:p>"#,
            box_para("Draft"),
            box_para("Draft")
        ));
        assert_eq!(final_text(&xml).unwrap(), "Before Draft\n after\n");
    }

    #[test]
    fn tabs_breaks_and_entities() {
        let xml = body(r#"<w:p><w:r><w:t>A&amp;B</w:t><w:tab/><w:t>C&#233;</w:t><w:br/><w:t>D</w:t></w:r></w:p>"#);
        assert_eq!(final_text(&xml).unwrap(), "A&B\tCé\nD\n");
    }

    #[test]
    fn reads_a_docx_file_and_rejects_other_zips() {
        let dir = std::env::temp_dir().join(format!("doftar-docx-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let write = |name: &str, part: &str, xml: &str| {
            let p = dir.join(name);
            let mut zip = zip::ZipWriter::new(fs::File::create(&p).unwrap());
            let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            zip.start_file(part, opts).unwrap();
            zip.write_all(xml.as_bytes()).unwrap();
            zip.finish().unwrap();
            p
        };
        let doc = write("a.docx", "word/document.xml", &body(r#"<w:p><w:r><w:t>Hi</w:t></w:r></w:p>"#));
        assert_eq!(read_docx_sync(&doc).unwrap(), "Hi\n");
        let other = write("b.docx", "other.xml", "<x/>");
        assert!(read_docx_sync(&other).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }
}
