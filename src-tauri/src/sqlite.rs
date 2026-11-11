//! SQLite databases, opened read-only: tables, views and schema, each read when shown. Doftar never writes to them.

use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::{Duration, Instant};

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};

use crate::data::{float, thousands, Book, Part, Table, ROW_LIMIT};

/// Stop counting rows after this time. The count then says "at least".
const COUNT_FOR: Duration = Duration::from_secs(2);

/// `.db` is also used by other formats, so check the SQLite signature.
fn is_sqlite(path: &Path) -> bool {
    let mut head = [0u8; 16];
    fs::File::open(path).and_then(|mut f| f.read_exact(&mut head)).is_ok() && &head == b"SQLite format 3\0"
}

/// Percent-encode every byte that is not plainly safe.
fn uri(path: &Path) -> String {
    let mut out = String::from("file:");
    for &b in path.to_string_lossy().as_bytes() {
        if b.is_ascii_alphanumeric() || b"/._~-".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Open read-only. If a WAL database cannot be read that way (for example a read-only folder), open it as immutable. Immutable never writes.
fn open(path: &Path) -> Result<Connection, String> {
    if !is_sqlite(path) {
        return Err("it isn't a SQLite database".into());
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_URI;
    let usable = |c: Connection| -> rusqlite::Result<Connection> {
        c.query_row("SELECT count(*) FROM sqlite_schema", [], |_| Ok(()))?;
        c.pragma_update(None, "query_only", true)?;
        Ok(c)
    };
    Connection::open_with_flags(uri(path), flags)
        .and_then(usable)
        .or_else(|_| Connection::open_with_flags(format!("{}?immutable=1", uri(path)), flags).and_then(usable))
        .map_err(|e| e.to_string())
}

fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Tables first, then views, each by name. Skip SQLite's own tables.
fn parts(c: &Connection) -> rusqlite::Result<Vec<Part>> {
    let mut stmt = c.prepare(
        "SELECT type, name FROM sqlite_schema WHERE type IN ('table', 'view') \
         AND name NOT GLOB 'sqlite_*' ORDER BY type = 'view', name",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    rows.map(|row| {
        let (kind, name) = row?;
        let cols = c
            .prepare(&format!("PRAGMA table_info({})", quoted(&name)))
            .and_then(|mut s| s.query_map([], |_| Ok(())).map(|r| r.count()))
            .unwrap_or(0);
        Ok(Part { detail: format!("{kind} · {cols} column{}", if cols == 1 { "" } else { "s" }), name })
    })
    .collect()
}

fn schema(c: &Connection) -> rusqlite::Result<String> {
    let mut stmt = c.prepare(
        "SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' \
         ORDER BY type = 'view', type = 'index', type = 'trigger', name",
    )?;
    let sql: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    Ok(sql.into_iter().map(|s| format!("{s};")).collect::<Vec<_>>().join("\n\n"))
}

fn cell(v: ValueRef) -> Option<String> {
    match v {
        ValueRef::Null => None,
        ValueRef::Integer(i) => Some(i.to_string()),
        ValueRef::Real(f) => Some(float(f)),
        ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Some(format!("<blob {} bytes>", thousands(b.len() as u64))),
    }
}

/// Returns the first rows, the declared column types and the row count, counted up to `COUNT_FOR`.
fn table(c: &mut Connection, name: &str) -> rusqlite::Result<Table> {
    let q = quoted(name);
    let types: Vec<(String, String)> = c
        .prepare(&format!("PRAGMA table_info({q})"))?
        .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let (names, rows) = {
        let mut stmt = c.prepare(&format!("SELECT * FROM {q} LIMIT {ROW_LIMIT}"))?;
        let names: Vec<String> = stmt.column_names().map(str::to_string).collect();
        let width = names.len();
        let rows: Vec<Vec<Option<String>>> = stmt
            .query_map([], |r| (0..width).map(|i| r.get_ref(i).map(cell)).collect())?
            .collect::<rusqlite::Result<_>>()?;
        (names, rows)
    };
    let mut columns = Table::named(names);
    for col in &mut columns {
        col.ty = types.iter().find(|(n, _)| *n == col.name).map(|(_, t)| t.to_lowercase()).filter(|t| !t.is_empty());
    }
    let started = Instant::now();
    c.progress_handler(10_000, Some(move || started.elapsed() > COUNT_FOR))?;
    let count = c.query_row(&format!("SELECT count(*) FROM {q}"), [], |r| r.get::<_, i64>(0));
    c.progress_handler(0, None::<fn() -> bool>)?;
    let (total, more) = match count {
        Ok(n) => (n.max(0) as u64, false),
        Err(_) => (rows.len() as u64, true),
    };
    Ok(Table { columns, total_rows: Some(total), more, rows, ..Table::default() })
}

pub fn read(path: &Path) -> Result<Book, String> {
    let mut c = open(path)?;
    let parts = parts(&c).map_err(|e| e.to_string())?;
    let first = parts.first().and_then(|p| table(&mut c, &p.name).ok());
    let tables = parts.iter().filter(|p| p.detail.starts_with("table")).count();
    let facts = vec![
        ("Tables".into(), thousands(tables as u64)),
        ("Views".into(), thousands((parts.len() - tables) as u64)),
    ];
    Ok(Book { parts, first, schema: schema(&c).ok(), facts })
}

pub fn read_part(path: &Path, name: &str) -> Result<Table, String> {
    let mut c = open(path)?;
    if !parts(&c).map_err(|e| e.to_string())?.iter().any(|p| p.name == name) {
        return Err(format!("no table named “{name}”"));
    }
    table(&mut c, name).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("doftar-sqlite-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_tables_and_views_without_writing() {
        let dir = scratch("read");
        let f = dir.join("my db?.sqlite");
        {
            let c = Connection::open(&f).unwrap();
            c.execute_batch(
                "CREATE TABLE \"odd \"\"name\"\"\" (id INTEGER, label TEXT, score REAL, raw BLOB);
                 INSERT INTO \"odd \"\"name\"\"\" VALUES (1, 'a', 0.5, x'0102'), (2, NULL, 1.0, NULL);
                 CREATE TABLE plain (x INT);
                 CREATE VIEW v AS SELECT id FROM \"odd \"\"name\"\"\";",
            )
            .unwrap();
        }
        let before = fs::metadata(&f).unwrap().modified().unwrap();
        let book = read(&f).unwrap();
        let names: Vec<_> = book.parts.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["odd \"name\"", "plain", "v"]);
        assert_eq!(book.parts[0].detail, "table · 4 columns");
        assert!(book.schema.as_deref().unwrap().contains("CREATE VIEW v"));
        let t = book.first.unwrap();
        assert_eq!(t.total_rows, Some(2));
        assert_eq!(t.columns[0].ty.as_deref(), Some("integer"));
        assert_eq!(t.rows[0], [Some("1".into()), Some("a".into()), Some("0.5".into()), Some("<blob 2 bytes>".into())]);
        assert_eq!(t.rows[1][1], None);
        assert_eq!(read_part(&f, "v").unwrap().rows.len(), 2);
        assert!(read_part(&f, "missing").is_err());
        assert_eq!(fs::metadata(&f).unwrap().modified().unwrap(), before);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "no journal or WAL files left beside it");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_a_wal_database_and_refuses_other_files() {
        let dir = scratch("wal");
        let f = dir.join("w.db");
        {
            let c = Connection::open(&f).unwrap();
            c.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE t (x); INSERT INTO t VALUES (7);").unwrap();
        }
        assert_eq!(read(&f).unwrap().first.unwrap().rows, [[Some("7".to_string())]]);
        let other = dir.join("cache.db");
        fs::write(&other, "not sqlite at all").unwrap();
        assert_eq!(read(&other).unwrap_err(), "it isn't a SQLite database");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn lists_user_tables_whose_names_only_look_internal() {
        let dir = scratch("names");
        let f = dir.join("n.db");
        Connection::open(&f).unwrap().execute_batch("CREATE TABLE sqlite3_notes (x); CREATE TABLE plain (x);").unwrap();
        let book = read(&f).unwrap();
        let names: Vec<_> = book.parts.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["plain", "sqlite3_notes"]);
        assert!(book.schema.unwrap().contains("sqlite3_notes"));
        fs::remove_dir_all(&dir).unwrap();
    }
}
