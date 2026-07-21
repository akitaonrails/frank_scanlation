//! FRANK Scanlation desktop app.
//!
//! Single-window design: the one main window shows the SvelteKit
//! library UI and navigates directly to scanlation sites for reading,
//! with the ported Prettify Manga Reader script injected on every
//! remote page (plus a floating "⌂ Library" button whose magic-URL
//! navigation the Rust side intercepts to return home). Reading
//! progress is tracked entirely on the Rust side by watching page
//! loads — remote pages never get IPC access.

// GPU + display-server detection and WebKit render-mode policy, taken
// from FRANK MANGA+ where it was battle-tested against the Wayland/EGL
// crashes WebKitGTK hits on some driver stacks. Pure logic + tests live
// in render_env.rs; run() wires it in before any thread spawns.
#[cfg(target_os = "linux")]
mod render_env;

use scanlation_core::extract::SiteInfo;
use scanlation_core::fetch::{cover_extension, Fetcher};
use scanlation_core::heuristics::{chapter_info_from_url, hosts_related};
use scanlation_core::{mangadex, resolve_site_info, Library, Manga};
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

/// Host of the magic URL the injected home button navigates to. The
/// main window's on_navigation hook intercepts it and swaps the app UI
/// back in — the only signal a remote page can send without IPC.
const HOME_SIGNAL_HOST: &str = "home.frank-scanlation.internal";

struct AppState {
    library: Arc<Mutex<Library>>,
    fetcher: Fetcher,
    /// Origins that are the app's own UI (tauri://localhost and the dev
    /// server). The injected script does nothing on these.
    app_origins: Vec<String>,
    /// The manga whose site the single main window currently shows;
    /// page loads are recorded against it. None while on the library UI.
    current_manga: Mutex<Option<i64>>,
    /// Where "home" navigates back to (captured from the main window's
    /// initial app URL).
    home_url: Mutex<Option<Url>>,
    /// Last URL routed through handle_navigation — lets the SPA URL
    /// watcher skip what the page-load hook already processed.
    last_seen_url: Mutex<Option<Url>>,
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

fn is_home_signal(url: &Url) -> bool {
    url.host_str() == Some(HOME_SIGNAL_HOST)
}

/// Origins the app UI is served from: the bundled-asset origins plus
/// the dev server when running under `tauri dev`.
fn app_origins(dev_url: Option<&Url>) -> Vec<String> {
    let mut origins = vec![
        "tauri://localhost".to_string(),
        "http://tauri.localhost".to_string(),
        "https://tauri.localhost".to_string(),
    ];
    if let Some(dev) = dev_url {
        origins.push(dev.origin().ascii_serialization());
    }
    origins
}

fn is_app_origin(url: &Url, origins: &[String]) -> bool {
    // tauri:// is a non-special scheme for the url crate (opaque
    // origin), so match it by scheme instead of serialized origin.
    if url.scheme() == "tauri" {
        return true;
    }
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    let origin = format!(
        "{}://{}{port}",
        url.scheme(),
        url.host_str().unwrap_or_default()
    );
    origins.contains(&origin)
}

/// Hosts a manga's reading session is allowed to navigate within: the
/// registered site URL plus every chapter URL we have recorded for it.
fn manga_hosts(manga: &Manga) -> Vec<String> {
    let mut hosts: Vec<String> = [
        Some(&manga.url),
        manga.latest_chapter_url.as_ref(),
        manga.last_read_url.as_ref(),
    ]
    .into_iter()
    .flatten()
    .filter_map(|u| Url::parse(u).ok())
    .filter_map(|u| u.host_str().map(str::to_string))
    .collect();
    hosts.sort();
    hosts.dedup();
    hosts
}

/// True when `host` belongs to the same site as an allowed host —
/// scanlation sites shuffle mirrors across numbered subdomains
/// (`w4.site.com` → `w6.site.com`), so this matches by apex domain.
fn is_host_allowed(host: &str, allowed: &[String]) -> bool {
    allowed.iter().any(|known| hosts_related(host, known))
}

/// Ad scripts on scanlation sites hijack the top-level page toward
/// off-site domains. While a manga is open, any main-frame navigation
/// whose host is outside the manga's known hosts gets denied — the
/// page simply stays put. App origins and the home signal are handled
/// before this is consulted.
fn should_block_reading_navigation(url: &Url, allowed_hosts: &[String]) -> bool {
    // The hook also sees subframe navigations; scripts routinely spin
    // up about:blank frames for sandboxing, and a top-level about:blank
    // can't take the user anywhere — allow it.
    if url.as_str() == "about:blank" {
        return false;
    }
    if !matches!(url.scheme(), "http" | "https") {
        // data:, javascript:, custom schemes — nothing legitimate in a
        // reading flow navigates to these.
        return true;
    }
    let Some(host) = url.host_str() else {
        return true;
    };
    !is_host_allowed(host, allowed_hosts)
}

/// A navigation only counts as reading progress for the current manga
/// when it stays on that manga's site — otherwise following an ad or an
/// off-site link would corrupt the reading state.
fn same_site(manga: &Manga, url: &Url) -> bool {
    let host = url.host_str();
    if host.is_none() {
        return false;
    }
    [
        Some(&manga.url),
        manga.latest_chapter_url.as_ref(),
        manga.last_read_url.as_ref(),
    ]
    .into_iter()
    .flatten()
    .filter_map(|u| Url::parse(u).ok())
    .any(|known| match (known.host_str(), host) {
        (Some(a), Some(b)) => hosts_related(a, b),
        _ => false,
    })
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
    let mut site_url = normalized_url(&url)?;

    // Best-effort metadata fetch for generic sites — Cloudflare may
    // refuse the plain HTTP client, but the manga is still added (host
    // as title, no cover) and remains readable through the webview.
    // API-backed sites (MangaDex) are all-or-nothing instead: without
    // the API there is no title, cover, or chapter list at all.
    let site = match resolve_site_info(&state.fetcher, &site_url).await {
        Ok((canonical, info)) => {
            site_url = canonical;
            Some(info)
        }
        Err(e) if mangadex::is_mangadex_host(&site_url) => {
            return Err(format!("MangaDex lookup failed: {e}"));
        }
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
    let needs_app_ua = Url::parse(cover_url)
        .map(|u| mangadex::is_mangadex_host(&u))
        .unwrap_or(false);
    let (bytes, content_type) = if needs_app_ua {
        state
            .fetcher
            .get_bytes_as(cover_url, mangadex::APP_USER_AGENT)
            .await
    } else {
        state.fetcher.get_bytes(cover_url).await
    }
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
        match Url::parse(&manga.url) {
            Ok(base) => match resolve_site_info(&state.fetcher, &base).await {
                Ok((_, info)) => Some(info),
                Err(e) => {
                    eprintln!("[frank-scanlation] continue: site fetch failed: {e}");
                    None
                }
            },
            Err(_) => None,
        }
    } else {
        None
    };

    let open_url = resolve_open_url(&manga, &target, site.as_ref());
    let url = Url::parse(&open_url).map_err(|e| format!("bad target url: {e}"))?;

    if let Ok(mut current) = state.current_manga.lock() {
        *current = Some(id);
    }
    navigate_main_window(&app, url).await
}

/// Point the single main window at `url`. Webview operations belong on
/// the main (GTK) thread; async commands run on a worker, so dispatch
/// and await the result over a oneshot channel.
async fn navigate_main_window(app: &AppHandle, url: Url) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        let result = app_handle
            .get_webview_window("main")
            .ok_or_else(|| "main window missing".to_string())
            .and_then(|window| window.navigate(url).map_err(|e| e.to_string()));
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| format!("navigation dropped: {e}"))?
}

/// Navigate the main window back to the library UI. Callable from any
/// thread; used by the home-signal interception.
fn go_home(app: &AppHandle) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let state: State<'_, AppState> = app.state();
        if let Ok(mut current) = state.current_manga.lock() {
            *current = None;
        }
        let home = state.home_url.lock().ok().and_then(|g| g.clone());
        let Some(home) = home else {
            eprintln!("[frank-scanlation] go_home: no home url captured");
            return;
        };
        if let Some(window) = app.get_webview_window("main") {
            if let Err(e) = window.navigate(home) {
                eprintln!("[frank-scanlation] go_home: navigate failed: {e}");
            }
        }
    });
}

/// Route a navigation of the main window: back on the app UI, remember
/// the home URL and clear the current manga; on a manga's site, record
/// reading progress parsed from the URL. Fed by both the page-load hook
/// (real navigations) and the SPA URL watcher (pushState navigations,
/// which never fire a page load).
fn handle_navigation(app: &AppHandle, url: &Url, from_watcher: bool) {
    let state: State<'_, AppState> = app.state();

    let changed = state
        .last_seen_url
        .lock()
        .map(|mut seen| {
            let changed = seen.as_ref() != Some(url);
            if changed {
                *seen = Some(url.clone());
            }
            changed
        })
        .unwrap_or(true);
    // Real page loads always reprocess (authoritative, and re-opening
    // the same chapter should bump the read timestamp); the watcher
    // only acts on URLs nothing else has handled.
    if from_watcher && !changed {
        return;
    }

    if is_app_origin(url, &state.app_origins) {
        if let Ok(mut home) = state.home_url.lock() {
            *home = Some(url.clone());
        }
        if let Ok(mut current) = state.current_manga.lock() {
            *current = None;
        }
        return;
    }

    let Some(id) = state.current_manga.lock().ok().and_then(|g| *g) else {
        return;
    };

    // MangaDex chapter URLs carry a uuid, not a number — resolve the
    // number through the API off the main thread, then record.
    if let Some(chapter_id) = mangadex::chapter_id_from_url(url) {
        let library = state.library.clone();
        let fetcher = state.fetcher.clone();
        let app = app.clone();
        let url = url.clone();
        tauri::async_runtime::spawn(async move {
            // Only record against a manga that actually lives on
            // MangaDex — mirrors the same_site gate of the generic path.
            let current_is_mangadex = library
                .lock()
                .ok()
                .and_then(|lib| lib.get(id).ok().flatten())
                .and_then(|m| Url::parse(&m.url).ok())
                .is_some_and(|u| mangadex::is_mangadex_host(&u));
            if !current_is_mangadex {
                return;
            }
            let number = match mangadex::chapter_number(&fetcher, &chapter_id).await {
                Ok(n) => n,
                Err(e) => {
                    eprintln!("[frank-scanlation] mangadex chapter lookup failed: {e}");
                    return;
                }
            };
            let recorded = library
                .lock()
                .map(|lib| lib.record_read(id, url.as_str(), number).is_ok())
                .unwrap_or(false);
            if recorded {
                let _ = app.emit("library-updated", ());
            }
        });
        return;
    }

    let recorded = with_library(&state, |lib| {
        let Some(manga) = lib.get(id)? else {
            return Ok(false);
        };
        if !same_site(&manga, url) {
            return Ok(false);
        }
        match chapter_for_navigation(&manga, url) {
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
        let site = match resolve_site_info(fetcher, &base).await {
            Ok((_, info)) => info,
            Err(e) => {
                eprintln!(
                    "[frank-scanlation] check: fetch failed for {}: {e}",
                    manga.url
                );
                continue;
            }
        };
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

/// SPA sites (MangaDex's Vue app, notably) navigate with pushState, so
/// no page load ever fires for in-site clicks — but WebKit still
/// updates the webview URI. While a manga is open, poll it and feed
/// changes through the same recording logic as real navigations.
fn spawn_spa_url_watcher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let watching = app
                .state::<AppState>()
                .current_manga
                .lock()
                .ok()
                .and_then(|guard| *guard)
                .is_some();
            if !watching {
                continue;
            }
            let (tx, rx) = tokio::sync::oneshot::channel();
            let handle = app.clone();
            if app
                .run_on_main_thread(move || {
                    let url = handle.get_webview_window("main").and_then(|w| w.url().ok());
                    let _ = tx.send(url);
                })
                .is_err()
            {
                continue;
            }
            if let Ok(Some(url)) = rx.await {
                handle_navigation(&app, &url, true);
            }
        }
    });
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

    let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
    let origins = app_origins(context.config().build.dev_url.as_ref());

    let state = AppState {
        library: library.clone(),
        fetcher: fetcher.clone(),
        app_origins: origins.clone(),
        current_manga: Mutex::new(None),
        home_url: Mutex::new(None),
        last_seen_url: Mutex::new(None),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .setup(move |app| {
            // The single main window is created here (not in
            // tauri.conf.json) because it needs the injected reader
            // script and the navigation/page-load hooks — it shows the
            // library UI and the scanlation sites in the same webview.
            let init_script = format!(
                "window.__FRANK_APP_ORIGINS__ = {};\n{}",
                serde_json::to_string(&origins).expect("origins serialize"),
                reader_init_script()
            );
            let nav_handle = app.handle().clone();
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("FRANK Scanlation")
                    .inner_size(1100.0, 780.0)
                    .min_inner_size(640.0, 480.0)
                    .initialization_script(init_script.as_str())
                    .on_navigation(move |url| {
                        if is_home_signal(url) {
                            // Deny the fake navigation, then swap the app UI in.
                            // navigate() can't be called re-entrantly from the
                            // policy callback, so hop through another thread.
                            let handle = nav_handle.clone();
                            std::thread::spawn(move || go_home(&handle));
                            return false;
                        }
                        let state: State<'_, AppState> = nav_handle.state();
                        if is_app_origin(url, &state.app_origins) {
                            return true;
                        }
                        // Reading jail: while a manga is open, refuse to
                        // leave its domains — ad popunders and redirect
                        // hijacks die here, the page stays where it was.
                        let Some(id) = state.current_manga.lock().ok().and_then(|g| *g) else {
                            return true;
                        };
                        let allowed = state
                            .library
                            .lock()
                            .ok()
                            .and_then(|lib| lib.get(id).ok().flatten())
                            .map(|manga| manga_hosts(&manga))
                            .unwrap_or_default();
                        if allowed.is_empty() {
                            return true;
                        }
                        if should_block_reading_navigation(url, &allowed) {
                            eprintln!("[frank-scanlation] blocked off-site navigation to {url}");
                            return false;
                        }
                        true
                    })
                    .on_page_load(|window, payload| {
                        if matches!(payload.event(), PageLoadEvent::Finished) {
                            handle_navigation(window.app_handle(), payload.url(), false);
                        }
                    })
                    .build()?;

            // Baseline home target; on_page_load keeps it current.
            if let Ok(url) = window.url() {
                if let Ok(mut home) = app.state::<AppState>().home_url.lock() {
                    *home = Some(url);
                }
            }

            spawn_spa_url_watcher(app.handle().clone());
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
        .run(context)
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
    fn manga_hosts_collects_site_and_chapter_hosts() {
        let mut m = manga(1);
        m.latest_chapter_url = Some("https://w4.zom.example/manga/zom-chapter-9/".into());
        m.last_read_url = Some("https://zom.example/manga/zom-chapter-5/".into());
        assert_eq!(manga_hosts(&m), vec!["w4.zom.example", "zom.example"]);
    }

    #[test]
    fn host_allowed_covers_subdomains_both_ways() {
        let allowed = vec!["zom.example".to_string()];
        assert!(is_host_allowed("zom.example", &allowed));
        assert!(is_host_allowed("w4.zom.example", &allowed));
        assert!(!is_host_allowed("evilzom.example", &allowed));
        assert!(!is_host_allowed("zom.example.evil.tld", &allowed));

        // Sibling mirrors: the exact migration smokingbehind* pulled.
        let allowed = vec!["w4.zom.example".to_string()];
        assert!(is_host_allowed("w6.zom.example", &allowed));
        assert!(is_host_allowed("zom.example", &allowed));
        assert!(!is_host_allowed("ads.example", &allowed));
    }

    #[test]
    fn reading_navigation_blocks_offsite_and_odd_schemes() {
        let allowed = vec!["zom.example".to_string()];
        let ok = Url::parse("https://zom.example/manga/ch-2/").unwrap();
        let sub = Url::parse("https://cdn.zom.example/page.html").unwrap();
        let ad = Url::parse("https://tracker.adnetwork.example/click?x=1").unwrap();
        let data = Url::parse("data:text/html,hi").unwrap();
        let blank = Url::parse("about:blank").unwrap();
        assert!(!should_block_reading_navigation(&ok, &allowed));
        assert!(!should_block_reading_navigation(&sub, &allowed));
        assert!(should_block_reading_navigation(&ad, &allowed));
        assert!(should_block_reading_navigation(&data, &allowed));
        assert!(!should_block_reading_navigation(&blank, &allowed));
    }

    #[test]
    fn home_signal_matches_only_magic_host() {
        assert!(is_home_signal(
            &Url::parse("https://home.frank-scanlation.internal/").unwrap()
        ));
        assert!(!is_home_signal(
            &Url::parse("https://zom.example/").unwrap()
        ));
        assert!(!is_home_signal(
            &Url::parse("https://frank-scanlation.internal/").unwrap()
        ));
    }

    #[test]
    fn app_origins_cover_bundled_and_dev() {
        let dev = Url::parse("http://localhost:1420/").unwrap();
        let origins = app_origins(Some(&dev));
        assert!(origins.contains(&"tauri://localhost".to_string()));
        assert!(origins.contains(&"http://localhost:1420".to_string()));

        assert!(is_app_origin(
            &Url::parse("http://localhost:1420/library").unwrap(),
            &origins
        ));
        assert!(is_app_origin(
            &Url::parse("tauri://localhost/index.html").unwrap(),
            &origins
        ));
        assert!(!is_app_origin(
            &Url::parse("https://zom.example/manga/ch-1/").unwrap(),
            &origins
        ));
    }

    #[test]
    fn same_site_gates_progress_recording() {
        let mut m = manga(1);
        assert!(same_site(
            &m,
            &Url::parse("https://zom.example/manga/zom-chapter-2/").unwrap()
        ));
        assert!(!same_site(
            &m,
            &Url::parse("https://ads.example/click").unwrap()
        ));

        // A known chapter URL on another subdomain extends the site.
        m.latest_chapter_url = Some("https://w4.zom.example/manga/zom-chapter-9/".into());
        assert!(same_site(
            &m,
            &Url::parse("https://w4.zom.example/manga/zom-chapter-10/").unwrap()
        ));
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
