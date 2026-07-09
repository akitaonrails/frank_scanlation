//! FRANK Scanlation desktop app.
//!
//! The main window is the SvelteKit library UI. Each manga opens in its
//! own reader window pointed directly at the scanlation site, with the
//! ported Prettify Manga Reader script injected on every page. Reading
//! progress is tracked entirely on the Rust side by watching page loads
//! in that window — remote pages never get IPC access.

// GPU + display-server detection and WebKit render-mode policy, taken
// from FRANK MANGA+ where it was battle-tested against the Wayland/EGL
// crashes WebKitGTK hits on some driver stacks. Pure logic + tests live
// in render_env.rs; run() wires it in before any thread spawns.
#[cfg(target_os = "linux")]
mod render_env;

use scanlation_core::extract::{extract_site_info, SiteInfo};
use scanlation_core::fetch::{cover_extension, Fetcher};
use scanlation_core::heuristics::chapter_info_from_url;
use scanlation_core::{Library, Manga};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;
use url::Url;

/// How often the background checker polls for new chapters.
const CHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(6 * 60 * 60);
/// Delay before the first automatic check after launch, so startup
/// stays snappy and the UI is already interactive.
const FIRST_CHECK_DELAY: std::time::Duration = std::time::Duration::from_secs(5);

struct AppState {
    library: Arc<Mutex<Library>>,
    fetcher: Fetcher,
}

/// XDG-style config dir holding the library DB and cover cache.
/// Linux/macOS: ~/.config/frank-scanlation, Windows: %APPDATA%.
fn config_dir() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        return PathBuf::from(xdg).join("frank-scanlation");
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        return PathBuf::from(appdata).join("frank-scanlation");
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".config/frank-scanlation");
    }
    std::env::temp_dir().join("frank-scanlation")
}

fn covers_dir() -> PathBuf {
    config_dir().join("covers")
}

/// The script injected into every page of a reader window: the reader
/// stylesheet as a JS string, followed by the ported extension code
/// that consumes it.
fn reader_init_script() -> String {
    const CSS: &str = include_str!("../injected/reader.css");
    const JS: &str = include_str!("../injected/reader.js");
    let css_json = serde_json::to_string(CSS).expect("css is valid utf-8");
    format!("window.__FRANK_READER_CSS__ = {css_json};\n{JS}")
}

fn reader_label(manga_id: i64) -> String {
    format!("reader-{manga_id}")
}

fn manga_id_from_label(label: &str) -> Option<i64> {
    label.strip_prefix("reader-")?.parse().ok()
}

/// Chapter number to record for a navigation, if any. Explicit chapter
/// URLs (`.../chapter-12/`) are always trusted. Bare trailing numbers
/// (`.../zom-100/112/`) are only trusted when the URL family matches a
/// chapter URL we already know for this manga — that keeps random
/// numbered pages (blog posts, date archives) out of the progress.
fn chapter_for_navigation(manga: &Manga, url: &Url) -> Option<f64> {
    let info = chapter_info_from_url(url)?;
    if info.explicit {
        return Some(info.number);
    }
    let known_family = |known: &Option<String>| {
        known
            .as_deref()
            .and_then(|u| Url::parse(u).ok())
            .and_then(|u| chapter_info_from_url(&u))
            .is_some_and(|k| k.family == info.family)
    };
    if known_family(&manga.latest_chapter_url) || known_family(&manga.last_read_url) {
        Some(info.number)
    } else {
        None
    }
}

/// Where a reader window should land for the given open target.
fn resolve_open_url(manga: &Manga, target: &str, site: Option<&SiteInfo>) -> String {
    match target {
        "home" => manga.url.clone(),
        "latest" => manga
            .latest_chapter_url
            .clone()
            .unwrap_or_else(|| manga.url.clone()),
        // "continue": the chapter after the last one read, falling back
        // to where the user last was, the first chapter, or the site.
        _ => {
            if let Some(site) = site {
                match manga.last_read_chapter {
                    Some(read) => {
                        if let Some(next) = site.next_chapter_after(read) {
                            return next.url.clone();
                        }
                    }
                    None => {
                        if let Some(first) = site.chapters.first() {
                            return first.url.clone();
                        }
                    }
                }
            }
            manga
                .last_read_url
                .clone()
                .or_else(|| manga.latest_chapter_url.clone())
                .unwrap_or_else(|| manga.url.clone())
        }
    }
}

fn data_url(bytes: &[u8], ext: &str) -> String {
    use base64::Engine;
    let mime = match ext {
        "png" => "image/png",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "gif" => "image/gif",
        _ => "image/jpeg",
    };
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

fn with_library<T>(
    state: &AppState,
    f: impl FnOnce(&Library) -> scanlation_core::Result<T>,
) -> Result<T, String> {
    let guard = state.library.lock().map_err(|e| format!("db lock: {e}"))?;
    f(&guard).map_err(|e| e.to_string())
}

fn normalized_url(input: &str) -> Result<Url, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("paste a site URL first".into());
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let url = Url::parse(&candidate).map_err(|e| format!("not a valid URL: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("only http(s) sites are supported".into());
    }
    Ok(url)
}

// ---------- commands ----------

/// Frontend handshake — called from the SvelteKit page on first render.
/// Clears the crash-recovery marker touched at startup; if the WebView
/// aborts before this fires, the marker survives and the NEXT launch
/// falls back to Safe rendering automatically. See render_env.rs.
#[tauri::command]
fn mark_app_ready() {
    #[cfg(target_os = "linux")]
    {
        render_env::clear_recovery_marker(&config_dir());
    }
}

#[tauri::command]
fn list_manga(state: State<'_, AppState>) -> Result<Vec<Manga>, String> {
    with_library(&state, |lib| lib.list())
}

#[tauri::command]
async fn add_manga(state: State<'_, AppState>, url: String) -> Result<Manga, String> {
    let site_url = normalized_url(&url)?;

    // Best-effort metadata fetch. Cloudflare may refuse the plain HTTP
    // client; the manga is still added (host as title, no cover) and
    // remains fully readable through the reader window.
    let site = match state.fetcher.get_text(site_url.as_str()).await {
        Ok(html) => Some(extract_site_info(&html, &site_url)),
        Err(e) => {
            eprintln!("[frank-scanlation] add: metadata fetch failed for {site_url}: {e}");
            None
        }
    };

    let title = site
        .as_ref()
        .map(|s| s.title.clone())
        .unwrap_or_else(|| host_title(&site_url));

    let manga = with_library(&state, |lib| lib.add(site_url.as_str(), &title, None))?;

    if let Some(site) = &site {
        if let Some(latest) = site.latest_chapter() {
            with_library(&state, |lib| {
                lib.baseline_latest(manga.id, latest.number, &latest.url)
            })?;
        }
        if let Some(cover_url) = &site.cover_url {
            if let Err(e) = download_cover(&state, manga.id, cover_url).await {
                eprintln!("[frank-scanlation] add: cover download failed: {e}");
            }
        }
    }

    with_library(&state, |lib| lib.get(manga.id))?.ok_or_else(|| "manga vanished".into())
}

fn host_title(url: &Url) -> String {
    url.host_str()
        .unwrap_or("Untitled manga")
        .trim_start_matches("www.")
        .to_string()
}

async fn download_cover(
    state: &State<'_, AppState>,
    id: i64,
    cover_url: &str,
) -> Result<(), String> {
    let (bytes, content_type) = state
        .fetcher
        .get_bytes(cover_url)
        .await
        .map_err(|e| e.to_string())?;
    let ext = cover_extension(content_type.as_deref(), cover_url);
    let dir = covers_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{id}.{ext}"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    with_library(state, |lib| lib.set_cover(id, &path.to_string_lossy()))
}

#[tauri::command]
fn remove_manga(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let manga = with_library(&state, |lib| lib.get(id))?;
    with_library(&state, |lib| lib.remove(id))?;
    if let Some(cover) = manga.and_then(|m| m.cover_path) {
        let _ = std::fs::remove_file(cover);
    }
    Ok(())
}

#[tauri::command]
fn get_cover(state: State<'_, AppState>, id: i64) -> Result<Option<String>, String> {
    let Some(manga) = with_library(&state, |lib| lib.get(id))? else {
        return Ok(None);
    };
    let Some(path) = manga.cover_path else {
        return Ok(None);
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return Ok(None);
    };
    let ext = path.rsplit('.').next().unwrap_or("jpg").to_lowercase();
    Ok(Some(data_url(&bytes, &ext)))
}

#[tauri::command]
async fn open_manga(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    target: String,
) -> Result<(), String> {
    let manga =
        with_library(&state, |lib| lib.get(id))?.ok_or_else(|| "manga not found".to_string())?;

    // "continue" wants the chapter list to find the next unread chapter;
    // fetch it best-effort and fall back to stored URLs.
    let site = if target == "continue" {
        match state.fetcher.get_text(&manga.url).await {
            Ok(html) => Url::parse(&manga.url)
                .ok()
                .map(|base| extract_site_info(&html, &base)),
            Err(e) => {
                eprintln!("[frank-scanlation] continue: site fetch failed: {e}");
                None
            }
        }
    } else {
        None
    };

    let open_url = resolve_open_url(&manga, &target, site.as_ref());
    let url = Url::parse(&open_url).map_err(|e| format!("bad target url: {e}"))?;

    // Webview windows must be created on the main (GTK) thread; async
    // commands run on a worker thread, so dispatch and await the result.
    let (tx, rx) = tokio::sync::oneshot::channel();
    let app_handle = app.clone();
    let title = manga.title.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(open_reader_window(&app_handle, id, &title, url));
    })
    .map_err(|e| e.to_string())?;
    rx.await
        .map_err(|e| format!("window creation dropped: {e}"))?
}

/// Navigate the manga's existing reader window, or create it. Must run
/// on the main thread.
fn open_reader_window(app: &AppHandle, id: i64, title: &str, url: Url) -> Result<(), String> {
    let label = reader_label(id);
    if let Some(window) = app.get_webview_window(&label) {
        window.navigate(url).map_err(|e| e.to_string())?;
        let _ = window.set_focus();
        return Ok(());
    }

    let init_script = reader_init_script();
    WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title(title)
        .inner_size(1280.0, 960.0)
        .initialization_script(init_script.as_str())
        .on_page_load(|window, payload| {
            if !matches!(payload.event(), PageLoadEvent::Finished) {
                return;
            }
            let Some(id) = manga_id_from_label(window.label()) else {
                return;
            };
            let url = payload.url().clone();
            let app = window.app_handle();
            let state: State<'_, AppState> = app.state();
            let recorded = with_library(&state, |lib| {
                let Some(manga) = lib.get(id)? else {
                    return Ok(false);
                };
                match chapter_for_navigation(&manga, &url) {
                    Some(chapter) => {
                        lib.record_read(id, url.as_str(), Some(chapter))?;
                        Ok(true)
                    }
                    None => Ok(false),
                }
            });
            if recorded.unwrap_or(false) {
                let _ = app.emit("library-updated", ());
            }
        })
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn check_updates(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<Manga>, String> {
    let library = state.library.clone();
    let fetcher = state.fetcher.clone();
    check_all_updates(&app, &library, &fetcher).await;
    with_library(&state, |lib| lib.list())
}

/// One pass over the library: refetch each site, compare the newest
/// chapter link with what we knew, badge + notify on genuine news.
async fn check_all_updates(app: &AppHandle, library: &Arc<Mutex<Library>>, fetcher: &Fetcher) {
    let manga_list = match library.lock().map(|lib| lib.list()) {
        Ok(Ok(list)) => list,
        _ => return,
    };

    let mut any_news = false;
    for manga in manga_list {
        let Ok(base) = Url::parse(&manga.url) else {
            continue;
        };
        let html = match fetcher.get_text(&manga.url).await {
            Ok(html) => html,
            Err(e) => {
                eprintln!(
                    "[frank-scanlation] check: fetch failed for {}: {e}",
                    manga.url
                );
                continue;
            }
        };
        let site = extract_site_info(&html, &base);
        let Some(latest) = site.latest_chapter() else {
            continue;
        };
        let news = library
            .lock()
            .ok()
            .and_then(|lib| lib.update_latest(manga.id, latest.number, &latest.url).ok())
            .unwrap_or(false);
        if news {
            any_news = true;
            let body = format!("{} — chapter {} is out", manga.title, latest.number);
            if let Err(e) = app
                .notification()
                .builder()
                .title("New chapter available")
                .body(&body)
                .show()
            {
                eprintln!("[frank-scanlation] notification failed: {e}");
            }
        }
    }

    if any_news {
        let _ = app.emit("library-updated", ());
    }
}

fn spawn_update_checker(app: AppHandle, library: Arc<Mutex<Library>>, fetcher: Fetcher) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            check_all_updates(&app, &library, &fetcher).await;
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Linux-only: pick a WebKit render mode based on the actual
    // hardware + display server. Order of precedence (highest first):
    //   1. FRANK_SCANLATION_RENDER_MODE env var
    //   2. <config_dir>/render.conf `mode = ...`
    //   3. Crash recovery (last run left a marker behind) → Safe
    //   4. Auto detect from GPU vendor + WAYLAND_DISPLAY
    // The decision is written to <config_dir>/render-state.log.
    #[cfg(target_os = "linux")]
    {
        use render_env::{
            apply_mode, create_recovery_marker, decide_mode, detect_display_server_from_env,
            detect_gpu_vendor_from_sysfs, is_recovery_needed, resolve_user_override,
            write_state_log, ModeOverride,
        };
        let cfg_dir = config_dir();
        let env_override = std::env::var("FRANK_SCANLATION_RENDER_MODE").ok();
        let user_override = resolve_user_override(env_override.as_deref(), &cfg_dir);
        let recovery = is_recovery_needed(&cfg_dir);
        let explicit = match user_override {
            Some(ModeOverride::Explicit(m)) => Some(m),
            _ => None,
        };
        let display = detect_display_server_from_env();
        let gpu = detect_gpu_vendor_from_sysfs();
        let (mode, reason) = decide_mode(explicit, recovery, display, gpu);
        eprintln!(
            "[frank-scanlation] render mode: {} ({}; display={:?} gpu={:?}{}{})",
            mode.slug(),
            reason,
            display,
            gpu,
            if user_override.is_some() {
                " override=yes"
            } else {
                ""
            },
            if recovery { " recovery=yes" } else { "" },
        );
        // SAFETY: this is the binary's first user-code call after main;
        // nothing has spawned a thread yet, so the env table has no
        // concurrent reader.
        unsafe { apply_mode(mode) };
        create_recovery_marker(&cfg_dir);
        write_state_log(
            &cfg_dir,
            mode,
            reason,
            display,
            gpu,
            user_override.is_some(),
            recovery,
        );
    }

    let db_path = config_dir().join("library.db");
    let library = Library::open(&db_path)
        .unwrap_or_else(|e| panic!("cannot open library at {}: {e}", db_path.display()));
    let library = Arc::new(Mutex::new(library));
    let fetcher = Fetcher::new();

    let state = AppState {
        library: library.clone(),
        fetcher: fetcher.clone(),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .setup(move |app| {
            spawn_update_checker(app.handle().clone(), library, fetcher);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mark_app_ready,
            list_manga,
            add_manga,
            remove_manga,
            get_cover,
            open_manga,
            check_updates,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use scanlation_core::extract::ChapterLink;

    fn manga(id: i64) -> Manga {
        Manga {
            id,
            url: "https://zom.example/".into(),
            title: "Zom 100".into(),
            cover_path: None,
            created_at: 0,
            last_read_url: None,
            last_read_chapter: None,
            last_read_at: None,
            latest_chapter: None,
            latest_chapter_url: None,
            last_checked_at: None,
            has_new: false,
        }
    }

    fn site(numbers: &[f64]) -> SiteInfo {
        SiteInfo {
            title: "Zom 100".into(),
            cover_url: None,
            chapters: numbers
                .iter()
                .map(|n| ChapterLink {
                    number: *n,
                    url: format!("https://zom.example/manga/zom-chapter-{n}/"),
                })
                .collect(),
        }
    }

    #[test]
    fn reader_labels_roundtrip() {
        assert_eq!(manga_id_from_label(&reader_label(42)), Some(42));
        assert_eq!(manga_id_from_label("main"), None);
        assert_eq!(manga_id_from_label("reader-x"), None);
    }

    #[test]
    fn init_script_carries_css_and_reader() {
        let script = reader_init_script();
        assert!(script.starts_with("window.__FRANK_READER_CSS__ = \""));
        assert!(script.contains("__PRETTIFY_MANGA_READER_LOADED__"));
    }

    #[test]
    fn navigation_chapter_requires_explicit_or_known_family() {
        let mut m = manga(1);
        let explicit = Url::parse("https://zom.example/manga/zom-chapter-12/").unwrap();
        assert_eq!(chapter_for_navigation(&m, &explicit), Some(12.0));

        // Bare numbered URL with no known family → ignored.
        let bare = Url::parse("https://zom.example/zom-100/112/").unwrap();
        assert_eq!(chapter_for_navigation(&m, &bare), None);

        // Once the latest-chapter URL shares that family, it's trusted.
        m.latest_chapter_url = Some("https://zom.example/zom-100/110/".into());
        assert_eq!(chapter_for_navigation(&m, &bare), Some(112.0));
    }

    #[test]
    fn open_home_and_latest_targets() {
        let mut m = manga(1);
        assert_eq!(resolve_open_url(&m, "home", None), "https://zom.example/");
        assert_eq!(resolve_open_url(&m, "latest", None), "https://zom.example/");
        m.latest_chapter_url = Some("https://zom.example/manga/zom-chapter-9/".into());
        assert_eq!(
            resolve_open_url(&m, "latest", None),
            "https://zom.example/manga/zom-chapter-9/"
        );
    }

    #[test]
    fn continue_prefers_next_unread_chapter() {
        let mut m = manga(1);
        m.last_read_chapter = Some(2.0);
        m.last_read_url = Some("https://zom.example/manga/zom-chapter-2/".into());
        let s = site(&[1.0, 2.0, 3.0, 4.0]);
        assert_eq!(
            resolve_open_url(&m, "continue", Some(&s)),
            "https://zom.example/manga/zom-chapter-3/"
        );
    }

    #[test]
    fn continue_fully_read_falls_back_to_last_read_url() {
        let mut m = manga(1);
        m.last_read_chapter = Some(4.0);
        m.last_read_url = Some("https://zom.example/manga/zom-chapter-4/".into());
        let s = site(&[1.0, 2.0, 3.0, 4.0]);
        assert_eq!(
            resolve_open_url(&m, "continue", Some(&s)),
            "https://zom.example/manga/zom-chapter-4/"
        );
    }

    #[test]
    fn continue_fresh_manga_starts_at_first_chapter() {
        let m = manga(1);
        let s = site(&[1.0, 2.0]);
        assert_eq!(
            resolve_open_url(&m, "continue", Some(&s)),
            "https://zom.example/manga/zom-chapter-1/"
        );
    }

    #[test]
    fn continue_without_site_info_uses_stored_urls() {
        let mut m = manga(1);
        assert_eq!(
            resolve_open_url(&m, "continue", None),
            "https://zom.example/"
        );
        m.latest_chapter_url = Some("https://zom.example/manga/zom-chapter-9/".into());
        assert_eq!(
            resolve_open_url(&m, "continue", None),
            "https://zom.example/manga/zom-chapter-9/"
        );
        m.last_read_url = Some("https://zom.example/manga/zom-chapter-5/".into());
        assert_eq!(
            resolve_open_url(&m, "continue", None),
            "https://zom.example/manga/zom-chapter-5/"
        );
    }

    #[test]
    fn url_normalization_adds_scheme_and_rejects_junk() {
        assert_eq!(
            normalized_url("zom-100.example/").unwrap().as_str(),
            "https://zom-100.example/"
        );
        assert_eq!(
            normalized_url(" https://x.example ").unwrap().as_str(),
            "https://x.example/"
        );
        assert!(normalized_url("").is_err());
        assert!(normalized_url("ftp://x.example").is_err());
    }

    #[test]
    fn cover_data_url_mime_mapping() {
        assert!(data_url(b"x", "png").starts_with("data:image/png;base64,"));
        assert!(data_url(b"x", "jpg").starts_with("data:image/jpeg;base64,"));
        assert!(data_url(b"x", "weird").starts_with("data:image/jpeg;base64,"));
    }

    #[test]
    fn host_title_strips_www() {
        let url = Url::parse("https://www.zom-100.example/").unwrap();
        assert_eq!(host_title(&url), "zom-100.example");
    }
}
