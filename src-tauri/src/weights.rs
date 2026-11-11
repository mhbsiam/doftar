//! Model weights: safetensors and GGUF files. Both start with a header that lists every tensor.
//! Only the header is read, so a 40 GB model opens at once. The file shows as a book of two parts: tensors and metadata.

use std::collections::HashMap;
use std::fs;
use std::io::{BufReader, Read};
use std::path::Path;

use serde_json::Value;

use crate::data::{thousands, Book, Part, Table};

const MAX_SAFETENSORS_HEADER: u64 = 100 << 20;
const MAX_GGUF_STRING: u64 = 64 << 20;
const MAX_GGUF_TENSORS: u64 = 1 << 20;
const MAX_VALUE_CHARS: usize = 2_000;
const ARRAY_PREVIEW: usize = 8;
/// Maximum array nesting. Each level adds a call to the stack.
const MAX_GGUF_DEPTH: u32 = 16;

pub const TENSORS: &str = "Tensors";
pub const METADATA: &str = "Metadata";

struct Tensor {
    name: String,
    dtype: String,
    shape: Vec<u64>,
}

struct Weights {
    format: &'static str,
    tensors: Vec<Tensor>,
    meta: Vec<(String, String, String)>,
}

fn short_count(n: u64) -> String {
    if n < 1_000 {
        return n.to_string();
    }
    let units = [(1e3, "K"), (1e6, "M"), (1e9, "B"), (1e12, "T")];
    let mut i = units.iter().rposition(|&(div, _)| n as f64 >= div).unwrap_or(0);
    loop {
        let (div, unit) = units[i];
        let v = n as f64 / div;
        let digits = if v >= 100.0 { 0 } else if v >= 10.0 { 1 } else { 2 };
        let shown = format!("{v:.digits$}");
        // 999,999 rounds to "1000", which is 1.00 of the next unit.
        if shown == "1000" && i + 1 < units.len() {
            i += 1;
            continue;
        }
        return format!("{shown}{unit}");
    }
}

fn elements(shape: &[u64]) -> u64 {
    shape.iter().fold(1u64, |a, &d| a.saturating_mul(d))
}

fn cut(mut s: String) -> String {
    if let Some((at, _)) = s.char_indices().nth(MAX_VALUE_CHARS) {
        s.truncate(at);
        s.push('…');
    }
    s
}


fn read_safetensors(path: &Path) -> Result<Weights, String> {
    let bad = || "it isn't a safetensors file".to_string();
    let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut len = [0u8; 8];
    f.read_exact(&mut len).map_err(|_| bad())?;
    let len = u64::from_le_bytes(len);
    if len > MAX_SAFETENSORS_HEADER || len > f.metadata().map_err(|e| e.to_string())?.len() {
        return Err(bad());
    }
    let mut head = vec![0u8; len as usize];
    f.read_exact(&mut head).map_err(|_| bad())?;
    let head: serde_json::Map<String, Value> = serde_json::from_slice(&head).map_err(|_| bad())?;
    let mut tensors = Vec::new();
    let mut meta = Vec::new();
    for (name, v) in head {
        if name == "__metadata__" {
            for (k, v) in v.as_object().into_iter().flatten() {
                let s = v.as_str().map_or_else(|| v.to_string(), str::to_string);
                meta.push((k.clone(), "string".into(), cut(s)));
            }
            continue;
        }
        let dtype = v.get("dtype").and_then(Value::as_str).ok_or_else(bad)?.to_string();
        let shape = v
            .get("shape")
            .and_then(Value::as_array)
            .ok_or_else(bad)?
            .iter()
            .map(Value::as_u64)
            .collect::<Option<Vec<u64>>>()
            .ok_or_else(bad)?;
        let start = v.pointer("/data_offsets/0").and_then(Value::as_u64).unwrap_or(0);
        tensors.push((start, Tensor { name, dtype, shape }));
    }
    // serde_json sorts keys by name. The data order is the file order.
    tensors.sort_by_key(|(start, _)| *start);
    Ok(Weights { format: "safetensors", tensors: tensors.into_iter().map(|(_, t)| t).collect(), meta })
}


struct Gguf<R> {
    r: R,
    depth: u32,
}

impl<R: Read> Gguf<R> {
    fn bytes<const N: usize>(&mut self) -> Result<[u8; N], String> {
        let mut b = [0u8; N];
        self.r.read_exact(&mut b).map_err(|_| "the file ends early".to_string())?;
        Ok(b)
    }
    fn u32(&mut self) -> Result<u32, String> {
        self.bytes().map(u32::from_le_bytes)
    }
    fn u64(&mut self) -> Result<u64, String> {
        self.bytes().map(u64::from_le_bytes)
    }
    fn string(&mut self) -> Result<String, String> {
        let len = self.u64()?;
        if len > MAX_GGUF_STRING {
            return Err("the file is damaged".into());
        }
        let mut s = Vec::with_capacity(len as usize);
        (&mut self.r).take(len).read_to_end(&mut s).map_err(|e| e.to_string())?;
        if s.len() as u64 != len {
            return Err("the file ends early".into());
        }
        Ok(String::from_utf8_lossy(&s).into_owned())
    }

    fn array(&mut self) -> Result<(String, String), String> {
        if self.depth >= MAX_GGUF_DEPTH {
            return Err("arrays are nested too deeply".into());
        }
        self.depth += 1;
        let out = self.items();
        self.depth -= 1;
        out
    }

    fn items(&mut self) -> Result<(String, String), String> {
        let (item, n) = (self.u32()?, self.u64()?);
        let mut shown = Vec::new();
        // Read every item, also the unshown ones, to reach the next value.
        for i in 0..n {
            let v = self.value(item)?;
            if i < ARRAY_PREVIEW as u64 {
                shown.push(if item == 8 { format!("{v:?}") } else { v });
            }
        }
        let rest = match n.checked_sub(ARRAY_PREVIEW as u64) {
            Some(more) if more > 0 => format!(", … {} more", thousands(more)),
            _ => String::new(),
        };
        Ok((format!("{}[{}]", gguf_type_name(item), thousands(n)), format!("[{}{rest}]", shown.join(", "))))
    }

    fn value(&mut self, ty: u32) -> Result<String, String> {
        Ok(match ty {
            0 => self.bytes::<1>()?[0].to_string(),
            1 => (self.bytes::<1>()?[0] as i8).to_string(),
            2 => u16::from_le_bytes(self.bytes()?).to_string(),
            3 => i16::from_le_bytes(self.bytes()?).to_string(),
            4 => self.u32()?.to_string(),
            5 => i32::from_le_bytes(self.bytes()?).to_string(),
            6 => crate::data::float(f32::from_le_bytes(self.bytes()?) as f64),
            7 => (self.bytes::<1>()?[0] != 0).to_string(),
            8 => self.string()?,
            9 => self.array()?.1,
            10 => self.u64()?.to_string(),
            11 => i64::from_le_bytes(self.bytes()?).to_string(),
            12 => crate::data::float(f64::from_le_bytes(self.bytes()?)),
            _ => return Err(format!("it has a value of unknown type {ty}")),
        })
    }
}

fn gguf_type_name(ty: u32) -> &'static str {
    match ty {
        0 => "u8",
        1 => "i8",
        2 => "u16",
        3 => "i16",
        4 => "u32",
        5 => "i32",
        6 => "f32",
        7 => "bool",
        8 => "string",
        9 => "array",
        10 => "u64",
        11 => "i64",
        12 => "f64",
        _ => "?",
    }
}

fn ggml_type(ty: u32) -> String {
    let name = match ty {
        0 => "F32",
        1 => "F16",
        2 => "Q4_0",
        3 => "Q4_1",
        6 => "Q5_0",
        7 => "Q5_1",
        8 => "Q8_0",
        9 => "Q8_1",
        10 => "Q2_K",
        11 => "Q3_K",
        12 => "Q4_K",
        13 => "Q5_K",
        14 => "Q6_K",
        15 => "Q8_K",
        16 => "IQ2_XXS",
        17 => "IQ2_XS",
        18 => "IQ3_XXS",
        19 => "IQ1_S",
        20 => "IQ4_NL",
        21 => "IQ3_S",
        22 => "IQ2_S",
        23 => "IQ4_XS",
        24 => "I8",
        25 => "I16",
        26 => "I32",
        27 => "I64",
        28 => "F64",
        29 => "IQ1_M",
        30 => "BF16",
        34 => "TQ1_0",
        35 => "TQ2_0",
        39 => "MXFP4",
        _ => return format!("type {ty}"),
    };
    name.to_string()
}

fn read_gguf(path: &Path) -> Result<Weights, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut g = Gguf { r: BufReader::with_capacity(1 << 20, file), depth: 0 };
    if g.bytes::<4>().ok().as_ref() != Some(b"GGUF") {
        return Err("it isn't a GGUF file".into());
    }
    let version = g.u32()?;
    if !(2..=3).contains(&version) {
        return Err(format!("it's GGUF version {version}, which Doftar doesn't read"));
    }
    let (n_tensors, n_kv) = (g.u64()?, g.u64()?);
    if n_tensors > MAX_GGUF_TENSORS {
        return Err("the file is damaged".into());
    }
    let mut meta = Vec::new();
    for _ in 0..n_kv {
        let key = g.string()?;
        let ty = g.u32()?;
        let (ty_name, v) = if ty == 9 { g.array()? } else { (gguf_type_name(ty).to_string(), g.value(ty)?) };
        meta.push((key, ty_name, cut(v)));
    }
    let mut tensors = Vec::with_capacity(n_tensors as usize);
    for _ in 0..n_tensors {
        let name = g.string()?;
        let dims = g.u32()?;
        if dims > 8 {
            return Err("the file is damaged".into());
        }
        // ggml lists the fastest-moving dimension first. Other formats list it last.
        let mut shape = (0..dims).map(|_| g.u64()).collect::<Result<Vec<_>, _>>()?;
        shape.reverse();
        let dtype = ggml_type(g.u32()?);
        let _offset = g.u64()?;
        tensors.push(Tensor { name, dtype, shape });
    }
    Ok(Weights { format: "GGUF", tensors, meta })
}


fn load(path: &Path) -> Result<Weights, String> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
    if ext == "gguf" {
        read_gguf(path)
    } else {
        read_safetensors(path)
    }
}

fn dims(shape: &[u64]) -> String {
    if shape.is_empty() {
        "scalar".into()
    } else {
        shape.iter().map(|&d| thousands(d)).collect::<Vec<_>>().join(" × ")
    }
}

fn tensor_table(w: &Weights) -> Table {
    let rows = w
        .tensors
        .iter()
        .map(|t| vec![Some(t.name.clone()), Some(t.dtype.clone()), Some(dims(&t.shape)), Some(elements(&t.shape).to_string())])
        .collect();
    Table {
        columns: Table::named(["name", "type", "shape", "parameters"].map(String::from)),
        total_rows: Some(w.tensors.len() as u64),
        rows,
        ..Table::default()
    }
}

fn meta_table(w: &Weights) -> Table {
    let rows = w.meta.iter().map(|(k, t, v)| vec![Some(k.clone()), Some(t.clone()), Some(v.clone())]).collect();
    Table {
        columns: Table::named(["key", "type", "value"].map(String::from)),
        total_rows: Some(w.meta.len() as u64),
        rows,
        ..Table::default()
    }
}

fn facts(w: &Weights) -> Vec<(String, String)> {
    let total = w.tensors.iter().fold(0u64, |a, t| a.saturating_add(elements(&t.shape)));
    let mut facts = vec![
        ("Format".into(), w.format.into()),
        ("Parameters".into(), format!("{} ({})", short_count(total), thousands(total))),
    ];
    let meta = |key: &str| w.meta.iter().find(|(k, _, _)| k == key).map(|(_, _, v)| v.clone());
    if let Some(arch) = meta("general.architecture") {
        let ctx = meta(&format!("{arch}.context_length"));
        facts.push(("Architecture".into(), arch));
        if let Some(ctx) = ctx {
            facts.push(("Context".into(), ctx.parse().map_or(ctx, thousands)));
        }
    }
    if let Some(name) = meta("general.name") {
        facts.push(("Name".into(), name));
    }
    // The type with most of the weights is the file quantisation.
    let mut by_type: HashMap<&str, u64> = HashMap::new();
    for t in &w.tensors {
        *by_type.entry(&t.dtype).or_default() += elements(&t.shape);
    }
    // Ties go to the first name, so the answer is the same on every open.
    if let Some((ty, n)) = by_type.iter().max_by_key(|(t, n)| (**n, std::cmp::Reverse(**t))).filter(|_| total > 0) {
        let share = if by_type.len() > 1 { format!(" ({:.0}% of weights)", *n as f64 * 100.0 / total as f64) } else { String::new() };
        facts.push(("Stored as".into(), format!("{ty}{share}")));
    }
    facts
}

pub fn read(path: &Path) -> Result<Book, String> {
    let w = load(path)?;
    Ok(Book {
        parts: vec![
            Part { name: TENSORS.into(), detail: format!("{} tensors", thousands(w.tensors.len() as u64)) },
            Part { name: METADATA.into(), detail: format!("{} keys", thousands(w.meta.len() as u64)) },
        ],
        first: Some(tensor_table(&w)),
        facts: facts(&w),
        ..Book::default()
    })
}

pub fn read_part(path: &Path, part: &str) -> Result<Table, String> {
    let w = load(path)?;
    match part {
        TENSORS => Ok(tensor_table(&w)),
        METADATA => Ok(meta_table(&w)),
        _ => Err(format!("this file has no part “{part}”")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("wf-weights-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_a_safetensors_header() {
        let dir = scratch("st");
        let f = dir.join("m.safetensors");
        let head = br#"{"b.weight":{"dtype":"F16","shape":[2,3],"data_offsets":[16,28]},"a.bias":{"dtype":"F32","shape":[4],"data_offsets":[0,16]},"__metadata__":{"format":"pt"}}"#;
        let mut bytes = (head.len() as u64).to_le_bytes().to_vec();
        bytes.extend_from_slice(head);
        bytes.extend_from_slice(&[0u8; 28]);
        fs::write(&f, bytes).unwrap();
        let book = read(&f).unwrap();
        let t = book.first.unwrap();
        assert_eq!(t.rows[0][0].as_deref(), Some("a.bias"), "file order, not name order");
        assert_eq!(t.rows[1][2].as_deref(), Some("2 × 3"));
        assert_eq!(t.rows[1][3].as_deref(), Some("6"));
        assert!(book.facts.contains(&("Parameters".into(), "10 (10)".into())));
        assert!(book.facts.contains(&("Stored as".into(), "F16 (60% of weights)".into())));
        let m = read_part(&f, METADATA).unwrap();
        assert_eq!(m.rows[0], [Some("format".into()), Some("string".into()), Some("pt".into())]);

        fs::write(&f, b"\xff\xff\xff\xff\xff\xff\xff\xffnope").unwrap();
        assert!(read(&f).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn deeply_nested_gguf_arrays_are_refused() {
        let mut b = b"GGUF".to_vec();
        b.extend(3u32.to_le_bytes());
        b.extend(0u64.to_le_bytes());
        b.extend(1u64.to_le_bytes());
        b.extend(1u64.to_le_bytes());
        b.push(b'x');
        b.extend(9u32.to_le_bytes());
        for _ in 0..100_000 {
            b.extend(9u32.to_le_bytes());
            b.extend(1u64.to_le_bytes());
        }
        let f = scratch("nest").join("m.gguf");
        fs::write(&f, b).unwrap();
        assert!(read(&f).err().is_some_and(|e| e.contains("nested")));
    }

    #[test]
    fn reads_a_gguf_header() {
        fn s(out: &mut Vec<u8>, v: &str) {
            out.extend((v.len() as u64).to_le_bytes());
            out.extend(v.as_bytes());
        }
        let mut b = b"GGUF".to_vec();
        b.extend(3u32.to_le_bytes());
        b.extend(2u64.to_le_bytes());
        b.extend(4u64.to_le_bytes());
        s(&mut b, "general.architecture");
        b.extend(8u32.to_le_bytes());
        s(&mut b, "llama");
        s(&mut b, "llama.context_length");
        b.extend(4u32.to_le_bytes());
        b.extend(4096u32.to_le_bytes());
        s(&mut b, "tokenizer.ggml.tokens");
        b.extend(9u32.to_le_bytes());
        b.extend(8u32.to_le_bytes());
        b.extend(10u64.to_le_bytes());
        for i in 0..10 {
            s(&mut b, &format!("t{i}"));
        }
        s(&mut b, "general.alignment");
        b.extend(4u32.to_le_bytes());
        b.extend(32u32.to_le_bytes());
        for (name, dims, ty) in [("tok_embd", vec![4096u64, 32000], 12u32), ("norm", vec![4096], 0)] {
            s(&mut b, name);
            b.extend((dims.len() as u32).to_le_bytes());
            for d in dims {
                b.extend(d.to_le_bytes());
            }
            b.extend(ty.to_le_bytes());
            b.extend(0u64.to_le_bytes());
        }
        let dir = scratch("gguf");
        let f = dir.join("m.gguf");
        fs::write(&f, &b).unwrap();
        let book = read(&f).unwrap();
        let t = book.first.unwrap();
        assert_eq!(t.rows[0][1].as_deref(), Some("Q4_K"));
        assert_eq!(t.rows[0][2].as_deref(), Some("32,000 × 4,096"));
        assert!(book.facts.contains(&("Architecture".into(), "llama".into())));
        assert!(book.facts.contains(&("Context".into(), "4,096".into())));
        assert!(book.facts.contains(&("Parameters".into(), "131M (131,076,096)".into())));
        let m = read_part(&f, METADATA).unwrap();
        assert_eq!(m.rows[2][1].as_deref(), Some("string[10]"));
        assert!(m.rows[2][2].as_deref().unwrap().ends_with("\"t7\", … 2 more]"));
        assert_eq!(m.rows[3][2].as_deref(), Some("32"), "the key after an array is read in step");

        fs::write(&f, &b[..b.len() - 5]).unwrap();
        assert_eq!(read(&f).unwrap_err(), "the file ends early");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn counts_parameters_briefly() {
        assert_eq!(short_count(999), "999");
        assert_eq!(short_count(124_439_808), "124M");
        assert_eq!(short_count(7_241_732_096), "7.24B");
        assert_eq!(short_count(70_553_706_496), "70.6B");
        assert_eq!(short_count(999_999), "1.00M", "rounding up moves to the next unit");
        assert_eq!(short_count(999_999_999), "1.00B");
        assert_eq!(short_count(999_499), "999K");
    }
}
