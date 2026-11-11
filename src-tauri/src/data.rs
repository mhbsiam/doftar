//! Data files the reader shows as tables or summaries.
//! A book (SQLite, spreadsheet, .npz) lists its parts. Each part is read when it is shown.

use std::fs;
use std::io::Read;
use std::path::Path;

use hdf5_metno as hdf5;
use hdf5::types::{TypeDescriptor, VarLenAscii, VarLenUnicode};

/// Rows sent to the page. The rest are counted only.
pub const ROW_LIMIT: usize = 10_000;
const FRAME_ROWS: usize = 1_000;
/// Count a CSV to its end only up to this size. After that the count is "at least".
const COUNT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_NODES: usize = 2_000;
const MAX_MEMBERS: usize = 200;
/// Each level adds calls to the stack, and a hard link can point back at a parent group.
const MAX_DEPTH: usize = 32;

/// Keep in step with `DATA_EXTS` in src/util/kinds.ts.
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Data {
    Csv,
    Tsv,
    JsonLines,
    Parquet,
    Arrow,
    Hdf5,
    Npy,
    Npz,
    Sqlite,
    Sheets,
    Weights,
}

pub fn kind_of(ext: &str) -> Option<Data> {
    Some(match ext {
        "csv" => Data::Csv,
        "tsv" | "tab" => Data::Tsv,
        "jsonl" | "ndjson" => Data::JsonLines,
        "parquet" | "pq" => Data::Parquet,
        "arrow" | "arrows" | "feather" => Data::Arrow,
        "h5ad" | "h5" | "hdf5" | "he5" | "loom" => Data::Hdf5,
        "npy" => Data::Npy,
        "npz" => Data::Npz,
        "sqlite" | "sqlite3" | "db" | "db3" | "s3db" => Data::Sqlite,
        "xlsx" | "xlsm" | "xlsb" | "xls" | "ods" => Data::Sheets,
        "safetensors" | "gguf" => Data::Weights,
        _ => return None,
    })
}

#[derive(serde::Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ty: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stats: Option<Stats>,
}

#[derive(serde::Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub min: Option<String>,
    pub max: Option<String>,
    pub nulls: Option<u64>,
}

#[derive(serde::Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Table {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Option<String>>>,
    pub total_rows: Option<u64>,
    /// The file is too big to count. It has at least `total_rows` rows.
    pub more: bool,
    pub facts: Vec<(String, String)>,
    /// Number rows from 0.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub zero_index: bool,
}

impl Table {
    pub fn named(names: impl IntoIterator<Item = String>) -> Vec<Column> {
        names.into_iter().map(|name| Column { name, ..Column::default() }).collect()
    }
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    pub name: String,
    pub detail: String,
}

#[derive(serde::Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    pub parts: Vec<Part>,
    pub first: Option<Table>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub facts: Vec<(String, String)>,
}

#[derive(serde::Serialize, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Body {
    Table(Table),
    Hdf5(Box<Hdf5File>),
    Book(Book),
}

pub fn read(path: &Path, data: Data) -> Result<Body, String> {
    Ok(match data {
        Data::Csv => Body::Table(read_csv(path, None)?),
        Data::Tsv => Body::Table(read_csv(path, Some(b'\t'))?),
        Data::JsonLines => Body::Table(read_json_lines(path)?),
        Data::Parquet => Body::Table(read_parquet(path)?),
        Data::Arrow => Body::Table(read_arrow(path)?),
        Data::Hdf5 => Body::Hdf5(Box::new(read_hdf5(path)?)),
        Data::Npy => Body::Table(crate::npy::read_npy(path)?),
        Data::Npz => Body::Book(crate::npy::read_npz(path)?),
        Data::Sqlite => Body::Book(crate::sqlite::read(path)?),
        Data::Sheets => Body::Book(crate::sheets::read(path)?),
        Data::Weights => Body::Book(crate::weights::read(path)?),
    })
}

fn read_part(path: &Path, part: &str) -> Result<Table, String> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
    match path.is_absolute().then(|| kind_of(&ext)).flatten() {
        Some(Data::Npz) => crate::npy::read_npz_part(path, part),
        Some(Data::Sqlite) => crate::sqlite::read_part(path, part),
        Some(Data::Sheets) => crate::sheets::read_part(path, part),
        Some(Data::Weights) => crate::weights::read_part(path, part),
        _ => Err("this file has no parts".into()),
    }
}

#[tauri::command]
pub async fn read_data_part(window: tauri::Window, path: String, part: String) -> Result<Table, String> {
    if crate::watcher::is_ejecting(&path) {
        return Err("volume is being ejected".to_string());
    }
    crate::reader::check_granted(window.label(), Path::new(&path))?;
    crate::jobs::blocking(move || read_part(Path::new(&path), &part)).await?
}

pub fn thousands(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn sniff_delimiter(head: &[u8]) -> u8 {
    let mut counts = [0usize; 4];
    let mut quoted = false;
    for &b in head {
        match b {
            b'"' => quoted = !quoted,
            b'\n' if !quoted => break,
            _ if quoted => {}
            b',' => counts[0] += 1,
            b';' => counts[1] += 1,
            b'\t' => counts[2] += 1,
            b'|' => counts[3] += 1,
            _ => {}
        }
    }
    let best = (0..4).max_by_key(|&i| (counts[i], std::cmp::Reverse(i))).unwrap();
    if counts[best] == 0 {
        b','
    } else {
        b",;\t|"[best]
    }
}

fn read_csv(path: &Path, delimiter: Option<u8>) -> Result<Table, String> {
    let mut head = Vec::with_capacity(64 * 1024);
    fs::File::open(path)
        .and_then(|f| f.take(64 * 1024).read_to_end(&mut head))
        .map_err(|e| e.to_string())?;
    if head[..head.len().min(8192)].contains(&0) {
        return Err("it looks like a binary file".into());
    }
    let delimiter = delimiter.unwrap_or_else(|| sniff_delimiter(&head));
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true)
        .from_path(path)
        .map_err(|e| e.to_string())?;
    let text = |field: &[u8]| String::from_utf8_lossy(field).into_owned();
    let mut record = csv::ByteRecord::new();
    let mut names: Vec<String> = Vec::new();
    let mut rows = Vec::new();
    let mut total = 0u64;
    let mut more = false;
    let mut first = true;
    while reader.read_byte_record(&mut record).map_err(|e| e.to_string())? {
        if first {
            first = false;
            names = record.iter().map(text).collect();
            continue;
        }
        total += 1;
        if rows.len() < ROW_LIMIT {
            rows.push(record.iter().map(|f| Some(text(f))).collect::<Vec<_>>());
        } else if reader.position().byte() > COUNT_BYTES {
            more = true;
            break;
        }
    }
    let width = rows.iter().map(Vec::len).max().unwrap_or(0).max(names.len());
    for i in names.len()..width {
        names.push(format!("Column {}", i + 1));
    }
    let separator = match delimiter {
        b'\t' => "Tab",
        b';' => "Semicolon",
        b'|' => "Bar",
        _ => "Comma",
    };
    Ok(Table {
        columns: Table::named(names),
        rows,
        total_rows: Some(total),
        more,
        facts: vec![("Separator".into(), separator.into())],
        ..Table::default()
    })
}

fn json_cell(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

/// Columns are the keys in order of first appearance. Lines that are not objects go in a `value` column.
fn read_json_lines(path: &Path) -> Result<Table, String> {
    use std::io::BufRead;
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut lines = std::io::BufReader::new(file);
    let mut names: Vec<String> = Vec::new();
    let mut index = std::collections::HashMap::<String, usize>::new();
    // IndexMap keeps the key order of each line.
    let mut parsed: Vec<Result<indexmap::IndexMap<String, serde_json::Value>, serde_json::Value>> = Vec::new();
    let (mut total, mut bad, mut read) = (0u64, 0u64, 0u64);
    let mut more = false;
    let mut line = Vec::new();
    loop {
        line.clear();
        let n = lines.read_until(b'\n', &mut line).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        read += n as u64;
        let text = std::str::from_utf8(&line).map(str::trim);
        if text.is_ok_and(str::is_empty) {
            continue;
        }
        total += 1;
        if parsed.len() >= ROW_LIMIT {
            if read > COUNT_BYTES {
                more = true;
                break;
            }
            continue;
        }
        let Ok(text) = text else {
            bad += 1;
            continue;
        };
        let row = match serde_json::from_str::<indexmap::IndexMap<String, serde_json::Value>>(text) {
            Ok(map) => Ok(map),
            Err(_) => match serde_json::from_str::<serde_json::Value>(text) {
                Ok(other) => Err(other),
                Err(_) => {
                    bad += 1;
                    continue;
                }
            },
        };
        let keys: Vec<String> = match &row {
            Ok(map) => map.keys().cloned().collect(),
            Err(_) => vec!["value".into()],
        };
        for k in keys {
            if !index.contains_key(&k) {
                index.insert(k.clone(), names.len());
                names.push(k);
            }
        }
        parsed.push(row);
    }
    let rows = parsed
        .iter()
        .map(|v| {
            let mut row = vec![None; names.len()];
            match v {
                Ok(map) => {
                    for (k, val) in map {
                        row[index[k]] = json_cell(val);
                    }
                }
                Err(other) => row[index["value"]] = json_cell(other),
            }
            row
        })
        .collect();
    let mut facts = Vec::new();
    if bad > 0 {
        facts.push(("Unreadable lines".into(), thousands(bad)));
    }
    Ok(Table { columns: Table::named(names), rows, total_rows: Some(total - bad), more, facts, ..Table::default() })
}

fn parquet_type(t: &parquet::schema::types::Type) -> String {
    use parquet::basic::{ConvertedType, LogicalType};
    let info = t.get_basic_info();
    // Older writers mark text with the converted type only.
    if info.logical_type_ref().is_none() && info.converted_type() == ConvertedType::UTF8 {
        return "string".into();
    }
    match info.logical_type_ref() {
        Some(LogicalType::Integer { .. }) | None => {
            if t.is_primitive() {
                format!("{:?}", t.get_physical_type()).to_lowercase()
            } else {
                "struct".into()
            }
        }
        Some(logical) => {
            let name = format!("{logical:?}");
            let end = name.find([' ', '(', '{']).unwrap_or(name.len());
            name[..end].to_lowercase()
        }
    }
}

/// The row reader returns nanosecond timestamps as plain numbers.
fn is_nanos(t: &parquet::schema::types::Type) -> bool {
    use parquet::basic::{LogicalType, TimeUnit};
    matches!(t.get_basic_info().logical_type_ref(), Some(LogicalType::Timestamp(ts)) if ts.unit == TimeUnit::NANOS)
}

fn parquet_value(field: &parquet::record::Field, nanos: bool) -> Option<String> {
    use parquet::record::Field;
    match field {
        Field::Null => None,
        Field::Str(s) => Some(s.clone()),
        Field::Long(ns) if nanos => Some(datetime(*ns)),
        other => Some(other.to_string()),
    }
}

/// Format `ns` nanoseconds since 1970 as a UTC date and time, as pandas does.
pub fn datetime(ns: i64) -> String {
    let secs = ns.div_euclid(1_000_000_000);
    let frac = ns.rem_euclid(1_000_000_000);
    let (days, time) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Date from a day count: Howard Hinnant's algorithm.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let clock = format!("{:02}:{:02}:{:02}", time / 3600, time / 60 % 60, time % 60);
    let frac = if frac == 0 { String::new() } else { format!(".{frac:09}").trim_end_matches('0').to_string() };
    format!("{year:04}-{month:02}-{day:02} {clock}{frac}")
}

/// Return `None` if any row group has no stored statistics.
fn parquet_stats(meta: &parquet::file::metadata::ParquetMetaData, leaf: usize, nanos: bool, text: bool) -> Option<Stats> {
    use parquet::basic::ConvertedType as C;
    use parquet::file::statistics::Statistics as S;
    use parquet::record::Field;
    // A bound is a sort key and its text. Numbers compare as numbers.
    type Bound = (Result<f64, String>, String);
    let num = |v: f64, shown: String| -> Bound { (Ok(v), shown) };
    // The conversion the row reader uses, so a bound reads like the cells.
    let descr = meta.file_metadata().schema_descr().column(leaf);
    let unsigned = matches!(descr.converted_type(), C::UINT_8 | C::UINT_16 | C::UINT_32 | C::UINT_64);
    let mut nulls = Some(0u64);
    let (mut lo, mut hi): (Option<Bound>, Option<Bound>) = (None, None);
    for group in meta.row_groups() {
        let st = group.column(leaf).statistics()?;
        nulls = nulls.zip(st.null_count_opt()).map(|(a, b)| a + b);
        let (min, max): (Option<Bound>, Option<Bound>) = match st {
            S::Boolean(v) => {
                let b = |x: &bool| num(f64::from(u8::from(*x)), x.to_string());
                (v.min_opt().map(b), v.max_opt().map(b))
            }
            S::Int32(v) => {
                let b = |x: &i32| {
                    let key = if unsigned { f64::from(*x as u32) } else { f64::from(*x) };
                    num(key, Field::convert_int32(&descr, *x).to_string())
                };
                (v.min_opt().map(b), v.max_opt().map(b))
            }
            S::Int64(v) => {
                let b = |x: &i64| {
                    let key = if unsigned { *x as u64 as f64 } else { *x as f64 };
                    num(key, parquet_value(&Field::convert_int64(&descr, *x), nanos).unwrap_or_default())
                };
                (v.min_opt().map(b), v.max_opt().map(b))
            }
            S::Float(v) => {
                let b = |x: &f32| num(f64::from(*x), float(f64::from(*x)));
                (v.min_opt().map(b), v.max_opt().map(b))
            }
            S::Double(v) => {
                let b = |x: &f64| num(*x, float(*x));
                (v.min_opt().map(b), v.max_opt().map(b))
            }
            S::ByteArray(v) if text => {
                let b = |x: &parquet::data_type::ByteArray| {
                    let s = String::from_utf8_lossy(x.data()).into_owned();
                    (Err(s.clone()), s)
                };
                (v.min_opt().map(b), v.max_opt().map(b))
            }
            _ => (None, None),
        };
        let less = |a: &Bound, b: &Bound| match (&a.0, &b.0) {
            (Ok(x), Ok(y)) => x < y,
            (Err(x), Err(y)) => x < y,
            _ => false,
        };
        if let Some(m) = min {
            if lo.as_ref().is_none_or(|l| less(&m, l)) {
                lo = Some(m);
            }
        }
        if let Some(m) = max {
            if hi.as_ref().is_none_or(|h| less(h, &m)) {
                hi = Some(m);
            }
        }
    }
    let stats = Stats { min: lo.map(|b| b.1), max: hi.map(|b| b.1), nulls };
    (stats != Stats::default()).then_some(stats)
}

fn read_parquet(path: &Path) -> Result<Table, String> {
    use parquet::file::reader::{FileReader, SerializedFileReader};
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let reader = SerializedFileReader::new(file).map_err(|e| e.to_string())?;
    let meta = reader.metadata();
    let file_meta = meta.file_metadata();
    let fields = file_meta.schema_descr().root_schema().get_fields();
    let nanos: Vec<bool> = fields.iter().map(|f| is_nanos(f)).collect();
    // A top-level field that is not nested is one leaf column.
    let leaves = file_meta.schema_descr().columns();
    let columns = fields
        .iter()
        .enumerate()
        .map(|(i, f)| {
            let leaf = leaves.iter().position(|c| c.path().parts() == [f.name().to_string()]);
            let text = matches!(parquet_type(f).as_str(), "string" | "enum" | "json");
            Column {
                name: f.name().to_string(),
                ty: Some(parquet_type(f)),
                stats: leaf.and_then(|leaf| parquet_stats(meta, leaf, nanos[i], text)),
            }
        })
        .collect();
    let mut rows = Vec::new();
    for row in reader.get_row_iter(None).map_err(|e| e.to_string())?.take(ROW_LIMIT) {
        let row = row.map_err(|e| e.to_string())?;
        let cells = row.get_column_iter().enumerate();
        rows.push(cells.map(|(i, (_, f))| parquet_value(f, nanos.get(i) == Some(&true))).collect());
    }
    let mut codecs: Vec<String> = Vec::new();
    for c in meta.row_groups().iter().flat_map(|g| g.columns()) {
        let codec = format!("{:?}", c.compression());
        let codec = codec[..codec.find('(').unwrap_or(codec.len())].to_lowercase();
        if !codecs.contains(&codec) {
            codecs.push(codec);
        }
    }
    let mut facts = vec![
        ("Row groups".into(), thousands(meta.num_row_groups() as u64)),
        ("Compression".into(), if codecs.is_empty() { "none".into() } else { codecs.join(", ") }),
    ];
    if let Some(by) = file_meta.created_by() {
        facts.push(("Written by".into(), by.to_string()));
    }
    Ok(Table {
        columns,
        rows,
        total_rows: Some(file_meta.num_rows().max(0) as u64),
        more: false,
        facts,
        ..Table::default()
    })
}

/// Read batches until `ROW_LIMIT` rows. The rest is not decoded, so the size is known only for a smaller file.
fn read_arrow(path: &Path) -> Result<Table, String> {
    use arrow_array::RecordBatch;
    use arrow_cast::display::{ArrayFormatter, FormatOptions};
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut magic = [0u8; 6];
    let n = file.read(&mut magic).map_err(|e| e.to_string())?;
    if magic[..n].starts_with(b"FEA1") {
        return Err("it's Feather version 1, which Doftar doesn't read; pyarrow can rewrite it as version 2".into());
    }
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let bad = |e: arrow_schema::ArrowError| format!("it isn't an Arrow file ({e})");
    let (schema, batches): (_, Box<dyn Iterator<Item = Result<RecordBatch, _>>>) = if &magic[..n] == b"ARROW1" {
        let r = arrow_ipc::reader::FileReader::try_new(std::io::BufReader::new(file), None).map_err(bad)?;
        (r.schema(), Box::new(r))
    } else {
        let r = arrow_ipc::reader::StreamReader::try_new(std::io::BufReader::new(file), None).map_err(bad)?;
        (r.schema(), Box::new(r))
    };
    let columns = schema
        .fields()
        .iter()
        .map(|f| Column { name: f.name().clone(), ty: Some(f.data_type().to_string()), stats: None })
        .collect();
    let options = FormatOptions::default();
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let mut more = false;
    for batch in batches {
        if rows.len() >= ROW_LIMIT {
            more = true;
            break;
        }
        let batch = batch.map_err(|e| e.to_string())?;
        let shown: Vec<_> = batch
            .columns()
            .iter()
            .map(|a| ArrayFormatter::try_new(a.as_ref(), &options).map(|f| (a, f)))
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        let take = batch.num_rows().min(ROW_LIMIT - rows.len());
        more = take < batch.num_rows();
        for i in 0..take {
            rows.push(shown.iter().map(|(a, f)| (!a.is_null(i)).then(|| f.value(i).to_string())).collect());
        }
    }
    Ok(Table { columns, total_rows: Some(rows.len() as u64), more, rows, ..Table::default() })
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct H5Node {
    name: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    shape: Vec<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dtype: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    attrs: Vec<(String, String)>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    children: Vec<H5Node>,
    #[serde(skip_serializing_if = "is_zero")]
    hidden: usize,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Key {
    name: String,
    detail: String,
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    name: &'static str,
    keys: Vec<Key>,
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AnnData {
    n_obs: u64,
    n_vars: u64,
    x: Option<String>,
    sections: Vec<Section>,
    raw: Option<(u64, u64, Vec<Section>)>,
    obs: Option<Table>,
    var: Option<Table>,
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Hdf5File {
    root: H5Node,
    #[serde(skip_serializing_if = "Option::is_none")]
    anndata: Option<AnnData>,
}

fn h5err(e: hdf5::Error) -> String {
    e.to_string()
}

/// Writers store a string attribute as Unicode or as ASCII. Accept both.
fn attr_string(loc: &hdf5::Location, name: &str) -> Option<String> {
    let a = loc.attr(name).ok()?;
    a.read_scalar::<VarLenUnicode>()
        .map(|s| s.as_str().to_string())
        .or_else(|_| a.read_scalar::<VarLenAscii>().map(|s| s.as_str().to_string()))
        .ok()
}

fn attr_strings(loc: &hdf5::Location, name: &str) -> Vec<String> {
    let Ok(a) = loc.attr(name) else { return Vec::new() };
    a.read_raw::<VarLenUnicode>()
        .map(|v| v.iter().map(|s| s.as_str().to_string()).collect())
        .or_else(|_| a.read_raw::<VarLenAscii>().map(|v| v.iter().map(|s| s.as_str().to_string()).collect()))
        .unwrap_or_default()
}

fn attr_u64s(loc: &hdf5::Location, name: &str) -> Vec<u64> {
    loc.attr(name).and_then(|a| a.read_raw::<u64>()).unwrap_or_default()
}

fn attr_text(loc: &hdf5::Location, name: &str) -> String {
    if let Some(s) = attr_string(loc, name) {
        return s;
    }
    let Ok(a) = loc.attr(name) else { return "?".into() };
    let list = |items: Vec<String>, n: usize| {
        let more = if n > 8 { ", …" } else { "" };
        if n == 1 && a.shape().is_empty() {
            items.join("")
        } else {
            format!("[{}{more}]", items.join(", "))
        }
    };
    if let Ok(v) = a.read_raw::<VarLenUnicode>() {
        return list(v.iter().take(8).map(|s| s.as_str().to_string()).collect(), v.len());
    }
    if let Ok(v) = a.read_raw::<i64>() {
        return list(v.iter().take(8).map(i64::to_string).collect(), v.len());
    }
    if let Ok(v) = a.read_raw::<f64>() {
        return list(v.iter().take(8).map(f64::to_string).collect(), v.len());
    }
    "…".into()
}

/// h5py stores booleans as an enum.
fn dtype_name(ds: &hdf5::Dataset) -> String {
    match ds.dtype().and_then(|t| t.to_descriptor()) {
        Ok(TypeDescriptor::Enum(e)) if e.members.iter().any(|m| m.name == "TRUE") => "bool".into(),
        Ok(TypeDescriptor::VarLenUnicode | TypeDescriptor::VarLenAscii) => "string".into(),
        Ok(TypeDescriptor::FixedAscii(_) | TypeDescriptor::FixedUnicode(_)) => "string".into(),
        Ok(d) => d.to_string(),
        Err(_) => "unknown".into(),
    }
}

fn walk(group: &hdf5::Group, name: String, budget: &mut usize, depth: usize) -> H5Node {
    let mut node = H5Node {
        name,
        kind: "group",
        shape: Vec::new(),
        dtype: None,
        attrs: attrs_of(group),
        children: Vec::new(),
        hidden: 0,
    };
    let members = group.member_names().unwrap_or_default();
    for member in &members {
        if node.children.len() >= MAX_MEMBERS || *budget == 0 || depth >= MAX_DEPTH {
            node.hidden += 1;
            continue;
        }
        *budget -= 1;
        if let Ok(g) = group.group(member) {
            node.children.push(walk(&g, member.clone(), budget, depth + 1));
        } else if let Ok(ds) = group.dataset(member) {
            node.children.push(H5Node {
                name: member.clone(),
                kind: "dataset",
                shape: ds.shape().into_iter().map(|n| n as u64).collect(),
                dtype: Some(dtype_name(&ds)),
                attrs: attrs_of(&ds),
                children: Vec::new(),
                hidden: 0,
            });
        } else {
            node.hidden += 1;
        }
    }
    node
}

fn attrs_of(loc: &hdf5::Location) -> Vec<(String, String)> {
    loc.attr_names()
        .unwrap_or_default()
        .into_iter()
        .take(24)
        .map(|n| {
            let v = attr_text(loc, &n);
            (n, v)
        })
        .collect()
}

fn read_hdf5(path: &Path) -> Result<Hdf5File, String> {
    if !is_hdf5(path) {
        return Err("it isn't an HDF5 file".into());
    }
    // Do not lock the file. A file open in a notebook must still open.
    let file = hdf5::File::with_options()
        .with_fapl(|p| p.file_locking(false))
        .open(path)
        .map_err(h5err)?;
    let mut budget = MAX_NODES;
    let root = walk(&file, "/".into(), &mut budget, 0);
    let anndata = (attr_string(&file, "encoding-type").as_deref() == Some("anndata")
        || path.extension().is_some_and(|e| e.eq_ignore_ascii_case("h5ad")))
    .then(|| anndata(&file))
    .flatten();
    Ok(Hdf5File { root, anndata })
}

/// The signature is at offset 0, or at 512, 1024 and so on after a user block.
fn is_hdf5(path: &Path) -> bool {
    const SIG: &[u8] = b"\x89HDF\r\n\x1a\n";
    let mut head = Vec::new();
    let _ = fs::File::open(path).and_then(|f| f.take(4096 + 8).read_to_end(&mut head));
    (0..=4096).step_by(512).any(|at| head.get(at..at + 8) == Some(SIG))
}

fn encoding(loc: &hdf5::Location) -> Option<String> {
    attr_string(loc, "encoding-type")
}

fn matrix(parent: &hdf5::Group, name: &str) -> Option<(Vec<u64>, String)> {
    if let Ok(ds) = parent.dataset(name) {
        let shape: Vec<u64> = ds.shape().into_iter().map(|n| n as u64).collect();
        return Some((shape, dtype_name(&ds)));
    }
    let g = parent.group(name).ok()?;
    let enc = encoding(&g).unwrap_or_default();
    match enc.as_str() {
        "csr_matrix" | "csc_matrix" => {
            let shape = attr_u64s(&g, "shape");
            let data = g.dataset("data").ok();
            let dtype = data.as_ref().map_or("?".into(), dtype_name);
            let stored = data.map_or(0, |d| d.size() as u64);
            let cells = shape.iter().fold(1u64, |a, &d| a.saturating_mul(d)).max(1);
            let format = if enc == "csr_matrix" { "CSR" } else { "CSC" };
            let share = stored as f64 * 100.0 / cells as f64;
            Some((shape, format!("{dtype} · sparse {format} · {} stored ({share:.1}%)", thousands(stored))))
        }
        "dataframe" => {
            let cols = attr_strings(&g, "column-order").len();
            Some((Vec::new(), format!("dataframe · {cols} columns")))
        }
        "" => None,
        other => Some((Vec::new(), other.to_string())),
    }
}

fn keys(n: usize) -> String {
    if n == 1 { "1 key".into() } else { format!("{n} keys") }
}

fn dims(shape: &[u64]) -> String {
    shape.iter().map(|&n| thousands(n)).collect::<Vec<_>>().join(" × ")
}

fn mapping(file: &hdf5::Group, name: &'static str) -> Option<Section> {
    let g = file.group(name).ok()?;
    let keys: Vec<Key> = g
        .member_names()
        .unwrap_or_default()
        .into_iter()
        .map(|k| {
            let detail = match matrix(&g, &k) {
                Some((shape, what)) if shape.is_empty() => what,
                Some((shape, what)) => format!("{} · {what}", dims(&shape)),
                None => match g.group(&k) {
                    Ok(sub) => keys(sub.member_names().map_or(0, |m| m.len())),
                    Err(_) => String::new(),
                },
            };
            Key { name: k, detail }
        })
        .collect();
    (!keys.is_empty()).then_some(Section { name, keys })
}

fn uns(file: &hdf5::Group) -> Option<Section> {
    let g = file.group("uns").ok()?;
    let keys: Vec<Key> = g
        .member_names()
        .unwrap_or_default()
        .into_iter()
        .map(|k| {
            let detail = if let Ok(ds) = g.dataset(&k) {
                let shape = ds.shape();
                if shape.is_empty() {
                    dtype_name(&ds)
                } else {
                    format!("{} · {}", dtype_name(&ds), dims(&shape.iter().map(|&n| n as u64).collect::<Vec<_>>()))
                }
            } else if let Ok(sub) = g.group(&k) {
                match encoding(&sub).as_deref() {
                    Some("dict") | None => format!("dict · {}", keys(sub.member_names().map_or(0, |m| m.len()))),
                    Some(other) => other.to_string(),
                }
            } else {
                String::new()
            };
            Key { name: k, detail }
        })
        .collect();
    (!keys.is_empty()).then_some(Section { name: "uns", keys })
}

fn frame_columns(file: &hdf5::Group, name: &str) -> Vec<String> {
    if let Ok(g) = file.group(name) {
        return attr_strings(&g, "column-order");
    }
    match file.dataset(name).and_then(|d| d.dtype()).and_then(|t| t.to_descriptor()) {
        Ok(TypeDescriptor::Compound(c)) => {
            c.fields.into_iter().map(|f| f.name).filter(|n| n != "index").collect()
        }
        _ => Vec::new(),
    }
}

fn column_kind(frame: &hdf5::Group, name: &str) -> String {
    if let Ok(ds) = frame.dataset(name) {
        return dtype_name(&ds);
    }
    let Ok(g) = frame.group(name) else { return String::new() };
    match encoding(&g).as_deref() {
        Some("categorical") => {
            let n = g.dataset("categories").map_or(0, |c| c.size());
            format!("category · {n}")
        }
        Some("nullable-integer") => "Int64".into(),
        Some("nullable-boolean") => "boolean".into(),
        Some("nullable-string-array") => "string".into(),
        Some(other) => other.into(),
        None => String::new(),
    }
}

fn frame_section(file: &hdf5::Group, name: &'static str) -> Option<Section> {
    let cols = frame_columns(file, name);
    if cols.is_empty() {
        return None;
    }
    let frame = file.group(name).ok();
    let keys = cols
        .into_iter()
        .map(|c| {
            let detail = frame.as_ref().map_or(String::new(), |f| column_kind(f, &c));
            Key { name: c, detail }
        })
        .collect();
    Some(Section { name, keys })
}

fn values(ds: &hdf5::Dataset, n: usize) -> Option<Vec<Option<String>>> {
    let n = n.min(ds.shape().first().copied().unwrap_or(0));
    let sel = 0..n;
    let text = |v: Vec<String>| Some(v.into_iter().map(Some).collect());
    match ds.dtype().and_then(|t| t.to_descriptor()).ok()? {
        TypeDescriptor::Integer(_) => text(ds.read_slice_1d::<i64, _>(sel).ok()?.iter().map(i64::to_string).collect()),
        TypeDescriptor::Unsigned(_) => text(ds.read_slice_1d::<u64, _>(sel).ok()?.iter().map(u64::to_string).collect()),
        TypeDescriptor::Float(_) => text(ds.read_slice_1d::<f64, _>(sel).ok()?.iter().map(|v| float(*v)).collect()),
        TypeDescriptor::Boolean => text(ds.read_slice_1d::<bool, _>(sel).ok()?.iter().map(bool::to_string).collect()),
        TypeDescriptor::Enum(e) => {
            let codes = ds.read_slice_1d::<i64, _>(sel).ok()?;
            let named = |c: &i64| {
                let m = e.members.iter().find(|m| m.value as i64 == *c);
                match m.map(|m| m.name.as_str()) {
                    Some("TRUE") => "true".to_string(),
                    Some("FALSE") => "false".to_string(),
                    Some(name) => name.to_string(),
                    None => c.to_string(),
                }
            };
            text(codes.iter().map(named).collect())
        }
        TypeDescriptor::VarLenUnicode => {
            text(ds.read_slice_1d::<VarLenUnicode, _>(sel).ok()?.iter().map(|s| s.as_str().to_string()).collect())
        }
        TypeDescriptor::VarLenAscii => {
            text(ds.read_slice_1d::<VarLenAscii, _>(sel).ok()?.iter().map(|s| s.as_str().to_string()).collect())
        }
        _ => None,
    }
}

/// Format a float as pandas does.
pub fn float(v: f64) -> String {
    if v.is_nan() {
        return "NaN".into();
    }
    if v.fract() == 0.0 && v.abs() < 1e15 {
        return format!("{v:.1}");
    }
    let s = format!("{v:.6}");
    s.trim_end_matches('0').to_string()
}

fn column_values(frame: &hdf5::Group, name: &str, n: usize) -> Option<Vec<Option<String>>> {
    if let Ok(ds) = frame.dataset(name) {
        return values(&ds, n);
    }
    let g = frame.group(name).ok()?;
    match encoding(&g).as_deref()? {
        "categorical" => {
            let categories = values(&g.dataset("categories").ok()?, usize::MAX)?;
            let codes = g.dataset("codes").ok()?.read_slice_1d::<i64, _>(0..n.min(g.dataset("codes").ok()?.size())).ok()?;
            Some(
                codes
                    .iter()
                    .map(|&c| usize::try_from(c).ok().and_then(|c| categories.get(c).cloned().flatten()))
                    .collect(),
            )
        }
        "nullable-integer" | "nullable-boolean" | "nullable-string-array" => {
            let vals = values(&g.dataset("values").ok()?, n)?;
            let mask = values(&g.dataset("mask").ok()?, n).unwrap_or_default();
            Some(
                vals.into_iter()
                    .enumerate()
                    .map(|(i, v)| if mask.get(i).cloned().flatten().as_deref() == Some("true") { None } else { v })
                    .collect(),
            )
        }
        _ => None,
    }
}

fn frame_table(file: &hdf5::Group, name: &str, n_rows: u64) -> Option<Table> {
    let frame = file.group(name).ok()?;
    let index_name = attr_string(&frame, "_index").unwrap_or_else(|| "_index".into());
    let cols = attr_strings(&frame, "column-order");
    let n = FRAME_ROWS.min(n_rows as usize);
    let mut columns = vec![Column::default()];
    let mut data = vec![frame.dataset(&index_name).ok().and_then(|d| values(&d, n)).unwrap_or_default()];
    for c in cols {
        columns.push(Column { ty: Some(column_kind(&frame, &c)), name: c.clone(), stats: None });
        data.push(column_values(&frame, &c, n).unwrap_or_else(|| vec![Some("…".into()); n]));
    }
    let rows = (0..n).map(|i| data.iter().map(|col| col.get(i).cloned().flatten()).collect()).collect();
    Some(Table { columns, rows, total_rows: Some(n_rows), ..Table::default() })
}

fn frame_len(file: &hdf5::Group, name: &str) -> Option<u64> {
    if let Ok(g) = file.group(name) {
        let index = attr_string(&g, "_index").unwrap_or_else(|| "_index".into());
        return g.dataset(&index).ok().map(|d| d.size() as u64);
    }
    file.dataset(name).ok().map(|d| d.size() as u64)
}

fn anndata(file: &hdf5::Group) -> Option<AnnData> {
    let x = matrix(file, "X");
    let n_obs = frame_len(file, "obs").or_else(|| x.as_ref().and_then(|(s, _)| s.first().copied()))?;
    let n_vars = frame_len(file, "var").or_else(|| x.as_ref().and_then(|(s, _)| s.get(1).copied()))?;
    let sections = [
        frame_section(file, "obs"),
        frame_section(file, "var"),
        uns(file),
        mapping(file, "obsm"),
        mapping(file, "varm"),
        mapping(file, "layers"),
        mapping(file, "obsp"),
        mapping(file, "varp"),
    ]
    .into_iter()
    .flatten()
    .collect();
    let raw = file.group("raw").ok().map(|raw| {
        let raw_vars = frame_len(&raw, "var").unwrap_or(n_vars);
        let parts = [frame_section(&raw, "var"), mapping(&raw, "varm")].into_iter().flatten().collect();
        (n_obs, raw_vars, parts)
    });
    Some(AnnData {
        n_obs,
        n_vars,
        x: x.map(|(_, what)| what),
        sections,
        raw,
        obs: frame_table(file, "obs", n_obs),
        var: frame_table(file, "var", n_vars),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("doftar-data-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn cell(t: &Table, row: usize, col: usize) -> Option<&str> {
        t.rows[row][col].as_deref()
    }

    #[test]
    fn prints_nanosecond_timestamps_as_dates() {
        assert_eq!(datetime(1_704_067_200_000_000_000), "2024-01-01 00:00:00");
        assert_eq!(datetime(951_782_400_500_000_000), "2000-02-29 00:00:00.5");
        assert_eq!(datetime(-1), "1969-12-31 23:59:59.999999999");
    }

    #[test]
    fn sniffs_the_separator_outside_quotes() {
        assert_eq!(sniff_delimiter(b"a;b;c\n1;2;3"), b';');
        assert_eq!(sniff_delimiter(b"\"x,y,z\"\tb\n"), b'\t');
        assert_eq!(sniff_delimiter(b"single\n"), b',');
    }

    #[test]
    fn reads_csv_with_quotes_bom_and_ragged_rows() {
        let dir = scratch("csv");
        let f = dir.join("t.csv");
        fs::write(&f, "\u{feff}a,b\n\"multi\nline\",2\n\"x, y\",3,extra\n").unwrap();
        let t = read_csv(&f, None).unwrap();
        let names: Vec<_> = t.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["a", "b", "Column 3"]);
        assert_eq!(t.total_rows, Some(2));
        assert_eq!(cell(&t, 0, 0), Some("multi\nline"));
        assert_eq!(cell(&t, 1, 0), Some("x, y"));
        assert_eq!(cell(&t, 1, 2), Some("extra"));

        let tsv = dir.join("t.tsv");
        fs::write(&tsv, "a\tb\n1\t2\n").unwrap();
        let Body::Table(t) = read(&tsv, Data::Tsv).unwrap() else { panic!() };
        assert_eq!(cell(&t, 0, 1), Some("2"));

        let bin = dir.join("b.csv");
        fs::write(&bin, [0u8, 1, 2]).unwrap();
        assert!(read_csv(&bin, None).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_json_lines_keeping_key_order() {
        let dir = scratch("jsonl");
        let f = dir.join("t.jsonl");
        fs::write(&f, "{\"z\": 1, \"a\": {\"n\": [1]}}\n\nnot json\n{\"a\": null, \"b\": \"x\"}\n[1, 2]\n").unwrap();
        let Body::Table(t) = read(&f, Data::JsonLines).unwrap() else { panic!() };
        let names: Vec<_> = t.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["z", "a", "b", "value"]);
        assert_eq!(t.total_rows, Some(3));
        assert_eq!(t.rows[0], [Some("1".into()), Some("{\"n\":[1]}".into()), None, None]);
        assert_eq!(t.rows[1], [None, None, Some("x".into()), None]);
        assert_eq!(t.rows[2][3].as_deref(), Some("[1,2]"));
        assert_eq!(t.facts, [("Unreadable lines".to_string(), "1".to_string())]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn counts_a_non_utf8_json_line_as_unreadable() {
        let dir = scratch("jsonl-bytes");
        let f = dir.join("t.jsonl");
        fs::write(&f, b"{\"a\": 1}\n{\"a\": \"\xff\"}\n{\"a\": 2}\n").unwrap();
        let Body::Table(t) = read(&f, Data::JsonLines).unwrap() else { panic!() };
        assert_eq!(t.total_rows, Some(2));
        assert_eq!(t.rows[1][0].as_deref(), Some("2"));
        assert_eq!(t.facts, [("Unreadable lines".to_string(), "1".to_string())]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn parquet_bounds_read_like_their_cells() {
        use parquet::data_type::{Int32Type, Int64Type};
        use parquet::file::writer::SerializedFileWriter;
        let dir = scratch("pq-types");
        let f = dir.join("t.parquet");
        let schema = std::sync::Arc::new(
            parquet::schema::parser::parse_message_type(
                "message m { required int32 d (DATE); required int64 t (TIMESTAMP_MILLIS); required int64 u (UINT_64); }",
            )
            .unwrap(),
        );
        let mut w = SerializedFileWriter::new(fs::File::create(&f).unwrap(), schema, Default::default()).unwrap();
        // The second `u` is u64::MAX, stored as -1. It must sort above 1.
        for (d, t, u) in [(19_000, 1_700_000_000_000i64, 1i64), (19_500, 1_710_000_000_000, -1)] {
            let mut g = w.next_row_group().unwrap();
            let mut c = g.next_column().unwrap().unwrap();
            c.typed::<Int32Type>().write_batch(&[d], None, None).unwrap();
            c.close().unwrap();
            for v in [t, u] {
                let mut c = g.next_column().unwrap().unwrap();
                c.typed::<Int64Type>().write_batch(&[v], None, None).unwrap();
                c.close().unwrap();
            }
            g.close().unwrap();
        }
        w.close().unwrap();
        let t = read_parquet(&f).unwrap();
        for col in 0..3 {
            let s = t.columns[col].stats.as_ref().unwrap();
            assert_eq!(s.min.as_deref(), cell(&t, 0, col), "min of column {col}");
            assert_eq!(s.max.as_deref(), cell(&t, 1, col), "max of column {col}");
        }
        assert_eq!(cell(&t, 1, 2), Some("18446744073709551615"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_group_linked_into_itself_stops_at_the_depth_limit() {
        let dir = scratch("h5-loop");
        let f = dir.join("t.h5");
        {
            let file = hdf5::File::create(&f).unwrap();
            file.create_group("g").unwrap();
            file.link_hard("/g", "/g/self").unwrap();
        }
        let h = read_hdf5(&f).unwrap();
        let (mut node, mut depth) = (&h.root, 0);
        while let Some(child) = node.children.first() {
            (node, depth) = (child, depth + 1);
        }
        assert_eq!(depth, MAX_DEPTH);
        assert_eq!(node.hidden, 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_parquet_column_statistics() {
        use parquet::data_type::{ByteArray, ByteArrayType, Int64Type};
        use parquet::file::writer::SerializedFileWriter;
        let dir = scratch("pq");
        let f = dir.join("t.parquet");
        let schema = std::sync::Arc::new(
            parquet::schema::parser::parse_message_type(
                "message m { optional int64 n; optional binary s (UTF8); }",
            )
            .unwrap(),
        );
        let mut w = SerializedFileWriter::new(fs::File::create(&f).unwrap(), schema, Default::default()).unwrap();
        // Use two row groups to test combined figures.
        for (ns, ss) in [([5i64, -3], ["b", "q"]), ([40, 7], ["a", "c"])] {
            let mut g = w.next_row_group().unwrap();
            let mut c = g.next_column().unwrap().unwrap();
            c.typed::<Int64Type>().write_batch(&ns, Some(&[1, 1, 0]), None).unwrap();
            c.close().unwrap();
            let mut c = g.next_column().unwrap().unwrap();
            let ss: Vec<ByteArray> = ss.iter().map(|s| (*s).into()).collect();
            c.typed::<ByteArrayType>().write_batch(&ss, Some(&[1, 1, 0]), None).unwrap();
            c.close().unwrap();
            g.close().unwrap();
        }
        w.close().unwrap();
        let t = read_parquet(&f).unwrap();
        let n = t.columns[0].stats.as_ref().unwrap();
        assert_eq!((n.min.as_deref(), n.max.as_deref(), n.nulls), (Some("-3"), Some("40"), Some(2)));
        let s = t.columns[1].stats.as_ref().unwrap();
        assert_eq!((s.min.as_deref(), s.max.as_deref(), s.nulls), (Some("a"), Some("q"), Some(2)));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_compressed_feather_and_arrow_streams() {
        use arrow_array::{ArrayRef, Int64Array, RecordBatch, StringArray};
        use arrow_ipc::writer::{FileWriter, IpcWriteOptions, StreamWriter};
        use std::sync::Arc;
        let dir = scratch("arrow");
        let n: ArrayRef = Arc::new(Int64Array::from(vec![Some(1), None, Some(3)]));
        let s: ArrayRef = Arc::new(StringArray::from(vec!["a", "b", "c"]));
        let batch = RecordBatch::try_from_iter([("n", n), ("s", s)]).unwrap();
        // pyarrow writes Feather with LZ4 by default.
        let lz4 = IpcWriteOptions::default()
            .try_with_compression(Some(arrow_ipc::CompressionType::LZ4_FRAME))
            .unwrap();
        let f = dir.join("t.feather");
        let mut w = FileWriter::try_new_with_options(fs::File::create(&f).unwrap(), &batch.schema(), lz4).unwrap();
        w.write(&batch).unwrap();
        w.write(&batch).unwrap();
        w.finish().unwrap();
        let t = read_arrow(&f).unwrap();
        assert_eq!(t.columns[0].ty.as_deref(), Some("Int64"));
        assert_eq!((t.total_rows, t.more), (Some(6), false));
        assert_eq!(t.rows[1], [None, Some("b".into())]);

        let g = dir.join("t.arrows");
        let mut w = StreamWriter::try_new(fs::File::create(&g).unwrap(), &batch.schema()).unwrap();
        w.write(&batch).unwrap();
        w.finish().unwrap();
        assert_eq!(read_arrow(&g).unwrap().rows[2], [Some("3".into()), Some("c".into())]);

        fs::write(&g, b"FEA1....").unwrap();
        assert!(read_arrow(&g).unwrap_err().contains("version 1"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn caps_rows_but_counts_them_all() {
        let dir = scratch("cap");
        let f = dir.join("big.csv");
        let mut s = String::from("n\n");
        for i in 0..ROW_LIMIT + 5 {
            s.push_str(&format!("{i}\n"));
        }
        fs::write(&f, s).unwrap();
        let t = read_csv(&f, None).unwrap();
        assert_eq!(t.rows.len(), ROW_LIMIT);
        assert_eq!(t.total_rows, Some(ROW_LIMIT as u64 + 5));
        assert!(!t.more);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_an_hdf5_file_and_its_anndata_summary() {
        let dir = scratch("h5");
        let f = dir.join("t.h5ad");
        {
            let file = hdf5::File::create(&f).unwrap();
            let s = |v: &str| v.parse::<VarLenUnicode>().unwrap();
            file.new_attr::<VarLenUnicode>().create("encoding-type").unwrap().write_scalar(&s("anndata")).unwrap();
            let x = file.new_dataset::<f32>().shape([3, 2]).create("X").unwrap();
            x.write_raw(&[1f32, 0., 0., 2., 3., 0.]).unwrap();
            let obs = file.create_group("obs").unwrap();
            obs.new_attr::<VarLenUnicode>().create("encoding-type").unwrap().write_scalar(&s("dataframe")).unwrap();
            obs.new_attr::<VarLenUnicode>().create("_index").unwrap().write_scalar(&s("_index")).unwrap();
            obs.new_attr::<VarLenUnicode>()
                .shape([2])
                .create("column-order")
                .unwrap()
                .write_raw(&[s("kind"), s("n")])
                .unwrap();
            obs.new_dataset_builder().with_data(&[s("c0"), s("c1"), s("c2")]).create("_index").unwrap();
            obs.new_dataset_builder().with_data(&[5i64, 6, 7]).create("n").unwrap();
            let kind = obs.create_group("kind").unwrap();
            kind.new_attr::<VarLenUnicode>().create("encoding-type").unwrap().write_scalar(&s("categorical")).unwrap();
            kind.new_dataset_builder().with_data(&[s("T"), s("B")]).create("categories").unwrap();
            kind.new_dataset_builder().with_data(&[1i8, 0, -1]).create("codes").unwrap();
            let var = file.create_group("var").unwrap();
            var.new_attr::<VarLenUnicode>().create("_index").unwrap().write_scalar(&s("_index")).unwrap();
            var.new_dataset_builder().with_data(&[s("g0"), s("g1")]).create("_index").unwrap();
            let obsm = file.create_group("obsm").unwrap();
            obsm.new_dataset::<f64>().shape([3, 2]).create("X_umap").unwrap();
        }
        let Body::Hdf5(h) = read(&f, Data::Hdf5).unwrap() else { panic!() };
        assert_eq!(h.root.children.len(), 4);
        let a = h.anndata.unwrap();
        assert_eq!((a.n_obs, a.n_vars), (3, 2));
        assert_eq!(a.x.as_deref(), Some("float32"));
        let obs = &a.sections[0];
        assert_eq!(obs.name, "obs");
        assert_eq!(obs.keys[0].name, "kind");
        assert_eq!(obs.keys[0].detail, "category · 2");
        assert!(a.sections.iter().any(|s| s.name == "obsm" && s.keys[0].detail.starts_with("3 × 2")));
        let t = a.obs.unwrap();
        assert_eq!(cell(&t, 0, 0), Some("c0"));
        assert_eq!(cell(&t, 0, 1), Some("B"));
        assert_eq!(cell(&t, 2, 1), None);
        assert_eq!(cell(&t, 2, 2), Some("7"));

        let not = dir.join("fake.h5");
        fs::write(&not, "hello").unwrap();
        assert_eq!(read_hdf5(&not).unwrap_err(), "it isn't an HDF5 file");
        fs::remove_dir_all(&dir).unwrap();
    }
}
