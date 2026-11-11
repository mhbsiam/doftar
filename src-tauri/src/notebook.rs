//! Jupyter notebooks for the reader: formatted Markdown cells, code cells highlighted in the kernel language, saved outputs.
//! HTML and JavaScript outputs show plain text. Drawing their markup would run scripts.

use serde_json::Value;

use crate::markdown::{self, Node};

/// Cut an output past this size. A runaway loop log stays readable.
const MAX_OUTPUT_CHARS: usize = 200_000;

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Notebook {
    /// The highlighter name for the kernel language, for example "python".
    lang: String,
    cells: Vec<Cell>,
}

#[derive(serde::Serialize, Debug)]
#[serde(tag = "t", rename_all = "camelCase")]
enum Cell {
    Markdown { blocks: Vec<Node> },
    Code { source: String, count: Option<u64>, outputs: Vec<Output> },
    Raw { source: String },
}

#[derive(serde::Serialize, Debug)]
#[serde(tag = "t", rename_all = "camelCase")]
enum Output {
    Text { text: String, error: bool },
    /// Base64 for PNG and JPEG. The markup itself for SVG.
    Image { mime: &'static str, data: String },
    Markdown { blocks: Vec<Node> },
}

/// nbformat stores text as a string or as a list of lines.
fn text(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(lines)) => lines.iter().filter_map(Value::as_str).collect(),
        _ => String::new(),
    }
}

fn cut(mut s: String) -> String {
    if let Some((at, _)) = s.char_indices().nth(MAX_OUTPUT_CHARS) {
        s.truncate(at);
        s.push_str("\n… (output cut)");
    }
    s
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
        } else if chars.next() == Some('[') {
            // Parameters, then one final byte in @..~.
            for c in chars.by_ref() {
                if ('@'..='~').contains(&c) {
                    break;
                }
            }
        }
    }
    out
}

fn output(o: &Value) -> Option<Output> {
    match o.get("output_type")?.as_str()? {
        "stream" => Some(Output::Text {
            text: cut(strip_ansi(&text(o.get("text")))),
            error: o.get("name").and_then(Value::as_str) == Some("stderr"),
        }),
        "error" => {
            let trace: Vec<&str> = o
                .get("traceback")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            let text = if trace.is_empty() {
                format!("{}: {}", text(o.get("ename")), text(o.get("evalue")))
            } else {
                trace.join("\n")
            };
            Some(Output::Text { text: cut(strip_ansi(&text)), error: true })
        }
        "execute_result" | "display_data" => {
            let data = o.get("data")?;
            for mime in ["image/png", "image/jpeg"] {
                if let Some(v) = data.get(mime) {
                    let data = text(Some(v)).chars().filter(|c| !c.is_whitespace()).collect();
                    return Some(Output::Image { mime, data });
                }
            }
            if let Some(v) = data.get("image/svg+xml") {
                return Some(Output::Image { mime: "image/svg+xml", data: text(Some(v)) });
            }
            if let Some(v) = data.get("text/markdown") {
                return Some(Output::Markdown { blocks: markdown::parse(&text(Some(v))) });
            }
            let plain = text(data.get("text/plain"));
            (!plain.is_empty()).then(|| Output::Text { text: cut(strip_ansi(&plain)), error: false })
        }
        _ => None,
    }
}

pub fn parse(src: &str) -> Result<Notebook, String> {
    let nb: Value = serde_json::from_str(src).map_err(|e| format!("it isn't a valid notebook ({e})"))?;
    if nb.get("nbformat").and_then(Value::as_u64).unwrap_or(0) < 4 {
        return Err("it's in an older notebook format, from before Jupyter 4".into());
    }
    let meta = nb.get("metadata");
    let lang = meta
        .and_then(|m| m.pointer("/language_info/name").or_else(|| m.pointer("/kernelspec/language")))
        .and_then(Value::as_str)
        .unwrap_or("python")
        .to_ascii_lowercase();
    let cells = nb
        .get("cells")
        .and_then(Value::as_array)
        .ok_or("it has no cells")?
        .iter()
        .map(|c| {
            let source = text(c.get("source"));
            match c.get("cell_type").and_then(Value::as_str) {
                Some("markdown") => Cell::Markdown { blocks: markdown::parse(&source) },
                Some("code") => Cell::Code {
                    source,
                    count: c.get("execution_count").and_then(Value::as_u64),
                    outputs: c
                        .get("outputs")
                        .and_then(Value::as_array)
                        .map(|os| os.iter().filter_map(output).collect())
                        .unwrap_or_default(),
                },
                _ => Cell::Raw { source },
            }
        })
        .collect();
    Ok(Notebook { lang, cells })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_cells_and_their_outputs() {
        let src = r##"{
          "nbformat": 4, "nbformat_minor": 5,
          "metadata": {"language_info": {"name": "Python"}},
          "cells": [
            {"cell_type": "markdown", "source": ["# Title\n", "Some *text*"]},
            {"cell_type": "code", "execution_count": 3, "source": "print(1)\n1/0", "outputs": [
              {"output_type": "stream", "name": "stdout", "text": ["1\n"]},
              {"output_type": "display_data", "data": {"image/png": "iVBO\nRw0K", "text/plain": "<Figure>"}},
              {"output_type": "execute_result", "data": {"text/html": "<script>x</script>", "text/plain": "   a\n0  1"}},
              {"output_type": "error", "ename": "ZeroDivisionError", "evalue": "division by zero",
               "traceback": ["\u001b[0;31mZeroDivisionError\u001b[0m: division by zero"]}
            ]},
            {"cell_type": "raw", "source": "raw text"}
          ]
        }"##;
        let nb = parse(src).unwrap();
        assert_eq!(nb.lang, "python");
        assert_eq!(nb.cells.len(), 3);
        assert!(matches!(&nb.cells[0], Cell::Markdown { blocks } if !blocks.is_empty()));
        let Cell::Code { source, count, outputs } = &nb.cells[1] else { panic!("not code") };
        assert_eq!((source.as_str(), *count), ("print(1)\n1/0", Some(3)));
        assert!(matches!(&outputs[0], Output::Text { text, error: false } if text == "1\n"));
        assert!(matches!(&outputs[1], Output::Image { mime: "image/png", data } if data == "iVBORw0K"));
        assert!(matches!(&outputs[2], Output::Text { text, .. } if text == "   a\n0  1"), "HTML falls back to text");
        assert!(matches!(&outputs[3], Output::Text { text, error: true } if text == "ZeroDivisionError: division by zero"));
        assert!(matches!(&nb.cells[2], Cell::Raw { source } if source == "raw text"));
    }

    #[test]
    fn an_error_without_a_traceback_shows_its_name_and_value() {
        let o: Value = serde_json::from_str(r#"{"output_type": "error", "ename": "KeyError", "evalue": "'x'"}"#).unwrap();
        assert!(matches!(output(&o), Some(Output::Text { text, error: true }) if text == "KeyError: 'x'"));
    }

    #[test]
    fn refuses_what_is_not_a_notebook() {
        assert!(parse("not json").is_err());
        assert!(parse(r#"{"nbformat": 3, "worksheets": []}"#).is_err());
        assert_eq!(strip_ansi("\u{1b}[1;32mok\u{1b}[0m done"), "ok done");
        assert_eq!(cut("x".repeat(MAX_OUTPUT_CHARS + 5)).len(), MAX_OUTPUT_CHARS + "\n… (output cut)".len());
    }
}
