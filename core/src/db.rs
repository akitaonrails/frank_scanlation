//! Embedded SQLite library: the manga list plus per-manga read state.
//!
//! The database lives in the platform config dir (the Tauri app passes
//! `~/.config/frank-scanlation/library.db` on Linux and the equivalent
//! on macOS/Windows). All timestamps are unix seconds.

use rusqlite::{params, Connection, OptionalExtension, Row};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manga {
    pub id: i64,
    /// The site/homepage URL the user pasted.
    pub url: String,
    pub title: String,
    /// Local path of the downloaded cover image, if any.
    pub cover_path: Option<String>,
    pub created_at: i64,
    pub last_read_url: Option<String>,
    pub last_read_chapter: Option<f64>,
    pub last_read_at: Option<i64>,
    pub latest_chapter: Option<f64>,
    pub latest_chapter_url: Option<String>,
    pub last_checked_at: Option<i64>,
    /// True when a check discovered a chapter newer than what the user
    /// has read; cleared once the user reads it.
    pub has_new: bool,
}

pub struct Library {
    conn: Connection,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS manga (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  cover_path TEXT,
  created_at INTEGER NOT NULL,
  last_read_url TEXT,
  last_read_chapter REAL,
  last_read_at INTEGER,
  latest_chapter REAL,
  latest_chapter_url TEXT,
  last_checked_at INTEGER,
  has_new INTEGER NOT NULL DEFAULT 0
);
";

impl Library {
    /// Open (creating if needed) the library at `path`. Parent
    /// directories are created.
    pub fn open(path: &Path) -> crate::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        Self::from_connection(conn)
    }

    /// In-memory library for tests.
    pub fn open_in_memory() -> crate::Result<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(conn: Connection) -> crate::Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn })
    }

    pub fn add(&self, url: &str, title: &str, cover_path: Option<&str>) -> crate::Result<Manga> {
        let created = now();
        self.conn
            .execute(
                "INSERT INTO manga (url, title, cover_path, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![url, title, cover_path, created],
            )
            .map_err(|e| match e {
                rusqlite::Error::SqliteFailure(err, _)
                    if err.code == rusqlite::ErrorCode::ConstraintViolation =>
                {
                    crate::Error::Other(format!("{url} is already in the library"))
                }
                other => other.into(),
            })?;
        let id = self.conn.last_insert_rowid();
        self.get(id)?
            .ok_or_else(|| crate::Error::Other("insert vanished".into()))
    }

    pub fn get(&self, id: i64) -> crate::Result<Option<Manga>> {
        Ok(self
            .conn
            .query_row("SELECT * FROM manga WHERE id = ?1", [id], manga_from_row)
            .optional()?)
    }

    pub fn list(&self) -> crate::Result<Vec<Manga>> {
        let mut stmt = self.conn.prepare(
            "SELECT * FROM manga ORDER BY has_new DESC, COALESCE(last_read_at, created_at) DESC",
        )?;
        let rows = stmt.query_map([], manga_from_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn remove(&self, id: i64) -> crate::Result<()> {
        self.conn.execute("DELETE FROM manga WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn set_cover(&self, id: i64, cover_path: &str) -> crate::Result<()> {
        self.conn.execute(
            "UPDATE manga SET cover_path = ?2 WHERE id = ?1",
            params![id, cover_path],
        )?;
        Ok(())
    }

    pub fn set_title(&self, id: i64, title: &str) -> crate::Result<()> {
        self.conn.execute(
            "UPDATE manga SET title = ?2 WHERE id = ?1",
            params![id, title],
        )?;
        Ok(())
    }

    /// Record that the reader window navigated to `url`. When a chapter
    /// number was parsed from it, reading progress moves forward (never
    /// backward — re-reading chapter 3 keeps "last read: 7"), and the
    /// NEW badge clears once the newest known chapter has been opened.
    /// A chapter newer than the known latest also advances the latest.
    pub fn record_read(&self, id: i64, url: &str, chapter: Option<f64>) -> crate::Result<()> {
        let Some(manga) = self.get(id)? else {
            return Ok(());
        };
        let ts = now();
        self.conn.execute(
            "UPDATE manga SET last_read_url = ?2, last_read_at = ?3 WHERE id = ?1",
            params![id, url, ts],
        )?;

        let Some(chapter) = chapter else {
            return Ok(());
        };
        let progressed = manga.last_read_chapter.is_none_or(|prev| chapter > prev);
        if progressed {
            self.conn.execute(
                "UPDATE manga SET last_read_chapter = ?2 WHERE id = ?1",
                params![id, chapter],
            )?;
        }
        let effective = manga.last_read_chapter.map_or(chapter, |p| p.max(chapter));
        if manga.latest_chapter.is_none_or(|latest| chapter > latest) {
            self.conn.execute(
                "UPDATE manga SET latest_chapter = ?2, latest_chapter_url = ?3 WHERE id = ?1",
                params![id, chapter, url],
            )?;
        }
        if manga
            .latest_chapter
            .is_none_or(|latest| effective >= latest)
        {
            self.conn
                .execute("UPDATE manga SET has_new = 0 WHERE id = ?1", [id])?;
        }
        Ok(())
    }

    /// Store the result of an update check. Returns `true` when this
    /// discovered a chapter newer than the previously known latest AND
    /// newer than what the user has read — i.e. worth a notification.
    pub fn update_latest(&self, id: i64, number: f64, url: &str) -> crate::Result<bool> {
        let Some(manga) = self.get(id)? else {
            return Ok(false);
        };
        let ts = now();
        self.conn.execute(
            "UPDATE manga SET last_checked_at = ?2 WHERE id = ?1",
            params![id, ts],
        )?;

        let advanced = manga.latest_chapter.is_none_or(|prev| number > prev);
        if !advanced {
            return Ok(false);
        }
        self.conn.execute(
            "UPDATE manga SET latest_chapter = ?2, latest_chapter_url = ?3 WHERE id = ?1",
            params![id, number, url],
        )?;

        let unread = manga.last_read_chapter.is_none_or(|read| number > read);
        // First successful check right after adding a manga just
        // baselines the latest chapter — no badge, no notification.
        let is_news = manga.latest_chapter.is_some() && unread;
        if is_news {
            self.conn
                .execute("UPDATE manga SET has_new = 1 WHERE id = ?1", [id])?;
        }
        Ok(is_news)
    }

    /// Baseline the latest chapter at add time without triggering the
    /// NEW badge.
    pub fn baseline_latest(&self, id: i64, number: f64, url: &str) -> crate::Result<()> {
        self.conn.execute(
            "UPDATE manga SET latest_chapter = ?2, latest_chapter_url = ?3, last_checked_at = ?4 WHERE id = ?1",
            params![id, number, url, now()],
        )?;
        Ok(())
    }
}

fn manga_from_row(row: &Row) -> rusqlite::Result<Manga> {
    Ok(Manga {
        id: row.get("id")?,
        url: row.get("url")?,
        title: row.get("title")?,
        cover_path: row.get("cover_path")?,
        created_at: row.get("created_at")?,
        last_read_url: row.get("last_read_url")?,
        last_read_chapter: row.get("last_read_chapter")?,
        last_read_at: row.get("last_read_at")?,
        latest_chapter: row.get("latest_chapter")?,
        latest_chapter_url: row.get("latest_chapter_url")?,
        last_checked_at: row.get("last_checked_at")?,
        has_new: row.get::<_, i64>("has_new")? != 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lib() -> Library {
        Library::open_in_memory().unwrap()
    }

    #[test]
    fn add_list_remove_roundtrip() {
        let lib = lib();
        let m = lib
            .add("https://zom.example/", "Zom 100", Some("/tmp/c.jpg"))
            .unwrap();
        assert_eq!(m.title, "Zom 100");
        assert_eq!(lib.list().unwrap().len(), 1);
        lib.remove(m.id).unwrap();
        assert!(lib.list().unwrap().is_empty());
    }

    #[test]
    fn duplicate_url_is_a_friendly_error() {
        let lib = lib();
        lib.add("https://zom.example/", "Zom 100", None).unwrap();
        let err = lib
            .add("https://zom.example/", "Zom 100", None)
            .unwrap_err();
        assert!(err.to_string().contains("already in the library"));
    }

    #[test]
    fn record_read_moves_progress_forward_only() {
        let lib = lib();
        let m = lib.add("https://zom.example/", "Zom 100", None).unwrap();
        lib.record_read(m.id, "https://zom.example/ch-7/", Some(7.0))
            .unwrap();
        lib.record_read(m.id, "https://zom.example/ch-3/", Some(3.0))
            .unwrap();
        let m = lib.get(m.id).unwrap().unwrap();
        assert_eq!(m.last_read_chapter, Some(7.0));
        // last_read_url always tracks the most recent navigation.
        assert_eq!(
            m.last_read_url.as_deref(),
            Some("https://zom.example/ch-3/")
        );
    }

    #[test]
    fn update_latest_baseline_then_news() {
        let lib = lib();
        let m = lib.add("https://zom.example/", "Zom 100", None).unwrap();
        lib.baseline_latest(m.id, 10.0, "https://zom.example/ch-10/")
            .unwrap();
        let m1 = lib.get(m.id).unwrap().unwrap();
        assert!(!m1.has_new);
        assert_eq!(m1.latest_chapter, Some(10.0));

        // Later check finds chapter 11 → news.
        let news = lib
            .update_latest(m.id, 11.0, "https://zom.example/ch-11/")
            .unwrap();
        assert!(news);
        assert!(lib.get(m.id).unwrap().unwrap().has_new);

        // Same chapter again → no news.
        let news = lib
            .update_latest(m.id, 11.0, "https://zom.example/ch-11/")
            .unwrap();
        assert!(!news);
    }

    #[test]
    fn update_latest_already_read_is_not_news() {
        let lib = lib();
        let m = lib.add("https://zom.example/", "Zom 100", None).unwrap();
        lib.baseline_latest(m.id, 10.0, "https://zom.example/ch-10/")
            .unwrap();
        lib.record_read(m.id, "https://zom.example/ch-11/", Some(11.0))
            .unwrap();
        // Checker later catches up to what the user already read.
        let news = lib
            .update_latest(m.id, 11.0, "https://zom.example/ch-11/")
            .unwrap();
        assert!(!news);
        assert!(!lib.get(m.id).unwrap().unwrap().has_new);
    }

    #[test]
    fn reading_latest_clears_new_badge() {
        let lib = lib();
        let m = lib.add("https://zom.example/", "Zom 100", None).unwrap();
        lib.baseline_latest(m.id, 10.0, "https://zom.example/ch-10/")
            .unwrap();
        lib.update_latest(m.id, 11.0, "https://zom.example/ch-11/")
            .unwrap();
        assert!(lib.get(m.id).unwrap().unwrap().has_new);

        lib.record_read(m.id, "https://zom.example/ch-11/", Some(11.0))
            .unwrap();
        let m = lib.get(m.id).unwrap().unwrap();
        assert!(!m.has_new);
        assert_eq!(m.last_read_chapter, Some(11.0));
    }

    #[test]
    fn reading_past_known_latest_advances_latest() {
        let lib = lib();
        let m = lib.add("https://zom.example/", "Zom 100", None).unwrap();
        lib.baseline_latest(m.id, 10.0, "https://zom.example/ch-10/")
            .unwrap();
        lib.record_read(m.id, "https://zom.example/ch-12/", Some(12.0))
            .unwrap();
        let m = lib.get(m.id).unwrap().unwrap();
        assert_eq!(m.latest_chapter, Some(12.0));
        assert!(!m.has_new);
    }

    #[test]
    fn record_read_without_chapter_only_updates_url() {
        let lib = lib();
        let m = lib.add("https://zom.example/", "Zom 100", None).unwrap();
        lib.record_read(m.id, "https://zom.example/about/", None)
            .unwrap();
        let m = lib.get(m.id).unwrap().unwrap();
        assert_eq!(
            m.last_read_url.as_deref(),
            Some("https://zom.example/about/")
        );
        assert_eq!(m.last_read_chapter, None);
    }

    #[test]
    fn list_orders_new_first() {
        let lib = lib();
        let a = lib.add("https://a.example/", "A", None).unwrap();
        let b = lib.add("https://b.example/", "B", None).unwrap();
        lib.baseline_latest(a.id, 1.0, "https://a.example/ch-1/")
            .unwrap();
        lib.update_latest(a.id, 2.0, "https://a.example/ch-2/")
            .unwrap();
        let list = lib.list().unwrap();
        assert_eq!(list[0].id, a.id);
        assert_eq!(list[1].id, b.id);
    }
}
