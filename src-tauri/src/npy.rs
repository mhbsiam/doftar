//! NumPy arrays: .npy files and .npz archives. Read only the header and the first rows, so a 10 GB array opens at once.
//! Never load object arrays. Unpickling can run code.

use std::fs;
use std::io::{self, BufReader, Read, Seek};
use std::path::Path;

use crate::data::{datetime, float, thousands, Book, Part, Table, ROW_LIMIT};

const MAX_COLS: usize = 200;

/// The file sets the width and the read buffer size. A wider type is only named.
const MAX_ELEM_BYTES: usize = 4096;

#[derive(Debug, PartialEq)]
struct Header {
    /// NumPy type string, for example `<f8`. `None` for a structured array.
    descr: Option<String>,
    fortran: bool,
    shape: Vec<u64>,
}

/// Leaves `r` at the start of the data.
fn header(r: &mut impl Read) -> Result<Header, String> {
    let bad = || "it isn't a NumPy array".to_string();
    let mut magic = [0u8; 8];
    r.read_exact(&mut magic).map_err(|_| bad())?;
    if &magic[..6] != b"\x93NUMPY" {
        return Err(bad());
    }
    let len = if magic[6] == 1 {
        let mut b = [0u8; 2];
        r.read_exact(&mut b).map_err(|_| bad())?;
        u16::from_le_bytes(b) as usize
    } else {
        let mut b = [0u8; 4];
        r.read_exact(&mut b).map_err(|_| bad())?;
        u32::from_le_bytes(b) as usize
    };
    if len > 1 << 20 {
        return Err(bad());
    }
    let mut text = vec![0u8; len];
    r.read_exact(&mut text).map_err(|_| bad())?;
    parse_header(&String::from_utf8_lossy(&text)).ok_or_else(bad)
}

fn after<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    let quoted = format!("'{key}'");
    // A structured `descr` can name a field after a key. There a comma follows it.
    text.match_indices(&quoted)
        .find_map(|(at, _)| text[at + quoted.len()..].trim_start().strip_prefix(':'))
        .map(str::trim_start)
}

fn parse_header(text: &str) -> Option<Header> {
    let descr = after(text, "descr")?;
    let descr = match descr.chars().next()? {
        q @ ('\'' | '"') => Some(descr[1..].split(q).next()?.to_string()),
        _ => None,
    };
    let fortran = after(text, "fortran_order")?.starts_with("True");
    let shape = after(text, "shape")?.strip_prefix('(')?;
    let shape = shape[..shape.find(')')?]
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches('L').parse().ok())
        .collect::<Option<Vec<u64>>>()?;
    Some(Header { descr, fortran, shape })
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Elem {
    Bool,
    Int(usize),
    Uint(usize),
    Float(usize),
    DateNs,
    Unicode(usize),
    Bytes(usize),
    /// Name only: object, complex, other time units, structured.
    Other,
}

struct Dtype {
    elem: Elem,
    big: bool,
    size: usize,
    name: String,
}

fn dtype(descr: Option<&str>) -> Dtype {
    let Some(d) = descr else {
        return Dtype { elem: Elem::Other, big: false, size: 0, name: "structured".into() };
    };
    let big = d.starts_with('>');
    let body = d.trim_start_matches(['<', '>', '|', '=']);
    let kind = body.chars().next().unwrap_or('?');
    let digits: String = body.get(kind.len_utf8()..).unwrap_or("").chars().take_while(char::is_ascii_digit).collect();
    let n: usize = digits.parse().unwrap_or(0);
    let (elem, size, name) = match kind {
        'b' => (Elem::Bool, 1, "bool".to_string()),
        'i' if matches!(n, 1 | 2 | 4 | 8) => (Elem::Int(n), n, format!("int{}", n * 8)),
        'u' if matches!(n, 1 | 2 | 4 | 8) => (Elem::Uint(n), n, format!("uint{}", n * 8)),
        'f' if matches!(n, 4 | 8) => (Elem::Float(n), n, format!("float{}", n * 8)),
        'f' => (Elem::Other, n, format!("float{}", n * 8)),
        'c' => (Elem::Other, n, format!("complex{}", n * 8)),
        'M' if body.ends_with("[ns]") => (Elem::DateNs, 8, "datetime64[ns]".to_string()),
        'M' | 'm' => {
            let unit = body.get(1 + digits.len()..).unwrap_or("");
            (Elem::Other, 8, format!("{}{unit}", if kind == 'M' { "datetime64" } else { "timedelta64" }))
        }
        'U' => (Elem::Unicode(n), n.saturating_mul(4), format!("str{n}")),
        'S' => (Elem::Bytes(n), n, format!("bytes{n}")),
        'O' => (Elem::Other, 8, "object".to_string()),
        _ => (Elem::Other, n, body.to_string()),
    };
    let elem = if size > MAX_ELEM_BYTES { Elem::Other } else { elem };
    Dtype { elem, big, size, name }
}

fn cell(t: &Dtype, b: &[u8]) -> String {
    let mut buf = [0u8; 8];
    let mut fixed = |n: usize| {
        buf[..n].copy_from_slice(&b[..n]);
        if t.big {
            buf[..n].reverse();
        }
        buf
    };
    match t.elem {
        Elem::Bool => (b[0] != 0).to_string(),
        Elem::Int(1) => (b[0] as i8).to_string(),
        Elem::Int(2) => i16::from_le_bytes(fixed(2)[..2].try_into().unwrap()).to_string(),
        Elem::Int(4) => i32::from_le_bytes(fixed(4)[..4].try_into().unwrap()).to_string(),
        Elem::Int(_) => i64::from_le_bytes(fixed(8)).to_string(),
        Elem::Uint(1) => b[0].to_string(),
        Elem::Uint(2) => u16::from_le_bytes(fixed(2)[..2].try_into().unwrap()).to_string(),
        Elem::Uint(4) => u32::from_le_bytes(fixed(4)[..4].try_into().unwrap()).to_string(),
        Elem::Uint(_) => u64::from_le_bytes(fixed(8)).to_string(),
        Elem::Float(4) => float(f64::from(f32::from_le_bytes(fixed(4)[..4].try_into().unwrap()))),
        Elem::Float(_) => float(f64::from_le_bytes(fixed(8))),
        Elem::DateNs => match i64::from_le_bytes(fixed(8)) {
            i64::MIN => "NaT".into(),
            ns => datetime(ns),
        },
        Elem::Unicode(n) => (0..n)
            .map(|i| {
                let mut c = [b[i * 4], b[i * 4 + 1], b[i * 4 + 2], b[i * 4 + 3]];
                if t.big {
                    c.reverse();
                }
                u32::from_le_bytes(c)
            })
            .take_while(|&c| c != 0)
            .map(|c| char::from_u32(c).unwrap_or('\u{fffd}'))
            .collect(),
        Elem::Bytes(n) => {
            let end = b[..n].iter().position(|&c| c == 0).unwrap_or(n);
            String::from_utf8_lossy(&b[..end]).into_owned()
        }
        Elem::Other => String::new(),
    }
}

/// Read forward and skip unshown data. Seek in a file. Read past it in a compressed archive entry.
struct Forward<R> {
    r: R,
    pos: u64,
    seekable: bool,
}

impl<R: Read + Seek> Forward<R> {
    fn read_at(&mut self, at: u64, buf: &mut [u8]) -> io::Result<()> {
        if at > self.pos {
            if self.seekable {
                self.r.seek_relative((at - self.pos) as i64)?;
            } else {
                io::copy(&mut (&mut self.r).take(at - self.pos), &mut io::sink())?;
            }
        }
        self.r.read_exact(buf)?;
        self.pos = at + buf.len() as u64;
        Ok(())
    }
}

/// A compressed archive entry made to look seekable. Only forward reads work.
struct Stream<R>(R);

impl<R: Read> Read for Stream<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.read(buf)
    }
}

impl<R> Seek for Stream<R> {
    fn seek(&mut self, _: io::SeekFrom) -> io::Result<u64> {
        Err(io::ErrorKind::Unsupported.into())
    }
}

fn dims(shape: &[u64]) -> String {
    if shape.is_empty() {
        return "scalar".into();
    }
    shape.iter().map(|&n| thousands(n)).collect::<Vec<_>>().join(" × ")
}

fn preview<R: Read + Seek>(h: &Header, mut src: Forward<R>) -> Result<Table, String> {
    let t = dtype(h.descr.as_deref());
    let mut facts = vec![
        ("Shape".to_string(), dims(&h.shape)),
        ("Type".to_string(), t.name.clone()),
        ("Order".to_string(), if h.fortran { "Fortran (column-major)" } else { "C (row-major)" }.to_string()),
    ];
    let not_shown = |why: &str, mut facts: Vec<(String, String)>| {
        facts.push(("Preview".into(), why.into()));
        Ok(Table { facts, ..Table::default() })
    };
    if t.elem == Elem::Other {
        let why = if t.name == "object" {
            "not shown: loading an object array can run code"
        } else {
            "not shown for this type"
        };
        return not_shown(why, facts);
    }
    // Show the array up to 2-D, or its first 2-D slice.
    let n = h.shape.len();
    let (rows, cols) = match n {
        0 => (1, 1),
        1 => (h.shape[0], 1),
        _ => (h.shape[n - 2], h.shape[n - 1]),
    };
    if n > 2 {
        if h.fortran {
            return not_shown("not shown for Fortran-ordered arrays of more than 2 dimensions", facts);
        }
        let slice = std::iter::repeat_n("0", n - 2).chain(["…", "…"]).collect::<Vec<_>>().join(", ");
        facts.push(("Showing".into(), format!("slice [{slice}]")));
    }
    let shown_rows = rows.min(ROW_LIMIT as u64) as usize;
    let shown_cols = cols.min(MAX_COLS as u64) as usize;
    if (cols as usize) > shown_cols {
        facts.push(("Columns shown".into(), format!("first {MAX_COLS} of {}", thousands(cols))));
    }
    let size = t.size as u64;
    let mut grid = vec![vec![None; shown_cols]; shown_rows];
    let io = |e: io::Error| format!("the array is cut short ({e})");
    if h.fortran && n == 2 {
        // Each column is stored whole, one after another.
        let mut buf = vec![0u8; shown_rows * t.size];
        for j in 0..shown_cols {
            src.read_at(j as u64 * rows * size, &mut buf).map_err(io)?;
            for (i, row) in grid.iter_mut().enumerate() {
                row[j] = Some(cell(&t, &buf[i * t.size..]));
            }
        }
    } else {
        let mut buf = vec![0u8; shown_cols * t.size];
        for (i, row) in grid.iter_mut().enumerate() {
            src.read_at(i as u64 * cols * size, &mut buf).map_err(io)?;
            for (j, value) in row.iter_mut().enumerate() {
                *value = Some(cell(&t, &buf[j * t.size..]));
            }
        }
    }
    let names: Vec<String> = if n < 2 { vec!["value".into()] } else { (0..shown_cols).map(|j| j.to_string()).collect() };
    Ok(Table {
        columns: Table::named(names),
        rows: grid,
        total_rows: Some(rows),
        facts,
        zero_index: true,
        ..Table::default()
    })
}

pub fn read_npy(path: &Path) -> Result<Table, String> {
    let mut f = BufReader::new(fs::File::open(path).map_err(|e| e.to_string())?);
    let h = header(&mut f)?;
    let pos = f.stream_position().map_err(|e| e.to_string())?;
    preview(&h, Forward { r: f, pos, seekable: true })
}

fn archive(path: &Path) -> Result<zip::ZipArchive<BufReader<fs::File>>, String> {
    let f = BufReader::new(fs::File::open(path).map_err(|e| e.to_string())?);
    zip::ZipArchive::new(f).map_err(|_| "it isn't a NumPy .npz archive".to_string())
}

pub fn read_npz(path: &Path) -> Result<Book, String> {
    let mut zip = archive(path)?;
    let mut parts = Vec::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let Some(name) = entry.name().ok().and_then(|n| n.strip_suffix(".npy").map(str::to_string)) else { continue };
        let detail = match header(&mut entry) {
            Ok(h) => format!("{} · {}", dims(&h.shape), dtype(h.descr.as_deref()).name),
            Err(e) => e,
        };
        parts.push(Part { name, detail });
    }
    let first = match parts.first() {
        Some(p) => Some(read_npz_part(path, &p.name)?),
        None => None,
    };
    let facts = vec![("Arrays".into(), thousands(parts.len() as u64))];
    Ok(Book { parts, first, facts, ..Book::default() })
}

pub fn read_npz_part(path: &Path, name: &str) -> Result<Table, String> {
    let mut zip = archive(path)?;
    let mut entry = zip.by_name(&format!("{name}.npy")).map_err(|_| format!("no array named “{name}”"))?;
    let h = header(&mut entry)?;
    preview(&h, Forward { r: Stream(entry), pos: 0, seekable: false })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn npy(descr: &str, fortran: bool, shape: &str, data: &[u8]) -> Vec<u8> {
        let mut dict = format!("{{'descr': '{descr}', 'fortran_order': {}, 'shape': {shape}, }}", if fortran { "True" } else { "False" });
        while (10 + dict.len() + 1) % 64 != 0 {
            dict.push(' ');
        }
        dict.push('\n');
        let mut out = b"\x93NUMPY\x01\x00".to_vec();
        out.extend((dict.len() as u16).to_le_bytes());
        out.extend(dict.as_bytes());
        out.extend(data);
        out
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("doftar-npy-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn cells(t: &Table) -> Vec<Vec<&str>> {
        t.rows.iter().map(|r| r.iter().map(|c| c.as_deref().unwrap_or("-")).collect()).collect()
    }

    #[test]
    fn huge_element_widths_are_named_not_read() {
        for descr in ["<S500000000", "<U500000000", "<U4611686018427387905", "|V99999999999"] {
            assert!(dtype(Some(descr)).elem == Elem::Other, "{descr}");
        }
        assert!(dtype(Some("<U8")).elem == Elem::Unicode(8));
    }

    #[test]
    fn empty_descr_does_not_panic() {
        for descr in ["", "<"] {
            assert!(dtype(Some(descr)).elem == Elem::Other, "{descr:?}");
        }
    }

    #[test]
    fn parses_headers() {
        let h = parse_header("{'descr': '<f8', 'fortran_order': False, 'shape': (3, 4), }").unwrap();
        assert_eq!(h, Header { descr: Some("<f8".into()), fortran: false, shape: vec![3, 4] });
        let h = parse_header("{'descr': [('a', '<i4')], 'fortran_order': True, 'shape': (5,), }").unwrap();
        assert_eq!((h.descr, h.fortran, h.shape), (None, true, vec![5]));
        assert_eq!(parse_header("{'descr': '|b1', 'fortran_order': False, 'shape': (), }").unwrap().shape, Vec::<u64>::new());
        assert!(parse_header("nonsense").is_none());
    }

    #[test]
    fn a_structured_field_can_share_a_header_keys_name() {
        let h = parse_header("{'descr': [('shape', '<f8'), ('fortran_order', '|b1')], 'fortran_order': True, 'shape': (5,), }").unwrap();
        assert_eq!((h.descr, h.fortran, h.shape), (None, true, vec![5]));
    }

    #[test]
    fn names_date_and_duration_types() {
        for (descr, name) in [
            ("<M8[ms]", "datetime64[ms]"),
            ("<M8[D]", "datetime64[D]"),
            ("<M8[ns]", "datetime64[ns]"),
            ("<m8[ns]", "timedelta64[ns]"),
            ("<m8[ms]", "timedelta64[ms]"),
            ("<M8", "datetime64"),
        ] {
            assert_eq!(dtype(Some(descr)).name, name);
        }
    }

    #[test]
    fn previews_arrays_in_either_order() {
        let dir = scratch("read");
        let data: Vec<u8> = (0..6).flat_map(|i| f64::from(i).to_le_bytes()).collect();
        let f = dir.join("c.npy");
        fs::write(&f, npy("<f8", false, "(2, 3)", &data)).unwrap();
        let t = read_npy(&f).unwrap();
        assert_eq!(cells(&t), [["0.0", "1.0", "2.0"], ["3.0", "4.0", "5.0"]]);
        assert!(t.zero_index);
        let f = dir.join("f.npy");
        fs::write(&f, npy("<f8", true, "(2, 3)", &data)).unwrap();
        assert_eq!(cells(&read_npy(&f).unwrap()), [["0.0", "2.0", "4.0"], ["1.0", "3.0", "5.0"]]);
        let f = dir.join("be.npy");
        fs::write(&f, npy(">i4", false, "(2,)", &[0, 0, 1, 0, 0xff, 0xff, 0xff, 0xfe])).unwrap();
        assert_eq!(cells(&read_npy(&f).unwrap()), [["256"], ["-2"]]);
        let f = dir.join("u.npy");
        let mut s = Vec::new();
        for c in "hi\0" .chars() {
            s.extend((c as u32).to_le_bytes());
        }
        fs::write(&f, npy("<U3", false, "(1,)", &s)).unwrap();
        assert_eq!(cells(&read_npy(&f).unwrap()), [["hi"]]);
        let f = dir.join("3d.npy");
        let data: Vec<u8> = (0..8u8).collect();
        fs::write(&f, npy("|u1", false, "(2, 2, 2)", &data)).unwrap();
        let t = read_npy(&f).unwrap();
        assert_eq!(cells(&t), [["0", "1"], ["2", "3"]]);
        assert!(t.facts.iter().any(|(k, v)| k == "Showing" && v == "slice [0, …, …]"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn never_loads_object_arrays() {
        let dir = scratch("object");
        let f = dir.join("o.npy");
        fs::write(&f, npy("|O", false, "(2,)", b"\x80\x04pickle")).unwrap();
        let t = read_npy(&f).unwrap();
        assert!(t.rows.is_empty());
        assert!(t.facts.iter().any(|(_, v)| v.contains("can run code")));
        fs::write(&f, b"not numpy").unwrap();
        assert!(read_npy(&f).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn lists_and_reads_npz_arrays() {
        let dir = scratch("npz");
        let f = dir.join("a.npz");
        {
            let mut zip = zip::ZipWriter::new(fs::File::create(&f).unwrap());
            let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("x.npy", opts).unwrap();
            let data: Vec<u8> = (0..4).flat_map(|i: i64| i.to_le_bytes()).collect();
            zip.write_all(&npy("<i8", false, "(2, 2)", &data)).unwrap();
            zip.start_file("y.npy", opts).unwrap();
            zip.write_all(&npy("|b1", false, "(3,)", &[1, 0, 1])).unwrap();
            zip.finish().unwrap();
        }
        let book = read_npz(&f).unwrap();
        let names: Vec<_> = book.parts.iter().map(|p| (p.name.as_str(), p.detail.as_str())).collect();
        assert_eq!(names, [("x", "2 × 2 · int64"), ("y", "3 · bool")]);
        assert_eq!(cells(book.first.as_ref().unwrap()), [["0", "1"], ["2", "3"]]);
        assert_eq!(cells(&read_npz_part(&f, "y").unwrap()), [["true"], ["false"], ["true"]]);
        assert!(read_npz_part(&f, "z").is_err());
        fs::remove_dir_all(&dir).unwrap();
    }
}
