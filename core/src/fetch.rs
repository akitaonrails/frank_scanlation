//! Minimal HTTP client for metadata fetches (add-manga, cover download,
//! background new-chapter checks).
//!
//! Scanlation sites are ordinary WordPress-ish sites but often sit
//! behind Cloudflare, so we present a mainstream browser User-Agent.
//! When a site still refuses bot-looking TLS, the reader window (a real
//! WebView) keeps working — only the background checker degrades.

use std::time::Duration;

const USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";

#[derive(Clone)]
pub struct Fetcher {
    client: reqwest::Client,
}

impl Default for Fetcher {
    fn default() -> Self {
        Self::new()
    }
}

impl Fetcher {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()
            .expect("reqwest client");
        Self { client }
    }

    /// Fetch a page's HTML.
    pub async fn get_text(&self, url: &str) -> crate::Result<String> {
        let response = self.client.get(url).send().await?.error_for_status()?;
        Ok(response.text().await?)
    }

    /// Fetch raw bytes (covers). Returns the body and content type.
    pub async fn get_bytes(&self, url: &str) -> crate::Result<(Vec<u8>, Option<String>)> {
        let response = self.client.get(url).send().await?.error_for_status()?;
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        Ok((response.bytes().await?.to_vec(), content_type))
    }
}

/// Pick a file extension for a downloaded cover from its content type
/// or URL, defaulting to jpg.
pub fn cover_extension(content_type: Option<&str>, url: &str) -> &'static str {
    match content_type {
        Some(ct) if ct.contains("png") => return "png",
        Some(ct) if ct.contains("webp") => return "webp",
        Some(ct) if ct.contains("avif") => return "avif",
        Some(ct) if ct.contains("gif") => return "gif",
        Some(ct) if ct.contains("jpeg") || ct.contains("jpg") => return "jpg",
        _ => {}
    }
    let path = url.split(['?', '#']).next().unwrap_or(url).to_lowercase();
    for (suffix, ext) in [
        (".png", "png"),
        (".webp", "webp"),
        (".avif", "avif"),
        (".gif", "gif"),
        (".jpeg", "jpg"),
        (".jpg", "jpg"),
    ] {
        if path.ends_with(suffix) {
            return ext;
        }
    }
    "jpg"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_from_content_type_wins() {
        assert_eq!(cover_extension(Some("image/png"), "https://x/y.jpg"), "png");
        assert_eq!(cover_extension(Some("image/webp"), "https://x/y"), "webp");
    }

    #[test]
    fn extension_falls_back_to_url_then_jpg() {
        assert_eq!(cover_extension(None, "https://x/cover.WEBP?v=2"), "webp");
        assert_eq!(cover_extension(None, "https://x/cover.jpeg"), "jpg");
        assert_eq!(cover_extension(Some("text/html"), "https://x/cover"), "jpg");
    }
}
