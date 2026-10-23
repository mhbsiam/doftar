//! Turns Markdown into a tree of typed nodes for the reader window to draw.
//! The page builds every element itself from these nodes and never inserts
//! HTML, so a document can't run script or reach Doftar's commands. Raw
//! HTML in a document keeps a few harmless tags (line breaks, images, keys,
//! emphasis, links); the rest is dropped and only its text shows.

use pulldown_cmark::{
    Alignment, BlockQuoteKind, CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag,
};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Node {
    // Blocks.
    Para { c: Vec<Node> },
    Heading { level: u8, id: String, c: Vec<Node> },
    /// A fenced or indented code block; `lang` is the first word of its info string.
    Code { lang: String, text: String },
    /// `kind` is a GitHub alert ("note", "tip", "important", "warning", "caution").
    Quote { kind: Option<&'static str>, c: Vec<Node> },
    List { start: Option<u64>, c: Vec<Node> },
    Item { task: Option<bool>, c: Vec<Node> },
    /// Alignments are "left", "center", "right" or "".
    Table { align: Vec<&'static str>, c: Vec<Node> },
    Head { c: Vec<Node> },
    Row { c: Vec<Node> },
    Cell { c: Vec<Node> },
    Rule,
    FootnoteDef { label: String, c: Vec<Node> },
    /// Front matter, shown as it is written.
    Meta { text: String },
    /// What was kept of a block of raw HTML.
    HtmlBlock { center: bool, c: Vec<Node> },
    DisplayMath { v: String },
    // Inline.
    Text { v: String },
    InlineCode { v: String },
    InlineMath { v: String },
    Emph { c: Vec<Node> },
    Strong { c: Vec<Node> },
    Strike { c: Vec<Node> },
    Sup { c: Vec<Node> },
    Sub { c: Vec<Node> },
    Kbd { c: Vec<Node> },
    Link { href: String, title: String, c: Vec<Node> },
    Image { src: String, alt: String, title: String, width: Option<u32> },
    Break,
    FootnoteRef { label: String },
}

/// What an open element will become once it ends.
enum Kind {
    Root,
    Para,
    Heading(u8),
    Quote(Option<&'static str>),
    Code(String),
    HtmlBlock(String),
    List(Option<u64>),
    Item(Option<bool>),
    FootnoteDef(String),
    Table(Vec<&'static str>),
    Head,
    Row,
    Cell,
    Emph,
    Strong,
    Strike,
    Sup,
    Sub,
    Link { href: String, title: String },
    Image { src: String, title: String },
    Meta(String),
    /// An inline HTML element, by tag name, with a link's address.
    Html(&'static str, Option<String>),
}

struct Frame {
    kind: Kind,
    c: Vec<Node>,
}

fn push_text(c: &mut Vec<Node>, s: &str) {
    if s.is_empty() {
        return;
    }
    if let Some(Node::Text { v }) = c.last_mut() {
        v.push_str(s);
    } else {
        c.push(Node::Text { v: s.to_string() });
    }
}

/// The plain text of `nodes`, for alt text and heading anchors.
fn text_of(nodes: &[Node], out: &mut String) {
    for n in nodes {
        match n {
            Node::Text { v } | Node::InlineCode { v } | Node::InlineMath { v } => out.push_str(v),
            Node::Image { alt, .. } => out.push_str(alt),
            Node::Emph { c }
            | Node::Strong { c }
            | Node::Strike { c }
            | Node::Sup { c }
            | Node::Sub { c }
            | Node::Kbd { c }
            | Node::Link { c, .. } => text_of(c, out),
            _ => {}
        }
    }
}

/// GitHub's anchor for a heading: lowercase, punctuation dropped, spaces as hyphens.
fn slug(text: &str) -> String {
    text.trim()
        .to_lowercase()
        .chars()
        .filter_map(|ch| match ch {
            ' ' => Some('-'),
            '-' | '_' => Some(ch),
            _ if ch.is_alphanumeric() => Some(ch),
            _ => None,
        })
        .collect()
}

fn alert(kind: Option<BlockQuoteKind>) -> Option<&'static str> {
    kind.map(|k| match k {
        BlockQuoteKind::Note => "note",
        BlockQuoteKind::Tip => "tip",
        BlockQuoteKind::Important => "important",
        BlockQuoteKind::Warning => "warning",
        BlockQuoteKind::Caution => "caution",
    })
}

fn level(l: HeadingLevel) -> u8 {
    l as u8
}

/// A tag as written in raw HTML.
#[derive(Debug, PartialEq)]
struct HtmlTag {
    name: String,
    closing: bool,
    attrs: Vec<(String, String)>,
}

impl HtmlTag {
    fn attr(&self, key: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }
}

fn parse_tag(s: &str) -> Option<HtmlTag> {
    let inner = s.strip_prefix('<')?.strip_suffix('>')?.trim_end_matches('/');
    let (closing, inner) = match inner.strip_prefix('/') {
        Some(rest) => (true, rest),
        None => (false, inner),
    };
    let name_end = inner
        .find(|c: char| !c.is_ascii_alphanumeric())
        .unwrap_or(inner.len());
    if name_end == 0 {
        return None;
    }
    let name = inner[..name_end].to_ascii_lowercase();
    let mut attrs = Vec::new();
    let mut rest = inner[name_end..].trim_start();
    while !rest.is_empty() {
        let key_end = rest
            .find(|c: char| c.is_whitespace() || c == '=')
            .unwrap_or(rest.len());
        let key = rest[..key_end].to_ascii_lowercase();
        rest = rest[key_end..].trim_start();
        let mut value = String::new();
        if let Some(after) = rest.strip_prefix('=') {
            let after = after.trim_start();
            let (v, tail) = match after.chars().next() {
                Some(q @ ('"' | '\'')) => {
                    let body = &after[1..];
                    let end = body.find(q).unwrap_or(body.len());
                    (&body[..end], body.get(end + 1..).unwrap_or(""))
                }
                _ => {
                    let end = after.find(char::is_whitespace).unwrap_or(after.len());
                    (&after[..end], &after[end..])
                }
            };
            value = decode_entities(v);
            rest = tail.trim_start();
        }
        if key.is_empty() {
            // Stray characters; skip one so the loop moves on.
            let skip = rest.chars().next().map_or(0, char::len_utf8);
            rest = rest[skip..].trim_start();
        } else {
            attrs.push((key, value));
        }
    }
    Some(HtmlTag { name, closing, attrs })
}

fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        // Bytes, not a str slice: the 12th byte can fall inside a character.
        let end = rest.bytes().take(12).position(|b| b == b';');
        let decoded = end.and_then(|e| {
            let name = &rest[1..e];
            let ch = match name {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some('\u{a0}'),
                "copy" => Some('©'),
                "reg" => Some('®'),
                "mdash" => Some('—'),
                "ndash" => Some('–'),
                "hellip" => Some('…'),
                _ => {
                    let num = name.strip_prefix('#')?;
                    let n = match num.strip_prefix(['x', 'X']) {
                        Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                        None => num.parse().ok()?,
                    };
                    char::from_u32(n)
                }
            }?;
            Some((ch, e))
        });
        match decoded {
            Some((ch, e)) => {
                out.push(ch);
                rest = &rest[e + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Inline HTML elements that are drawn; others show only their text.
fn kept_inline(name: &str) -> Option<&'static str> {
    Some(match name {
        "b" | "strong" => "strong",
        "i" | "em" => "em",
        "s" | "del" | "strike" => "s",
        "sup" => "sup",
        "sub" => "sub",
        "kbd" => "kbd",
        "code" => "code",
        "a" => "a",
        "summary" => "strong",
        _ => return None,
    })
}

fn image_from(tag: &HtmlTag) -> Option<Node> {
    let src = tag.attr("src")?.to_string();
    Some(Node::Image {
        src,
        alt: tag.attr("alt").unwrap_or("").to_string(),
        title: tag.attr("title").unwrap_or("").to_string(),
        width: tag.attr("width").and_then(|w| w.trim_end_matches("px").parse().ok()),
    })
}

/// Elements that start a new line when they end in an HTML block.
fn breaks_line(name: &str) -> bool {
    matches!(
        name,
        "p" | "div" | "br" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "li" | "tr" | "summary"
    )
}

/// How deeply elements nest before further ones are kept only as their
/// contents: far beyond any real document, and shallow enough that drawing
/// and sending the tree never runs out of stack.
const MAX_DEPTH: usize = 64;

struct Builder {
    stack: Vec<Frame>,
    ids: HashMap<String, usize>,
    /// Elements started past `MAX_DEPTH` and not yet ended; their contents
    /// go to the innermost element kept.
    skipped: usize,
}

impl Builder {
    fn top(&mut self) -> &mut Vec<Node> {
        &mut self.stack.last_mut().expect("root frame").c
    }

    fn full(&self) -> bool {
        self.skipped > 0 || self.stack.len() >= MAX_DEPTH
    }

    /// Starts an element for a parser event; `end` matches it.
    fn start(&mut self, kind: Kind) {
        if self.full() {
            self.skipped += 1;
        } else {
            self.open(kind);
        }
    }

    fn end(&mut self) {
        if self.skipped > 0 {
            self.skipped -= 1;
        } else {
            self.close_html();
            self.close();
        }
    }

    fn open(&mut self, kind: Kind) {
        self.stack.push(Frame { kind, c: Vec::new() });
    }

    /// Ends the innermost frame, adding what it makes to its parent.
    fn close(&mut self) {
        let Frame { kind, c } = self.stack.pop().expect("open frame");
        let node = match kind {
            Kind::Root => unreachable!("the root frame is never closed"),
            Kind::Para => Some(Node::Para { c }),
            Kind::Heading(level) => {
                let mut text = String::new();
                text_of(&c, &mut text);
                Some(Node::Heading { level, id: self.unique_id(slug(&text)), c })
            }
            Kind::Quote(kind) => Some(Node::Quote { kind, c }),
            Kind::Code(lang) => {
                let mut text = String::new();
                text_of(&c, &mut text);
                Some(Node::Code { lang, text })
            }
            Kind::HtmlBlock(raw) => {
                let (center, c) = html_block(&raw);
                (!c.is_empty()).then_some(Node::HtmlBlock { center, c })
            }
            Kind::List(start) => Some(Node::List { start, c }),
            Kind::Item(task) => Some(Node::Item { task, c }),
            Kind::FootnoteDef(label) => Some(Node::FootnoteDef { label, c }),
            Kind::Table(align) => Some(Node::Table { align, c }),
            Kind::Head => Some(Node::Head { c }),
            Kind::Row => Some(Node::Row { c }),
            Kind::Cell => Some(Node::Cell { c }),
            Kind::Emph => Some(Node::Emph { c }),
            Kind::Strong => Some(Node::Strong { c }),
            Kind::Strike => Some(Node::Strike { c }),
            Kind::Sup => Some(Node::Sup { c }),
            Kind::Sub => Some(Node::Sub { c }),
            Kind::Link { href, title } => Some(Node::Link { href, title, c }),
            Kind::Image { src, title } => {
                let mut alt = String::new();
                text_of(&c, &mut alt);
                Some(Node::Image { src, alt, title, width: None })
            }
            Kind::Meta(text) => Some(Node::Meta { text }),
            Kind::Html(name, href) => {
                self.top().extend(html_node(name, c, href));
                None
            }
        };
        if let Some(node) = node {
            self.top().push(node);
        }
    }

    fn unique_id(&mut self, base: String) -> String {
        let n = self.ids.entry(base.clone()).or_insert(0);
        let id = if *n == 0 { base } else { format!("{base}-{n}") };
        *n += 1;
        id
    }

    /// Closes inline HTML elements left open inside the frame that is ending.
    fn close_html(&mut self) {
        while matches!(self.stack.last().map(|f| &f.kind), Some(Kind::Html(..))) {
            self.close();
        }
    }

    fn inline_html(&mut self, raw: &str) {
        let Some(tag) = parse_tag(raw.trim()) else { return };
        if tag.name == "br" {
            self.top().push(Node::Break);
        } else if tag.name == "img" {
            if let Some(img) = image_from(&tag) {
                self.top().push(img);
            }
        } else if let Some(name) = kept_inline(&tag.name) {
            if !tag.closing {
                if !self.full() {
                    self.open(Kind::Html(name, tag.attr("href").map(str::to_string)));
                }
            } else if let Some(depth) = self
                .stack
                .iter()
                .rev()
                .take_while(|f| matches!(f.kind, Kind::Html(..)))
                .position(|f| matches!(f.kind, Kind::Html(n, _) if n == name))
            {
                // Closes it, and anything left open inside it.
                for _ in 0..=depth {
                    self.close();
                }
            }
        }
    }
}

/// What an inline HTML element becomes; an anchor without an address is just its text.
fn html_node(name: &str, c: Vec<Node>, href: Option<String>) -> Vec<Node> {
    vec![match name {
        "strong" => Node::Strong { c },
        "em" => Node::Emph { c },
        "s" => Node::Strike { c },
        "sup" => Node::Sup { c },
        "sub" => Node::Sub { c },
        "kbd" => Node::Kbd { c },
        "code" => {
            let mut v = String::new();
            text_of(&c, &mut v);
            Node::InlineCode { v }
        }
        _ => match href {
            Some(href) => Node::Link { href, title: String::new(), c },
            None => return c,
        },
    }]
}

/// Drops trailing spaces from the text at the end of `c`.
fn trim_end(c: &mut Vec<Node>) {
    if let Some(Node::Text { v }) = c.last_mut() {
        let trimmed = v.trim_end().len();
        v.truncate(trimmed);
        if v.is_empty() {
            c.pop();
        }
    }
}

/// An element open in an HTML block: its tag name, a link's address, and its children.
type Open = (Option<&'static str>, Option<String>, Vec<Node>);

/// What is kept of a raw HTML block: its text, images, line breaks and
/// simple inline elements, and whether it asked to be centred.
fn html_block(raw: &str) -> (bool, Vec<Node>) {
    let mut center = false;
    let mut stack: Vec<Open> = vec![(None, None, vec![])];
    let mut rest = raw;
    let text = |stack: &mut Vec<Open>, s: &str| {
        let decoded = decode_entities(s);
        let collapsed: String = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
        let c = &mut stack.last_mut().unwrap().2;
        if collapsed.is_empty() {
            // Space between two elements still separates them.
            let spaced = match c.last() {
                None | Some(Node::Break) => true,
                Some(Node::Text { v }) => v.ends_with(' '),
                _ => false,
            };
            if !decoded.is_empty() && !spaced {
                push_text(c, " ");
            }
            return;
        }
        let lead = decoded.starts_with(char::is_whitespace)
            && c.last().is_some_and(|n| *n != Node::Break);
        let trail = decoded.ends_with(char::is_whitespace);
        let mut v = String::new();
        if lead {
            v.push(' ');
        }
        v.push_str(&collapsed);
        if trail {
            v.push(' ');
        }
        push_text(c, &v);
    };
    while !rest.is_empty() {
        let Some(lt) = rest.find('<') else {
            text(&mut stack, rest);
            break;
        };
        text(&mut stack, &rest[..lt]);
        rest = &rest[lt..];
        if let Some(after) = rest.strip_prefix("<!--") {
            rest = after.find("-->").map_or("", |e| &after[e + 3..]);
            continue;
        }
        let Some(gt) = rest.find('>') else {
            text(&mut stack, rest);
            break;
        };
        let raw_tag = &rest[..=gt];
        rest = &rest[gt + 1..];
        let Some(tag) = parse_tag(raw_tag) else {
            text(&mut stack, raw_tag);
            continue;
        };
        if !tag.closing && tag.attr("align").is_some_and(|a| a.eq_ignore_ascii_case("center")) {
            center = true;
        }
        if tag.name == "img" {
            if let Some(img) = image_from(&tag) {
                stack.last_mut().unwrap().2.push(img);
            }
        } else if let Some(name) = kept_inline(&tag.name) {
            if !tag.closing {
                if stack.len() < MAX_DEPTH {
                    stack.push((Some(name), tag.attr("href").map(str::to_string), vec![]));
                }
            } else if stack.len() > 1 && stack.last().unwrap().0 == Some(name) {
                let (_, href, c) = stack.pop().unwrap();
                stack.last_mut().unwrap().2.extend(html_node(name, c, href));
            }
        } else if (tag.closing || tag.name == "br") && breaks_line(&tag.name) {
            let c = &mut stack.last_mut().unwrap().2;
            trim_end(c);
            if !c.is_empty() && c.last() != Some(&Node::Break) {
                c.push(Node::Break);
            }
        }
    }
    while stack.len() > 1 {
        let (name, href, c) = stack.pop().unwrap();
        stack.last_mut().unwrap().2.extend(html_node(name.unwrap_or(""), c, href));
    }
    let mut c = stack.pop().unwrap().2;
    trim_end(&mut c);
    while c.last() == Some(&Node::Break) {
        c.pop();
        trim_end(&mut c);
    }
    (center, c)
}

pub fn parse(src: &str) -> Vec<Node> {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS
        | Options::ENABLE_PLUSES_DELIMITED_METADATA_BLOCKS
        | Options::ENABLE_MATH
        | Options::ENABLE_GFM;
    let mut b = Builder {
        stack: vec![Frame { kind: Kind::Root, c: Vec::new() }],
        ids: HashMap::new(),
        skipped: 0,
    };
    for event in Parser::new_ext(src, options) {
        match event {
            Event::Start(tag) => {
                let kind = match tag {
                    Tag::Paragraph => Kind::Para,
                    Tag::Heading { level: l, .. } => Kind::Heading(level(l)),
                    Tag::BlockQuote(kind) => Kind::Quote(alert(kind)),
                    Tag::CodeBlock(CodeBlockKind::Fenced(info)) => {
                        Kind::Code(info.split_whitespace().next().unwrap_or("").to_string())
                    }
                    Tag::CodeBlock(CodeBlockKind::Indented) => Kind::Code(String::new()),
                    Tag::HtmlBlock => Kind::HtmlBlock(String::new()),
                    Tag::List(start) => Kind::List(start),
                    Tag::Item => Kind::Item(None),
                    Tag::FootnoteDefinition(label) => Kind::FootnoteDef(label.to_string()),
                    Tag::Table(align) => Kind::Table(
                        align
                            .iter()
                            .map(|a| match a {
                                Alignment::None => "",
                                Alignment::Left => "left",
                                Alignment::Center => "center",
                                Alignment::Right => "right",
                            })
                            .collect(),
                    ),
                    Tag::TableHead => Kind::Head,
                    Tag::TableRow => Kind::Row,
                    Tag::TableCell => Kind::Cell,
                    Tag::Emphasis => Kind::Emph,
                    Tag::Strong => Kind::Strong,
                    Tag::Strikethrough => Kind::Strike,
                    Tag::Superscript => Kind::Sup,
                    Tag::Subscript => Kind::Sub,
                    Tag::Link { dest_url, title, .. } => Kind::Link {
                        href: dest_url.to_string(),
                        title: title.to_string(),
                    },
                    Tag::Image { dest_url, title, .. } => Kind::Image {
                        src: dest_url.to_string(),
                        title: title.to_string(),
                    },
                    Tag::MetadataBlock(_) => Kind::Meta(String::new()),
                    // Definition lists aren't enabled; anything else reads as a paragraph.
                    _ => Kind::Para,
                };
                b.start(kind);
            }
            Event::End(_) => b.end(),
            Event::Text(s) => match &mut b.stack.last_mut().unwrap().kind {
                Kind::Meta(text) => text.push_str(&s),
                _ => push_text(b.top(), &s),
            },
            Event::Code(s) => b.top().push(Node::InlineCode { v: s.to_string() }),
            Event::InlineMath(s) => b.top().push(Node::InlineMath { v: s.to_string() }),
            Event::DisplayMath(s) => b.top().push(Node::DisplayMath { v: s.to_string() }),
            Event::Html(s) => match &mut b.stack.last_mut().unwrap().kind {
                Kind::HtmlBlock(raw) => raw.push_str(&s),
                _ => b.inline_html(&s),
            },
            Event::InlineHtml(s) => b.inline_html(&s),
            Event::FootnoteReference(label) => {
                b.top().push(Node::FootnoteRef { label: label.to_string() })
            }
            Event::SoftBreak => push_text(b.top(), "\n"),
            Event::HardBreak => b.top().push(Node::Break),
            Event::Rule => b.top().push(Node::Rule),
            Event::TaskListMarker(done) => {
                if let Some(Frame { kind: Kind::Item(task), .. }) = b
                    .stack
                    .iter_mut()
                    .rev()
                    .find(|f| matches!(f.kind, Kind::Item(_)))
                {
                    *task = Some(done);
                }
            }
        }
    }
    b.close_html();
    b.stack.pop().map(|f| f.c).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(v: &str) -> Node {
        Node::Text { v: v.into() }
    }

    #[test]
    fn reads_tables_with_alignment() {
        let doc = parse("| a | b |\n|:--|--:|\n| 1 | `2` |\n");
        let Node::Table { align, c } = &doc[0] else { panic!("{doc:?}") };
        assert_eq!(align, &["left", "right"]);
        assert_eq!(
            c[0],
            Node::Head { c: vec![Node::Cell { c: vec![text("a")] }, Node::Cell { c: vec![text("b")] }] }
        );
        assert_eq!(
            c[1],
            Node::Row {
                c: vec![
                    Node::Cell { c: vec![text("1")] },
                    Node::Cell { c: vec![Node::InlineCode { v: "2".into() }] }
                ]
            }
        );
    }

    #[test]
    fn reads_code_blocks_with_their_language() {
        let doc = parse("```rust title=x\nfn main() {}\n```\n\n    indented\n");
        assert_eq!(doc[0], Node::Code { lang: "rust".into(), text: "fn main() {}\n".into() });
        assert_eq!(doc[1], Node::Code { lang: "".into(), text: "indented\n".into() });
    }

    #[test]
    fn gives_headings_unique_github_anchors() {
        let doc = parse("# Hello, World!\n## Hello, World!\n### `api` & Co.\n");
        let ids: Vec<_> = doc
            .iter()
            .map(|n| match n {
                Node::Heading { id, .. } => id.as_str(),
                _ => "",
            })
            .collect();
        assert_eq!(ids, ["hello-world", "hello-world-1", "api--co"]);
    }

    #[test]
    fn reads_task_lists_alerts_and_footnotes() {
        let doc = parse("- [x] done\n- [ ] todo\n\n> [!WARNING]\n> careful\n\nSee[^1].\n\n[^1]: note\n");
        let Node::List { start: None, c } = &doc[0] else { panic!("{doc:?}") };
        assert_eq!(c[0], Node::Item { task: Some(true), c: vec![text("done")] });
        assert_eq!(c[1], Node::Item { task: Some(false), c: vec![text("todo")] });
        assert!(matches!(&doc[1], Node::Quote { kind: Some("warning"), .. }));
        assert_eq!(
            doc[2],
            Node::Para { c: vec![text("See"), Node::FootnoteRef { label: "1".into() }, text(".")] }
        );
        assert!(matches!(&doc[3], Node::FootnoteDef { label, .. } if label == "1"));
    }

    #[test]
    fn keeps_front_matter_apart() {
        let doc = parse("---\ntitle: x\n---\n\n# Body\n");
        assert_eq!(doc[0], Node::Meta { text: "title: x\n".into() });
    }

    #[test]
    fn keeps_only_harmless_inline_html() {
        let doc = parse("Press <kbd>⌘</kbd>+<b>S</b><br>now <script>alert(1)</script> <span onclick=x>ok</span>\n");
        assert_eq!(
            doc[0],
            Node::Para {
                c: vec![
                    text("Press "),
                    Node::Kbd { c: vec![text("⌘")] },
                    text("+"),
                    Node::Strong { c: vec![text("S")] },
                    Node::Break,
                    text("now alert(1) ok"),
                ]
            }
        );
    }

    #[test]
    fn keeps_images_and_centring_from_html_blocks() {
        let doc = parse(
            "<p align=\"center\">\n  <img src=\"logo.png\" alt=\"Logo\" width=\"120\">\n  <br>\n  A &amp; <a name=\"x\"></a><a href=\"#y\">B</a>\n</p>\n\n<!-- hidden -->\n\n<div onclick=\"evil()\"><script>x()</script></div>\n",
        );
        assert_eq!(
            doc[0],
            Node::HtmlBlock {
                center: true,
                c: vec![
                    Node::Image {
                        src: "logo.png".into(),
                        alt: "Logo".into(),
                        title: "".into(),
                        width: Some(120)
                    },
                    Node::Break,
                    text("A & "),
                    Node::Link { href: "#y".into(), title: "".into(), c: vec![text("B")] },
                ]
            }
        );
        assert_eq!(doc.len(), 2, "{doc:?}");
        assert_eq!(doc[1], Node::HtmlBlock { center: false, c: vec![text("x()")] });
    }

    #[test]
    fn keeps_spaces_between_html_elements() {
        let doc = parse("<p>\n  <kbd>⌘</kbd> <kbd>S</kbd>\n</p>\n");
        assert_eq!(
            doc[0],
            Node::HtmlBlock {
                center: false,
                c: vec![Node::Kbd { c: vec![text("⌘")] }, text(" "), Node::Kbd { c: vec![text("S")] }]
            }
        );
    }

    #[test]
    fn decodes_entities() {
        assert_eq!(decode_entities("a &lt;b&gt; &#65;&#x42; &bogus; &"), "a <b> AB &bogus; &");
        // An ampersand a few bytes before a multi-byte character.
        assert_eq!(decode_entities("Q&A: 你好你好你好"), "Q&A: 你好你好你好");
        assert_eq!(decode_entities("&你好;&amp;"), "&你好;&");
        let doc = parse("<p>Q&A: 你好你好你好</p>\n");
        assert_eq!(doc[0], Node::HtmlBlock { center: false, c: vec![text("Q&A: 你好你好你好")] });
        assert_eq!(parse_tag("<a =\"x\"你 href=y>").unwrap().attr("href"), Some("y"));
    }

    fn depth(nodes: &[Node]) -> usize {
        nodes
            .iter()
            .map(|n| match n {
                Node::Para { c }
                | Node::Heading { c, .. }
                | Node::Quote { c, .. }
                | Node::List { c, .. }
                | Node::Item { c, .. }
                | Node::Table { c, .. }
                | Node::Head { c }
                | Node::Row { c }
                | Node::Cell { c }
                | Node::FootnoteDef { c, .. }
                | Node::HtmlBlock { c, .. }
                | Node::Emph { c }
                | Node::Strong { c }
                | Node::Strike { c }
                | Node::Sup { c }
                | Node::Sub { c }
                | Node::Kbd { c }
                | Node::Link { c, .. } => 1 + depth(c),
                _ => 1,
            })
            .max()
            .unwrap_or(0)
    }

    #[test]
    fn bounds_how_deeply_elements_nest() {
        let n = 50_000;
        for src in [
            format!("x {}y\n", "<b>".repeat(n)),
            format!("x {}{}y\n", "<b>".repeat(n), "</i>".repeat(n)),
            format!("<p>{}y</p>\n", "<b>".repeat(n)),
            format!("{}y\n", "> ".repeat(n)),
        ] {
            let doc = parse(&src);
            // An HTML block's elements nest below the block itself.
            assert!(depth(&doc) <= MAX_DEPTH + 1, "{}", depth(&doc));
            // Sent to the page whole, with the text past the limit kept.
            let json = serde_json::to_string(&doc).unwrap();
            assert!(json.contains(r#""v":"y""#), "{}", &src[..20]);
        }
        // Elements past the limit still end where they should.
        let deep = format!("{}deep{} after\n", "<i>".repeat(100), "</i>".repeat(100));
        let Node::Para { c } = &parse(&deep)[0] else { panic!() };
        assert_eq!(c.last(), Some(&text(" after")));
    }
}
