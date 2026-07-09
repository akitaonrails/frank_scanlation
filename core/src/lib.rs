//! Site-agnostic scanlation reader core.
//!
//! Everything here is pure Rust with no Tauri dependency:
//! - [`heuristics`]: chapter-number detection ported from the
//!   Prettify Manga Reader browser extension (content.js). The JS and
//!   Rust sides must stay in sync — both parse the same URLs, one to
//!   drive the reader overlay, the other to record reading progress.
//! - [`extract`]: pulls title / cover / chapter list out of a site's
//!   HTML without any site-specific selectors.
//! - [`db`]: the embedded SQLite library (manga list + read state).
//! - [`fetch`]: a small HTTP client used to add manga and to poll for
//!   new chapters in the background.

pub mod db;
pub mod extract;
pub mod fetch;
pub mod heuristics;

pub use db::{Library, Manga};
pub use extract::SiteInfo;
pub use heuristics::ChapterInfo;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("invalid url: {0}")]
    Url(#[from] url::ParseError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, Error>;
