//! Spreadsheets: Excel (.xlsx, .xlsm, .xlsb, .xls) and OpenDocument (.ods).
//! Each sheet is a part, read when shown. Cells show the values last calculated by the file. Formulas are not read.

use std::path::Path;

use calamine::{open_workbook_auto, Data, Range, Reader, SheetType, SheetVisible};

use crate::data::{float, thousands, Book, Part, Table, ROW_LIMIT};

fn open(path: &Path) -> Result<calamine::Sheets<std::io::BufReader<std::fs::File>>, String> {
    open_workbook_auto(path).map_err(|e| {
        let e = e.to_string();
        if e.to_lowercase().contains("password") || e.to_lowercase().contains("encrypt") {
            "it's password-protected".into()
        } else {
            format!("it can't be read as a spreadsheet ({e})")
        }
    })
}

/// Column letters as in Excel: 0 is A, 26 is AA.
fn letters(mut n: u32) -> String {
    let mut out = Vec::new();
    loop {
        out.push(b'A' + (n % 26) as u8);
        if n < 26 {
            break;
        }
        n = n / 26 - 1;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

fn cell(d: &Data) -> Option<String> {
    Some(match d {
        Data::Empty => String::new(),
        Data::String(s) | Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        Data::Int(i) => i.to_string(),
        // Excel stores whole numbers as floats. Show them as integers.
        Data::Float(f) if f.fract() == 0.0 && f.abs() < 1e15 => format!("{}", *f as i64),
        Data::Float(f) => float(*f),
        Data::Bool(b) => if *b { "TRUE" } else { "FALSE" }.into(),
        Data::Error(e) => e.to_string(),
        Data::DateTime(t) if t.is_duration() => {
            let secs = (t.as_f64() * 86_400.0).round() as i64;
            format!("{}:{:02}:{:02}", secs / 3600, secs / 60 % 60, secs % 60)
        }
        Data::DateTime(t) => {
            let (y, mo, d, h, mi, s, _) = t.to_ymd_hms_milli();
            let time = format!("{h:02}:{mi:02}:{s:02}");
            if t.as_f64() < 1.0 {
                time
            } else if (h, mi, s) == (0, 0, 0) {
                format!("{y:04}-{mo:02}-{d:02}")
            } else {
                format!("{y:04}-{mo:02}-{d:02} {time}")
            }
        }
    })
}

/// A sheet as a table. The first row names the columns if all its filled cells are text. Each column also shows its letter.
fn table(range: &Range<Data>) -> Table {
    let (height, width) = range.get_size();
    let (_, first_col) = range.start().unwrap_or((0, 0));
    let mut rows = range.rows();
    let first: Vec<&Data> = range.rows().next().map(|r| r.iter().collect()).unwrap_or_default();
    let header = first.iter().any(|d| !matches!(d, Data::Empty))
        && first.iter().all(|d| matches!(d, Data::Empty | Data::String(_)));
    let names: Vec<String> = (0..width)
        .map(|j| match first.get(j) {
            Some(Data::String(s)) if header => s.clone(),
            _ => String::new(),
        })
        .collect();
    if header {
        rows.next();
    }
    let mut columns = Table::named(names);
    for (j, col) in columns.iter_mut().enumerate() {
        col.ty = Some(letters(first_col + j as u32));
    }
    let total = (height - usize::from(header)) as u64;
    Table {
        columns,
        rows: rows.take(ROW_LIMIT).map(|r| r.iter().map(cell).collect()).collect(),
        total_rows: Some(total),
        ..Table::default()
    }
}

pub fn read(path: &Path) -> Result<Book, String> {
    let mut book = open(path)?;
    let parts: Vec<Part> = book
        .sheets_metadata()
        .iter()
        .filter(|s| s.typ == SheetType::WorkSheet)
        .map(|s| Part {
            name: s.name.clone(),
            detail: if s.visible == SheetVisible::Visible { "sheet".into() } else { "hidden sheet".into() },
        })
        .collect();
    let first = match parts.first() {
        Some(p) => Some(table(&book.worksheet_range(&p.name).map_err(|e| e.to_string())?)),
        None => None,
    };
    let facts = vec![("Sheets".into(), thousands(parts.len() as u64))];
    Ok(Book { parts, first, facts, ..Book::default() })
}

pub fn read_part(path: &Path, name: &str) -> Result<Table, String> {
    let mut book = open(path)?;
    let range = book.worksheet_range(name).map_err(|_| format!("no sheet named “{name}”"))?;
    Ok(table(&range))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_columns_by_letter() {
        assert_eq!(letters(0), "A");
        assert_eq!(letters(25), "Z");
        assert_eq!(letters(26), "AA");
        assert_eq!(letters(701), "ZZ");
        assert_eq!(letters(702), "AAA");
    }

    #[test]
    fn uses_a_text_first_row_as_headers() {
        let mut r = Range::new((0, 1), (2, 2));
        r.set_value((0, 1), Data::String("name".into()));
        r.set_value((0, 2), Data::String("n".into()));
        r.set_value((1, 1), Data::String("a".into()));
        r.set_value((1, 2), Data::Float(3.0));
        r.set_value((2, 2), Data::Float(0.25));
        let t = table(&r);
        let cols: Vec<_> = t.columns.iter().map(|c| (c.name.as_str(), c.ty.as_deref().unwrap())).collect();
        assert_eq!(cols, [("name", "B"), ("n", "C")]);
        assert_eq!(t.total_rows, Some(2));
        assert_eq!(t.rows[0], [Some("a".into()), Some("3".into())]);
        assert_eq!(t.rows[1], [Some(String::new()), Some("0.25".into())]);

        // A first row of numbers is data, not headers.
        let mut r = Range::new((0, 0), (0, 0));
        r.set_value((0, 0), Data::Int(5));
        let t = table(&r);
        assert_eq!((t.columns[0].name.as_str(), t.rows.len()), ("", 1));
    }

    #[test]
    fn refuses_files_that_are_not_spreadsheets() {
        let dir = std::env::temp_dir().join(format!("doftar-sheets-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("fake.xlsx");
        std::fs::write(&f, "hello").unwrap();
        assert!(read(&f).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
