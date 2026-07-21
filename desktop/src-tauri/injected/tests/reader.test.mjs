// @ts-nocheck — plain node:test file evaluated outside the SvelteKit
// TS project; the vm harness is intentionally untyped.
// Tests for the injected reader script, run with `node --test`.
//
// The harness mirrors the Prettify Manga Reader extension's test setup:
// reader.js is evaluated inside a `node:vm` context with a minimal DOM
// stub, and the pure functions are reached through the test API the
// script exposes when window.__PMR_ENABLE_TEST_API__ is set.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Objects created inside the vm realm have foreign prototypes, which
// breaks deepStrictEqual — flatten them first.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeLocalStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    dump: () => Object.fromEntries(store)
  };
}

function loadApi({ localStorage, css, appOrigins, origin } = {}) {
  const code = fs.readFileSync(new URL("../reader.js", import.meta.url), "utf8");
  class FakeElement {}
  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }
  const createdElements = [];
  const context = {
    console,
    URL,
    URLSearchParams,
    Element: FakeElement,
    MutationObserver: FakeMutationObserver,
    location: {
      href: "https://example.test/manga/series-chapter-10/",
      origin: origin || "https://example.test",
      pathname: "/manga/series-chapter-10/",
      search: ""
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
    requestAnimationFrame: (fn) => fn(),
    document: {
      body: {},
      documentElement: {
        appendChild(el) {
          createdElements.push(el);
        }
      },
      head: null,
      addEventListener() {},
      removeEventListener() {},
      getElementById() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      createElement(tag) {
        return {
          tagName: tag,
          innerHTML: "",
          remove() {},
          appendChild() {},
          addEventListener() {},
          querySelector() {
            return null;
          }
        };
      },
      title: "Series Chapter 10"
    },
    window: {
      __PMR_ENABLE_TEST_API__: true,
      __FRANK_APP_ORIGINS__: appOrigins,
      __FRANK_READER_CSS__: css,
      localStorage,
      addEventListener() {},
      clearTimeout: () => {},
      setTimeout: () => 1
    }
  };
  vm.createContext(context);
  vm.runInContext(code, context, { filename: "reader.js" });
  return { api: context.window.__PMR_TEST_API__, createdElements, context };
}

test("test api is exposed", () => {
  const { api } = loadApi();
  assert.ok(api);
});

test("default startup mode is book with night off", () => {
  const { api } = loadApi();
  assert.equal(api.DEFAULT_READER_MODE, "book");
  assert.equal(api.DEFAULT_NIGHT_MODE, 0);
  assert.equal(api.NIGHT_MODE_LEVELS, 3);
});

test("reader stylesheet from the rust side is injected", () => {
  const { createdElements } = loadApi({ css: ".pmr-toolbar{color:red}" });
  const style = createdElements.find((el) => el.tagName === "style");
  assert.ok(style, "expected a <style> element appended to documentElement");
  assert.equal(style.textContent, ".pmr-toolbar{color:red}");
});

test("no stylesheet is injected when css payload is missing", () => {
  const { createdElements } = loadApi();
  assert.equal(createdElements.filter((el) => el.tagName === "style").length, 0);
});

test("chapter info parses explicit chapter urls", () => {
  const { api } = loadApi();
  const info = api.chapterInfoFromUrl("https://example.test/manga/foo-chapter-12/");
  assert.equal(info.number, 12);
  assert.equal(info.explicit, true);
});

test("isExplicitChapterUrl gates the auto-open heuristic", () => {
  const { api } = loadApi();
  assert.equal(api.isExplicitChapterUrl("https://example.test/manga/foo-chapter-12/"), true);
  assert.equal(api.isExplicitChapterUrl("https://example.test/"), false);
  assert.equal(api.isExplicitChapterUrl("https://example.test/about-us/"), false);
});

test("book mode keeps first page solo then pairs", () => {
  const { api } = loadApi();
  const pages = [1, 2, 3, 4, 5].map((n) => ({ url: `https://x/p${n}.jpg`, width: 800, height: 1200 }));
  const spreads = api.buildSpreads("book", pages);
  assert.deepEqual(
    plain(spreads.map((s) => s.pageIndexes)),
    [[0], [1, 2], [3, 4]]
  );
});

test("landscape spreads stay solo in double mode", () => {
  const { api } = loadApi();
  const pages = [
    { url: "https://x/p1.jpg", width: 800, height: 1200 },
    { url: "https://x/p2.jpg", width: 2000, height: 1200 },
    { url: "https://x/p3.jpg", width: 800, height: 1200 },
    { url: "https://x/p4.jpg", width: 800, height: 1200 }
  ];
  const spreads = api.buildSpreads("double", pages);
  assert.deepEqual(
    plain(spreads.map((s) => s.pageIndexes)),
    [[0], [1], [2, 3]]
  );
});

test("settings persist through localStorage", async () => {
  const localStorage = makeLocalStorage();
  const { api } = loadApi({ localStorage });
  await api.loadSettings();
  api.getSettings().mode = "single";
  api.getSettings().night = 2;
  api.saveSettings();

  const stored = localStorage.dump();
  const [key, raw] = Object.entries(stored)[0];
  assert.match(key, /pmr\.settings/);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.mode, "single");
  assert.equal(parsed.night, 2);

  // A fresh page load on the same site sees the saved settings.
  const second = loadApi({ localStorage });
  const settings = await second.api.loadSettings();
  assert.equal(settings.mode, "single");
  assert.equal(settings.night, 2);
});

test("corrupt stored settings fall back to defaults", async () => {
  const localStorage = makeLocalStorage({ "pmr.settings.v1": "{not json" });
  const { api } = loadApi({ localStorage });
  const settings = await api.loadSettings();
  assert.equal(settings.mode, "book");
  assert.equal(settings.night, 0);
});

test("manga mode preferences are remembered per manga key", () => {
  const { api } = loadApi();
  const prefs = api.withMangaModePreference({}, "generic:path:/manga/foo-chapter-#", "double");
  assert.equal(api.readerModeForMangaKey("generic:path:/manga/foo-chapter-#", prefs), "double");
  assert.equal(api.readerModeForMangaKey("generic:path:/manga/bar-chapter-#", prefs), "book");
});

test("next/prev chapter links are scored from navigation context", () => {
  const { api } = loadApi();
  const currentInfo = api.chapterInfoFromUrl("https://example.test/manga/series-chapter-10/");

  const nav = (href, text) => {
    const ancestor = { id: "", className: "navigation post-navigation nav-links", getAttribute: () => "" };
    return {
      textContent: text,
      outerHTML: `<a href="${href}">${text}</a>`,
      parentElement: null,
      getAttribute(name) {
        if (name === "href") return href;
        return "";
      },
      closest() {
        return ancestor;
      },
      querySelector() {
        return null;
      }
    };
  };

  const next = api.scoreChapterNavElement(
    nav("https://example.test/manga/series-chapter-11/", "Next Chapter"),
    currentInfo
  );
  assert.equal(next.direction, "next");
  assert.ok(next.score >= 80);

  const prev = api.scoreChapterNavElement(
    nav("https://example.test/manga/series-chapter-9/", "Previous Chapter"),
    currentInfo
  );
  assert.equal(prev.direction, "prev");

  const junk = api.scoreChapterNavElement(
    nav("https://example.test/feed/", "RSS Feed"),
    currentInfo
  );
  assert.equal(junk, null);
});

test("page navigation at chapter end flips to next chapter", () => {
  const { api } = loadApi();
  api.setChapterNavForTest({ next: { url: "https://example.test/manga/series-chapter-11/" } });
  const spreads = [{ pageIndexes: [0] }, { pageIndexes: [1] }, { type: "chapter-nav", pageIndexes: [] }];
  const intent = api.pageNavigationIntentFromKey(" ", false, 1, spreads);
  assert.deepEqual(plain(intent), { type: "chapter", direction: "next" });

  const mid = api.pageNavigationIntentFromKey(" ", false, 0, spreads);
  assert.deepEqual(plain(mid), { type: "spread", delta: 1 });
});

test("script stands down entirely on the app's own UI origins", () => {
  const { api, createdElements } = loadApi({
    appOrigins: ["https://example.test", "tauri://localhost"]
  });
  assert.equal(api, undefined);
  assert.equal(createdElements.length, 0);
});

test("home pill is created on site pages", () => {
  const { createdElements } = loadApi();
  const pill = createdElements.find((el) => el.id === "pmr-home-button");
  assert.ok(pill, "expected the #pmr-home-button container");
  assert.match(pill.innerHTML, /Library/);
});

test("goHome navigates to the rust-intercepted home signal url", () => {
  const { api, context } = loadApi();
  api.goHome();
  assert.equal(context.location.href, api.HOME_SIGNAL_URL);
  assert.match(api.HOME_SIGNAL_URL, /home\.frank-scanlation\.internal/);
});

test("mangadex chapter pages are recognized for auto-open", () => {
  const { api } = loadApi();
  assert.equal(
    api.isMangaDexReaderPage({ href: "https://mangadex.org/chapter/2827a899-0dc3-4841-9869-01ff9d3f0ae2/3" }),
    true
  );
  assert.equal(api.isMangaDexReaderPage({ href: "https://mangadex.org/title/x/y" }), false);
});

test("mangadex api chapter list resolves prev/next by number", () => {
  const { api } = loadApi();
  const chapters = [
    { number: 1, id: "aaa" },
    { number: 1, id: "dup" },
    { number: 2, id: "bbb" },
    { number: 2.5, id: "ccc" },
    { number: 3, id: "ddd" }
  ];
  const nav = plain(api.mangaDexNavFromChapterList(chapters, 2, "https://mangadex.org"));
  assert.equal(nav.prev.url, "https://mangadex.org/chapter/aaa");
  assert.equal(nav.next.url, "https://mangadex.org/chapter/ccc");

  const atStart = plain(api.mangaDexNavFromChapterList(chapters, 1, "https://mangadex.org"));
  assert.equal(atStart.prev, undefined);
  assert.equal(atStart.next.url, "https://mangadex.org/chapter/bbb");

  assert.equal(api.mangaDexNavFromChapterList([], 2), null);
});

test("window.open is neutered on reading pages", () => {
  const { context } = loadApi();
  assert.equal(typeof context.window.open, "function");
  assert.equal(context.window.open("https://ads.example/pop"), null);
});

test("hostile overlay verdict is conservative", () => {
  const { api } = loadApi();
  const base = { position: "fixed", zIndex: 999999, coverage: 0.95, textLength: 0, hasForeignFrame: false };

  // The classic transparent click-catcher and the fullscreen ad iframe.
  assert.equal(api.hostileOverlayVerdict(base), true);
  assert.equal(api.hostileOverlayVerdict({ ...base, textLength: 500, hasForeignFrame: true }), true);

  // Site chrome shapes that must survive: modals with real content,
  // sticky headers, low-z lightboxes, absolutely-positioned wrappers.
  assert.equal(api.hostileOverlayVerdict({ ...base, textLength: 500 }), false);
  assert.equal(api.hostileOverlayVerdict({ ...base, coverage: 0.3 }), false);
  assert.equal(api.hostileOverlayVerdict({ ...base, zIndex: 100 }), false);
  assert.equal(api.hostileOverlayVerdict({ ...base, zIndex: NaN }), false);
  assert.equal(api.hostileOverlayVerdict({ ...base, position: "absolute" }), false);
});
