//! Chapter-number heuristics, ported from the Prettify Manga Reader
//! extension's `chapterInfoFromText` / `chapterInfoFromUrl`.
//!
//! The "family" concept: a URL like
//! `https://site.tld/manga/foo-chapter-12/` normalizes to the family
//! `https://site.tld/manga/foo-chapter-#` — two URLs belong to the same
//! manga when their families match, and the chapter number orders them.

use regex::Regex;
use std::sync::OnceLock;
use url::Url;

#[derive(Debug, Clone, PartialEq)]
pub struct ChapterInfo {
    /// Chapter number. Sub-chapters map to decimals: `10.5` stays
    /// `10.5`, a letter suffix like `10b` becomes `10.02`.
    pub number: f64,
    /// The text with the chapter number replaced by `#` — used to group
    /// links that differ only by chapter number.
    pub family: String,
    /// True when an explicit chapter keyword (chapter/chap/ch/episode/ep)
    /// was present, not just a bare trailing number.
    pub explicit: bool,
}

fn explicit_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // JS: /(?:chapter|chap|ch|episode|ep)[-_\s\/]*([0-9]+)(?:(?:[._-]([0-9]+))|(?:[._-]?([a-z]))(?=$|[^a-z0-9]))?/i
        // The lookahead after the letter suffix is emulated by consuming
        // the boundary; we only read the capture groups so that is safe.
        Regex::new(
            r"(?i)(?:chapter|chap|ch|episode|ep)[-_\s/]*([0-9]+)(?:(?:[._-]([0-9]+))|(?:[._-]?([a-z])(?:[^a-z0-9]|$)))?",
        )
        .expect("explicit chapter regex")
    })
}

fn digits_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[0-9]+").expect("digits regex"))
}

fn pagination_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)(?:^|/)page/\d+(?:/|$)").expect("pagination regex"))
}

fn is_boundary(c: Option<char>) -> bool {
    matches!(c, None | Some('-' | '_' | '/' | ' ' | '\t' | '\n'))
}

/// Delimiter-bounded numbers of 1–5 digits, as `(start, end)` byte
/// ranges. The extension's bare fallback matches the *first* of these;
/// we deliberately take the *last*, which is the actual chapter in URLs
/// like `/zom-100/112/` where the series slug itself contains a number.
fn bare_number_ranges(text: &str) -> Vec<(usize, usize)> {
    digits_re()
        .find_iter(text)
        .filter(|m| {
            let before = text[..m.start()].chars().next_back();
            let mut rest = text[m.end()..].chars();
            let mut after = rest.next();
            if after == Some('/') && rest.clone().next().is_none() {
                after = None;
            }
            m.len() <= 5 && is_boundary(before) && is_boundary(after)
        })
        .map(|m| (m.start(), m.end()))
        .collect()
}

/// Parse chapter info out of arbitrary text (usually a URL path or a
/// page title). Ported from the extension's `chapterInfoFromText`.
pub fn chapter_info_from_text(text: &str, family_source: &str) -> Option<ChapterInfo> {
    let normalized = text.to_lowercase();

    let (number, explicit) = if let Some(caps) = explicit_re().captures(&normalized) {
        (chapter_number_from_captures(&caps)?, true)
    } else {
        if pagination_re().is_match(&normalized) {
            return None;
        }
        let (start, end) = *bare_number_ranges(&normalized).last()?;
        (normalized[start..end].parse::<f64>().ok()?, false)
    };

    let source = if family_source.is_empty() {
        text
    } else {
        family_source
    };
    Some(ChapterInfo {
        number,
        family: family_for(source),
        explicit,
    })
}

/// Parse chapter info from a URL's decoded path.
pub fn chapter_info_from_url(url: &Url) -> Option<ChapterInfo> {
    let path = percent_decode(url.path());
    let family_source = format!(
        "{}://{}{}",
        url.scheme(),
        url.host_str().unwrap_or_default(),
        path
    );
    chapter_info_from_text(&path, &family_source)
}

fn chapter_number_from_captures(caps: &regex::Captures) -> Option<f64> {
    let base: f64 = caps.get(1)?.as_str().parse().ok()?;
    if let Some(decimal) = caps.get(2) {
        return format!("{}.{}", caps.get(1)?.as_str(), decimal.as_str())
            .parse()
            .ok();
    }
    if let Some(letter) = caps.get(3) {
        let c = letter.as_str().bytes().next()? as f64;
        return Some(base + (c - b'a' as f64 + 1.0) / 100.0);
    }
    Some(base)
}

/// Replace the chapter-number portion of `source` with `#`: the
/// explicit `chapter-N` token when present, otherwise the last bounded
/// bare number (matching the number `chapter_info_from_text` picked).
fn family_for(source: &str) -> String {
    let lowered = source.to_lowercase();
    let replaced = if explicit_re().is_match(&lowered) {
        explicit_re().replace(&lowered, "chapter-#").into_owned()
    } else if let Some(&(start, end)) = bare_number_ranges(&lowered).last() {
        format!("{}#{}", &lowered[..start], &lowered[end..])
    } else {
        lowered
    };
    replaced.trim_end_matches('/').to_string()
}

fn percent_decode(input: &str) -> String {
    let mut out = Vec::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| input.to_string())
}

/// Clean a page `<title>` into a manga display title: drop everything
/// after the first separator when the head segment is usable, and strip
/// chapter/volume noise.
pub fn clean_title(raw: &str) -> String {
    static NOISE: OnceLock<Regex> = OnceLock::new();
    let noise = NOISE.get_or_init(|| {
        Regex::new(r"(?i)\b(?:read|chapter|chap|ch|episode|ep|volume|vol)\.?\s*\d+(?:[._-]\d+)?\b")
            .expect("title noise regex")
    });

    let collapsed: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let head = collapsed
        .split(['|', '–', '—'])
        .next()
        .unwrap_or(&collapsed)
        .trim();
    // " - " is a separator too, but only when the head stays meaningful.
    let head = match head.split_once(" - ") {
        Some((left, _)) if left.trim().len() >= 3 => left.trim(),
        _ => head,
    };
    let cleaned = noise.replace_all(head, "");
    let cleaned = cleaned.trim().trim_end_matches(['-', ':', ',']).trim();
    if cleaned.len() >= 3 {
        cleaned.to_string()
    } else {
        collapsed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(text: &str) -> Option<ChapterInfo> {
        chapter_info_from_text(text, text)
    }

    #[test]
    fn explicit_chapter_keyword() {
        let i = info("/manga/one-piece-chapter-1050/").unwrap();
        assert_eq!(i.number, 1050.0);
        assert!(i.explicit);
        assert_eq!(i.family, "/manga/one-piece-chapter-#");
    }

    #[test]
    fn decimal_sub_chapter() {
        let i = info("/series/foo-chapter-10.5/").unwrap();
        assert_eq!(i.number, 10.5);
        assert!(i.explicit);
    }

    #[test]
    fn letter_sub_chapter_maps_to_decimal() {
        let i = info("/series/foo-chapter-10b/").unwrap();
        assert!((i.number - 10.02).abs() < 1e-9);
    }

    #[test]
    fn short_ch_prefix() {
        let i = info("/read/ch-42/").unwrap();
        assert_eq!(i.number, 42.0);
        assert!(i.explicit);
    }

    #[test]
    fn bare_trailing_number_is_not_explicit() {
        let i = info("/zom-100/112/").unwrap();
        assert_eq!(i.number, 112.0);
        assert!(!i.explicit);
        assert_eq!(i.family, "/zom-100/#");
    }

    #[test]
    fn wordpress_pagination_is_rejected() {
        assert!(info("/page/2/").is_none());
        assert!(info("/manga/page/3").is_none());
    }

    #[test]
    fn plain_text_without_numbers_is_rejected() {
        assert!(info("/about-us/").is_none());
        assert!(info("/").is_none());
    }

    #[test]
    fn same_series_shares_family_across_chapters() {
        let a = info("/manga/foo-chapter-3/").unwrap();
        let b = info("/manga/foo-chapter-4/").unwrap();
        assert_eq!(a.family, b.family);
        let c = info("/manga/bar-chapter-4/").unwrap();
        assert_ne!(a.family, c.family);
    }

    #[test]
    fn from_url_uses_decoded_path_and_origin_family() {
        let url = Url::parse("https://example.test/manga/foo-chapter-12/").unwrap();
        let i = chapter_info_from_url(&url).unwrap();
        assert_eq!(i.number, 12.0);
        assert_eq!(i.family, "https://example.test/manga/foo-chapter-#");
    }

    #[test]
    fn from_url_ignores_query_only_numbers() {
        let url = Url::parse("https://example.test/reader/?id=99").unwrap();
        assert!(chapter_info_from_url(&url).is_none());
    }

    #[test]
    fn clean_title_strips_site_suffixes() {
        assert_eq!(
            clean_title("Zom 100: Bucket List of the Dead | Read Online Free"),
            "Zom 100: Bucket List of the Dead"
        );
        assert_eq!(
            clean_title("Rent a Girlfriend Manga - Read Chapters Online"),
            "Rent a Girlfriend Manga"
        );
    }

    #[test]
    fn clean_title_strips_chapter_noise() {
        assert_eq!(
            clean_title("Smoking Behind the Supermarket With You Chapter 45"),
            "Smoking Behind the Supermarket With You"
        );
    }

    #[test]
    fn clean_title_keeps_short_titles_whole() {
        assert_eq!(clean_title("  Berserk  "), "Berserk");
    }
}
