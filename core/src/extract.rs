//! Site-agnostic extraction of manga metadata from a page's HTML.
//!
//! Given the HTML of a scanlation site (usually its homepage), this
//! finds a display title, a cover image, and the chapter list — all via
//! generic heuristics, mirroring the browser extension's philosophy of
//! never hardcoding a domain.

use crate::heuristics::{chapter_info_from_url, clean_title, hosts_related};
use regex::Regex;
use scraper::{Html, Selector};
use std::collections::HashMap;
use std::sync::OnceLock;
use url::Url;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterLink {
    pub number: f64,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteInfo {
    pub title: String,
    pub cover_url: Option<String>,
    /// Distinct chapters of the dominant chapter-link family, sorted by
    /// ascending chapter number.
    pub chapters: Vec<ChapterLink>,
}

impl SiteInfo {
    pub fn latest_chapter(&self) -> Option<&ChapterLink> {
        self.chapters.last()
    }

    /// First chapter strictly after `number` — what "continue reading"
    /// should open when the last-read chapter is known.
    pub fn next_chapter_after(&self, number: f64) -> Option<&ChapterLink> {
        self.chapters.iter().find(|c| c.number > number)
    }
}

fn bad_image_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:^|[/_.-])(?:ad|ads|advert|banner|logo|avatar|favicon|sprite|icon|placeholder|loader|tracking|pixel|analytics)(?:[/_.-]|$)",
        )
        .expect("bad image regex")
    })
}

fn sel(css: &str) -> Selector {
    Selector::parse(css).expect("static selector")
}

/// Parse a page and extract title, cover, and the chapter list.
pub fn extract_site_info(html: &str, base: &Url) -> SiteInfo {
    let doc = Html::parse_document(html);
    SiteInfo {
        title: extract_title(&doc),
        cover_url: extract_cover(&doc, base),
        chapters: extract_chapters(&doc, base),
    }
}

fn meta_content(doc: &Html, css: &str) -> Option<String> {
    doc.select(&sel(css))
        .filter_map(|m| m.value().attr("content"))
        .map(str::trim)
        .find(|c| !c.is_empty())
        .map(str::to_string)
}

fn extract_title(doc: &Html) -> String {
    let raw = meta_content(doc, r#"meta[property="og:title"]"#)
        .or_else(|| meta_content(doc, r#"meta[property="og:site_name"]"#))
        .or_else(|| {
            doc.select(&sel("title"))
                .next()
                .map(|t| t.text().collect::<String>())
        })
        .unwrap_or_default();
    let cleaned = clean_title(&raw);
    if cleaned.is_empty() {
        "Untitled manga".to_string()
    } else {
        cleaned
    }
}

fn extract_cover(doc: &Html, base: &Url) -> Option<String> {
    for css in [
        r#"meta[property="og:image:secure_url"]"#,
        r#"meta[property="og:image"]"#,
        r#"meta[name="twitter:image"]"#,
        r#"meta[property="twitter:image"]"#,
    ] {
        if let Some(content) = meta_content(doc, css) {
            if let Some(abs) = absolutize(&content, base) {
                return Some(abs);
            }
        }
    }

    // Fallback: first plausible content image. Prefer ones that look
    // like a cover/poster/thumbnail, then any non-junk image.
    let imgs: Vec<String> = doc
        .select(&sel("img"))
        .filter_map(|img| {
            let v = img.value();
            let src = v
                .attr("src")
                .or_else(|| v.attr("data-src"))
                .or_else(|| v.attr("data-lazy-src"))?;
            let class = v.attr("class").unwrap_or_default();
            let hint = format!("{src} {class}");
            let abs = absolutize(src, base)?;
            if bad_image_re().is_match(&abs) {
                return None;
            }
            Some((abs, hint))
        })
        .map(|(abs, hint)| {
            let coverish = Regex::new(r"(?i)cover|poster|thumb|portrait")
                .expect("cover hint regex")
                .is_match(&hint);
            (abs, coverish)
        })
        .fold(Vec::new(), |mut acc, (abs, coverish)| {
            if coverish {
                acc.insert(0, abs);
            } else {
                acc.push(abs);
            }
            acc
        });
    imgs.into_iter().next()
}

fn extract_chapters(doc: &Html, base: &Url) -> Vec<ChapterLink> {
    // Group same-host chapter-looking links by URL family, then keep
    // the family with the most distinct chapter numbers.
    let mut families: HashMap<String, HashMap<u64, ChapterLink>> = HashMap::new();

    for a in doc.select(&sel("a[href]")) {
        let Some(href) = a.value().attr("href") else {
            continue;
        };
        let Some(url) = base.join(href.trim()).ok() else {
            continue;
        };
        let same_site = match (url.host_str(), base.host_str()) {
            (Some(a), Some(b)) => hosts_related(a, b),
            _ => false,
        };
        if !same_site || !matches!(url.scheme(), "http" | "https") {
            continue;
        }
        let Some(info) = chapter_info_from_url(&url) else {
            continue;
        };
        let mut clean = url.clone();
        clean.set_fragment(None);
        families
            .entry(info.family.clone())
            .or_default()
            .entry(number_key(info.number))
            .or_insert(ChapterLink {
                number: info.number,
                url: clean.into(),
            });
    }

    let best = families
        .into_values()
        .max_by_key(|group| group.len())
        .unwrap_or_default();
    if best.len() < 2 {
        // A single "chapter-looking" link is far more likely to be noise
        // (an unrelated numbered page) than a one-chapter manga.
        return Vec::new();
    }

    let mut chapters: Vec<ChapterLink> = best.into_values().collect();
    chapters.sort_by(|a, b| a.number.total_cmp(&b.number));
    chapters
}

/// f64 chapter numbers as stable dedup keys (they come from parsing
/// short decimal strings, so the bit patterns are consistent).
fn number_key(n: f64) -> u64 {
    n.to_bits()
}

fn absolutize(raw: &str, base: &Url) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.starts_with("data:") {
        return None;
    }
    let url = base.join(trimmed).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    Some(url.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Url {
        Url::parse("https://zom-100.example/").unwrap()
    }

    const HOMEPAGE: &str = r##"
    <html><head>
      <title>Zom 100: Bucket List of the Dead | Read Manga Online</title>
      <meta property="og:image" content="/wp-content/uploads/cover.jpg">
    </head><body>
      <a href="/category/news/">News</a>
      <a href="/page/2/">Older posts</a>
      <a href="https://other-site.example/manga/foo-chapter-1/">off-site</a>
      <a href="https://w6.zom-100.example/manga/zom-100-chapter-12/">Chapter 12 on the new mirror</a>
      <a href="/manga/zom-100-chapter-1/">Chapter 1</a>
      <a href="/manga/zom-100-chapter-2/">Chapter 2</a>
      <a href="/manga/zom-100-chapter-2/#comments">Chapter 2 comments</a>
      <a href="/manga/zom-100-chapter-10-5/">Chapter 10.5</a>
      <a href="/manga/zom-100-chapter-11/">Chapter 11</a>
    </body></html>
    "##;

    #[test]
    fn extracts_cleaned_title() {
        let info = extract_site_info(HOMEPAGE, &base());
        assert_eq!(info.title, "Zom 100: Bucket List of the Dead");
    }

    #[test]
    fn extracts_absolute_cover_from_og_image() {
        let info = extract_site_info(HOMEPAGE, &base());
        assert_eq!(
            info.cover_url.as_deref(),
            Some("https://zom-100.example/wp-content/uploads/cover.jpg")
        );
    }

    #[test]
    fn extracts_dominant_chapter_family_sorted_and_deduped() {
        let info = extract_site_info(HOMEPAGE, &base());
        let numbers: Vec<f64> = info.chapters.iter().map(|c| c.number).collect();
        assert_eq!(numbers, vec![1.0, 2.0, 10.5, 11.0, 12.0]);
        assert_eq!(
            info.latest_chapter().unwrap().url,
            "https://w6.zom-100.example/manga/zom-100-chapter-12/"
        );
    }

    #[test]
    fn ignores_offsite_and_pagination_links() {
        let info = extract_site_info(HOMEPAGE, &base());
        assert!(info
            .chapters
            .iter()
            .all(|c| c.url.contains("zom-100.example/manga/")));
        assert!(!info.chapters.iter().any(|c| c.url.contains("other-site")));
    }

    #[test]
    fn next_chapter_after_picks_first_newer() {
        let info = extract_site_info(HOMEPAGE, &base());
        assert_eq!(info.next_chapter_after(2.0).unwrap().number, 10.5);
        assert_eq!(info.next_chapter_after(11.0).unwrap().number, 12.0);
        assert!(info.next_chapter_after(12.0).is_none());
    }

    #[test]
    fn single_numbered_link_is_treated_as_noise() {
        let html = r#"<a href="/blog/post-7/">post</a>"#;
        let info = extract_site_info(html, &base());
        assert!(info.chapters.is_empty());
    }

    #[test]
    fn cover_falls_back_to_coverish_img() {
        let html = r##"
          <img src="/img/banner-ad.png">
          <img class="cover" data-src="/img/vol1-cover.webp">
        "##;
        let info = extract_site_info(html, &base());
        assert_eq!(
            info.cover_url.as_deref(),
            Some("https://zom-100.example/img/vol1-cover.webp")
        );
    }

    #[test]
    fn missing_everything_yields_placeholder_title() {
        let info = extract_site_info("<html></html>", &base());
        assert_eq!(info.title, "Untitled manga");
        assert!(info.cover_url.is_none());
        assert!(info.chapters.is_empty());
    }
}
