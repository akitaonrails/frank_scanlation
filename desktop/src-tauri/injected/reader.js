(function () {
  "use strict";

  if (window.__PRETTIFY_MANGA_READER_LOADED__) {
    return;
  }
  window.__PRETTIFY_MANGA_READER_LOADED__ = true;

  // Single-window app: this script is injected into every page of the
  // main window, including the library UI itself. The Rust side tells
  // us which origins are the app; there we do nothing at all.
  const FRANK_APP_ORIGINS = Array.isArray(window.__FRANK_APP_ORIGINS__) ? window.__FRANK_APP_ORIGINS__ : [];
  if (FRANK_APP_ORIGINS.includes(location.origin)) {
    return;
  }

  // Navigating to this URL is the "take me back to the library" signal;
  // the Rust on_navigation hook intercepts it and swaps in the app UI.
  const HOME_SIGNAL_URL = "https://home.frank-scanlation.internal/";
  const HOME_BUTTON_ID = "pmr-home-button";

  function goHome() {
    location.href = HOME_SIGNAL_URL;
  }

  function ensureHomeButton() {
    if (!document.documentElement) {
      return;
    }
    let container = document.getElementById(HOME_BUTTON_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = HOME_BUTTON_ID;
      container.innerHTML = '<button class="pmr-button" type="button" title="Back to your library (h)">⌂ Library</button>';
      container.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        goHome();
      });
    }
    // (Re-)append so it stacks above the reader overlay, which shares
    // the maximum z-index and would otherwise cover it.
    document.documentElement.appendChild(container);
  }

  function handleHomeKeyDown(event) {
    if (event.key !== "h" && event.key !== "H") {
      return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey || isEditableTarget(event.target)) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    goHome();
  }

  document.addEventListener("keydown", handleHomeKeyDown, true);
  ensureHomeButton();
  document.addEventListener("DOMContentLoaded", ensureHomeButton, { once: true });

  // ---- Minimal ad protections for reading pages ----
  // The Rust side already refuses top-level navigations that leave the
  // manga's domains. These two guards handle what never reaches a
  // navigation: popunders via window.open, and overlay ads injected on
  // top of the page. Both are deliberately conservative — site chrome
  // present at load time is never touched.
  const OVERLAY_MIN_Z_INDEX = 5000;
  const OVERLAY_MIN_COVERAGE = 0.8;
  const OVERLAY_MAX_TEXT_CHARS = 60;

  // Pure decision over measured traits, so it's testable: a hostile
  // overlay is fixed, huge-z, near-fullscreen, and either carries a
  // foreign ad iframe or has no real text (transparent click-catcher).
  function hostileOverlayVerdict(traits) {
    return traits.position === "fixed"
      && Number.isFinite(traits.zIndex)
      && traits.zIndex >= OVERLAY_MIN_Z_INDEX
      && traits.coverage >= OVERLAY_MIN_COVERAGE
      && (traits.hasForeignFrame || traits.textLength <= OVERLAY_MAX_TEXT_CHARS);
  }

  function overlayTraits(element) {
    const style = window.getComputedStyle ? window.getComputedStyle(element) : null;
    const rect = element.getBoundingClientRect
      ? element.getBoundingClientRect()
      : { width: 0, height: 0 };
    const viewportArea = Math.max(1, (window.innerWidth || 1) * (window.innerHeight || 1));
    const hasForeignFrame = Array.from(element.querySelectorAll?.("iframe") || []).some((frame) => {
      const src = safeUrl(frame.getAttribute("src") || "", location.href);
      return Boolean(src && src.origin !== location.origin);
    });
    return {
      position: style ? style.position : "",
      zIndex: style ? Number(style.zIndex) : NaN,
      coverage: (rect.width * rect.height) / viewportArea,
      textLength: normalizeWhitespace(element.textContent || "").length,
      hasForeignFrame
    };
  }

  function isPmrElement(element) {
    return Boolean(
      (typeof element.id === "string" && element.id.startsWith("pmr-"))
        || element.closest?.("#pmr-reader-root, #pmr-home-button, #pmr-reader-activator, #pmr-kindle-toolbar, #pmr-reader-toast")
    );
  }

  function suppressHostileOverlay(element) {
    if (!(element instanceof Element) || isPmrElement(element)) {
      return false;
    }
    const tag = element.tagName ? element.tagName.toLowerCase() : "";
    if (["script", "style", "link", "meta", "head", "body", "html"].includes(tag)) {
      return false;
    }
    if (!hostileOverlayVerdict(overlayTraits(element))) {
      return false;
    }
    element.style.setProperty("display", "none", "important");
    element.style.setProperty("pointer-events", "none", "important");
    return true;
  }

  function setupAdProtections() {
    // Popunder kill: nothing in a reading flow needs window.open, and
    // this script runs before any site/ad script can grab a reference.
    window.open = function blockedPopup() {
      return null;
    };

    const sweep = (nodes) => {
      nodes.forEach((node) => {
        if (suppressHostileOverlay(node)) {
          console.warn("FRANK Scanlation hid a hostile overlay", node);
        }
      });
    };
    const overlayObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => sweep(Array.from(mutation.addedNodes || [])));
    });
    const observeOverlayRoots = () => {
      [document.documentElement, document.body].forEach((root) => {
        if (root) {
          overlayObserver.observe(root, { childList: true });
        }
      });
    };
    observeOverlayRoots();
    document.addEventListener("DOMContentLoaded", observeOverlayRoots, { once: true });
  }

  // Running inside the FRANK Scanlation Tauri webview, not a browser
  // extension: the Rust side prepends the reader stylesheet to this
  // script as window.__FRANK_READER_CSS__ and we inject it into the page.
  function ensureReaderStyles() {
    if (!document.documentElement || document.getElementById("pmr-reader-styles")) {
      return;
    }
    const css = window.__FRANK_READER_CSS__;
    if (typeof css !== "string" || !css) {
      return;
    }
    const style = document.createElement("style");
    style.id = "pmr-reader-styles";
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }
  ensureReaderStyles();
  document.addEventListener("DOMContentLoaded", ensureReaderStyles, { once: true });

  const ROOT_ID = "pmr-reader-root";
  const ACTIVATOR_ID = "pmr-reader-activator";
  const KINDLE_TOOLBAR_ID = "pmr-kindle-toolbar";
  const TOAST_ID = "pmr-reader-toast";
  const STORAGE_KEY = "pmr.settings.v1";
  const CHAPTER_AUTO_OPEN_KEY = "pmr.chapterAutoOpen.v1";
  const DEFAULT_READER_MODE = "book";
  const DEFAULT_NIGHT_MODE = 0;
  const NIGHT_MODE_LEVELS = 3;
  const KINDLE_READER_HOST_RE = /^read\.(?:amazon|kindle)\.(?:com|co\.jp|co\.uk|de|fr|it|es|nl|se|pl|ca|com\.br|com\.mx|com\.au|in|sg|ae|sa|eg|com\.tr|com\.be)$/i;
  const KINDLE_MANGA_PATH_RE = /^\/manga(?:\/|$)/i;
  const MANGADEX_HOST = "mangadex.org";
  const MANGADEX_CHAPTER_PATH_RE = /^\/chapter\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(\d+))?\/?$/i;
  const MANGADEX_AT_HOME_API_BASE = "https://api.mangadex.org/at-home/server/";
  const KINDLE_FRAME_MESSAGE_TYPE = "PMR_KINDLE_FRAME_COMMAND";
  const KINDLE_SURFACE_REFRESH_DELAY_MS = 140;
  const KINDLE_PAGE_CONTAINER_SELECTOR = [
    "#sitbreaderpagecontainer",
    "[id*='readerpagecontainer' i]",
    "[id*='pagecontainer' i][id*='reader' i]",
    "[class*='readerpagecontainer' i]",
    "[class*='pagecontainer' i][class*='reader' i]",
    "[data-testid*='reader' i][data-testid*='page' i]"
  ].join(", ");
  const KINDLE_PAGE_SURFACE_SELECTOR = "img, canvas, svg, [role='img'], [style*='background-image']";
  const MODES = ["single", "double", "book"];
  const MODE_LABELS = {
    single: "Single",
    double: "Double",
    book: "Book"
  };
  const NIGHT_MODE_LABELS = ["Night Off", "Night 1", "Night 2", "Night 3"];
  const IMAGE_ATTRS = [
    "currentSrc",
    "src",
    "data-src",
    "data-lazy-src",
    "data-original",
    "data-original-src",
    "data-full-image",
    "data-light-image",
    "data-image",
    "data-url"
  ];
  const SRCSET_ATTRS = ["srcset", "data-srcset", "data-lazy-srcset"];
  const IMAGE_URL_RE = /(?:https?:\/\/|\/\/|\/|(?:\.{1,2}\/)?[a-z0-9_.-]+\/)[^"'()<>\s\\]+?\.(?:jpe?g|png|webp|avif)(?:\?[^"'()<>\s\\]*)?/gi;
  const BAD_URL_RE = /(?:^|[\/_.-])(?:ad|ads|advert|advertisement|banner|logo|avatar|favicon|sprite|icon|placeholder|loader|tracking|pixel|analytics)(?:[\/_.-]|$)/i;
  const COMMON_AD_SIZES = new Set([
    "728x90",
    "970x90",
    "970x250",
    "320x50",
    "300x50",
    "300x250",
    "336x280",
    "160x600",
    "120x600"
  ]);
  // Heuristic thresholds live here so release audits can reason about them
  // without hunting through detection, layout, and navigation code.
  const MIN_DETECTED_PAGES = 3;
  const LANDSCAPE_SPREAD_RATIO = 1.12;
  const MAX_SELECTED_PAGES = 240;
  const MAX_REASONABLE_PAGE_NUMBER = 240;
  const EMBEDDED_SCAN_MAX_BYTES = 2_000_000;
  const EMBEDDED_SCRIPT_MAX_BYTES = 700_000;
  const CHAPTER_NAV_HIGH_CONFIDENCE = 80;
  const CHAPTER_NAV_CONTEXT_CONFIDENCE = 45;
  const CHAPTER_NAV_REL_SCORE = 110;
  const CHAPTER_NAV_TEXT_SCORE = 85;
  const CHAPTER_NAV_SCOPE_SIGNAL_SCORE = 45;
  const CHAPTER_NAV_ICON_CONTEXT_SCORE = 35;
  const CHAPTER_NAV_ICON_WEAK_SCORE = 15;
  const CHAPTER_NAV_WRONG_DIRECTION_PENALTY = 70;
  const CHAPTER_NAV_NUMERIC_DIRECTION_OVERRIDE_SCORE = 150;
  const CHAPTER_NAV_HTML_SAMPLE_CHARS = 900;
  const READABLE_TITLE_MAX_CHARS = 80;
  const ELEMENT_SIGNATURE_MAX_CHARS = 80;
  const ACTIVATOR_INITIAL_DELAY_MS = 700;
  const ACTIVATOR_PAGESHOW_DELAY_MS = 500;
  const ACTIVATOR_AFTER_CLOSE_DELAY_MS = 400;
  const ACTIVATOR_MUTATION_DELAY_MS = 900;
  const ACTIVATOR_MAX_MUTATION_REFRESHES = 12;
  const LAYOUT_REFRESH_DELAY_MS = 80;
  const TOAST_DURATION_MS = 2200;
  const CHAPTER_AUTO_OPEN_TTL_MS = 90_000;
  const MANGADEX_AT_HOME_CACHE_MS = 10 * 60_000;
  const MAX_MANGA_MODE_PREFS = 100;

  let settings = {
    mode: DEFAULT_READER_MODE,
    snap: true,
    night: DEFAULT_NIGHT_MODE,
    mangaModes: {}
  };
  let settingsLoaded = false;
  let active = false;
  let readerClosedByUser = false;
  let pages = [];
  let spreads = [];
  let chapterNav = null;
  let currentSpreadIndex = 0;
  let currentMangaKey = "";
  let readerRoot = null;
  let scrollEl = null;
  let mutationObserver = null;
  let activatorRefreshTimer = 0;
  let scrollRaf = 0;
  let rasterNudgeTimer = 0;
  let rasterNudgeTick = false;
  let lastRasterNudgeAt = 0;
  let layoutRefreshTimer = 0;
  let kindleHandlerActive = false;
  let kindleToolbar = null;
  let kindleMutationObserver = null;
  let kindleSurfaceRefreshTimer = 0;
  let kindleForwardingKey = false;
  let kindleActionToggleSeen = false;
  let mangaDexAtHomeCache = null;
  let mangaDexNavCache = null;
  const isTopWindow = !window.top || window.top === window;
  const scriptStartedAt = Date.now();

  const kindleMangaPage = isKindleMangaContext();
  if (!kindleMangaPage) {
    setupAdProtections();
  }
  if (kindleMangaPage) {
    setupKindleMangaHandler();
  }

  loadSettings().then(() => {
    if (kindleMangaPage) {
      setupKindleMangaHandler();
    }
  });

  if (kindleMangaPage) {
    window.addEventListener("pageshow", () => setupKindleMangaHandler(), { passive: true });
  } else if (isTopWindow) {
    scheduleActivatorRefresh(ACTIVATOR_INITIAL_DELAY_MS);
    observeEarlyMutations();
    window.addEventListener("pageshow", () => scheduleActivatorRefresh(ACTIVATOR_PAGESHOW_DELAY_MS), { passive: true });
  }

  if (typeof chrome !== "undefined" && chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.type !== "PMR_TOGGLE") {
        return false;
      }

      const toggle = isKindleMangaContext() ? toggleKindleMangaHandler : isTopWindow ? toggleReader : null;
      if (!toggle) {
        sendResponse({ active: false, ignoredFrame: true });
        return false;
      }
      Promise.resolve(toggle())
        .then(sendResponse)
        .catch((error) => {
          console.warn("Prettify Manga Reader toggle failed", error);
          sendResponse({ active: false, pages: 0, error: String(error?.message || error) });
        });
      return true;
    });
  }

  async function loadSettings() {
    try {
      const raw = window.localStorage?.getItem(STORAGE_KEY);
      const next = raw ? JSON.parse(raw) : null;
      if (next && typeof next === "object") {
        settings = {
          mode: MODES.includes(next.mode) ? next.mode : settings.mode,
          snap: typeof next.snap === "boolean" ? next.snap : settings.snap,
          night: isValidNightMode(next.night) ? next.night : settings.night,
          mangaModes: sanitizeMangaModePrefs(next.mangaModes)
        };
      }
    } catch (error) {
      console.warn("Prettify Manga Reader could not load settings", error);
    } finally {
      settingsLoaded = true;
    }
    return settings;
  }

  function saveSettings() {
    if (!settingsLoaded) {
      return;
    }
    try {
      window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (error) {
      console.warn("Prettify Manga Reader could not save settings", error);
    }
  }

  function sanitizeMangaModePrefs(value) {
    if (!value || typeof value !== "object") {
      return {};
    }

    const entries = Object.entries(value)
      .map(([key, entry]) => {
        const mode = typeof entry === "string" ? entry : entry?.mode;
        const updatedAt = Number(typeof entry === "object" ? entry.updatedAt : 0) || 0;
        if (!isValidMangaPreferenceKey(key) || !MODES.includes(mode)) {
          return null;
        }
        return [key, { mode, updatedAt }];
      })
      .filter(Boolean)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, MAX_MANGA_MODE_PREFS);

    return Object.fromEntries(entries);
  }

  function isValidMangaPreferenceKey(key) {
    return typeof key === "string" && key.length >= 8 && key.length <= 220 && !/^(?:https?:\/\/)?[^/]+\/?$/.test(key);
  }

  function readerModeForMangaKey(mangaKey, prefs = settings.mangaModes) {
    const entry = mangaKey && prefs?.[mangaKey];
    const mode = typeof entry === "string" ? entry : entry?.mode;
    return MODES.includes(mode) ? mode : DEFAULT_READER_MODE;
  }

  function withMangaModePreference(prefs, mangaKey, mode, now = Date.now()) {
    if (!isValidMangaPreferenceKey(mangaKey) || !MODES.includes(mode)) {
      return sanitizeMangaModePrefs(prefs);
    }
    return sanitizeMangaModePrefs({
      ...prefs,
      [mangaKey]: { mode, updatedAt: now }
    });
  }

  function rememberCurrentMangaMode() {
    if (!currentMangaKey) {
      return false;
    }
    settings.mangaModes = withMangaModePreference(settings.mangaModes, currentMangaKey, settings.mode);
    return true;
  }

  function isKindleMangaReaderPage(source = location) {
    const host = String(source?.hostname || source?.host || "").toLowerCase();
    const pathname = String(source?.pathname || "");
    return KINDLE_READER_HOST_RE.test(host) && KINDLE_MANGA_PATH_RE.test(pathname);
  }

  function isKindleMangaContext() {
    if (isKindleMangaReaderPage(location)) {
      return true;
    }

    if (isTopWindow) {
      return false;
    }

    try {
      if (isKindleMangaReaderPage(window.top.location)) {
        return true;
      }
    } catch (_error) {
      // Cross-origin frames cannot inspect top.location. Fall back to referrer.
    }

    const referrerUrl = safeUrl(document.referrer, location.href);
    return Boolean(referrerUrl && isKindleMangaReaderPage(referrerUrl));
  }

  async function toggleKindleMangaHandler() {
    await loadSettings();
    if (kindleHandlerActive) {
      if (!kindleActionToggleSeen && Date.now() - scriptStartedAt < 2_000) {
        kindleActionToggleSeen = true;
        setupKindleMangaHandler();
        return { active: true, kindle: true, night: settings.night };
      }
      kindleActionToggleSeen = true;
      teardownKindleMangaHandler();
      return { active: false, kindle: true, night: settings.night };
    }
    kindleActionToggleSeen = true;
    setupKindleMangaHandler();
    return { active: kindleHandlerActive, kindle: true, night: settings.night };
  }

  function setupKindleMangaHandler() {
    if (!isKindleMangaContext() || !document.documentElement) {
      return;
    }

    kindleHandlerActive = true;
    removeActivator();
    if (isTopWindow) {
      ensureKindleToolbar();
    }
    updateKindleNightUi();
    scheduleKindleSurfaceRefresh(0);

    document.addEventListener("keydown", handleKindleKeyDown, true);
    window.addEventListener("keydown", handleKindleKeyDown, true);
    window.addEventListener("message", handleKindleFrameMessage);
    window.addEventListener("resize", scheduleKindleSurfaceRefresh, { passive: true });

    if (!document.body) {
      window.setTimeout(() => {
        if (kindleHandlerActive) {
          setupKindleMangaHandler();
        }
      }, 120);
    } else if (!kindleMutationObserver) {
      kindleMutationObserver = new MutationObserver(() => scheduleKindleSurfaceRefresh());
      kindleMutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "srcset", "style"]
      });
    }
  }

  function teardownKindleMangaHandler() {
    kindleHandlerActive = false;
    window.clearTimeout(kindleSurfaceRefreshTimer);
    document.removeEventListener("keydown", handleKindleKeyDown, true);
    window.removeEventListener("keydown", handleKindleKeyDown, true);
    window.removeEventListener("message", handleKindleFrameMessage);
    window.removeEventListener("resize", scheduleKindleSurfaceRefresh);
    if (kindleMutationObserver) {
      kindleMutationObserver.disconnect();
      kindleMutationObserver = null;
    }
    removeKindleToolbar();
    document.documentElement?.classList.remove("pmr-kindle-handler-active", "pmr-kindle-night-1", "pmr-kindle-night-2", "pmr-kindle-night-3");
    document.querySelectorAll?.(".pmr-kindle-page-surface").forEach((element) => element.classList.remove("pmr-kindle-page-surface"));
  }

  function ensureKindleToolbar() {
    kindleToolbar = document.getElementById(KINDLE_TOOLBAR_ID);
    if (kindleToolbar) {
      return kindleToolbar;
    }

    kindleToolbar = document.createElement("div");
    kindleToolbar.id = KINDLE_TOOLBAR_ID;
    kindleToolbar.setAttribute("role", "toolbar");
    kindleToolbar.setAttribute("aria-label", "Kindle manga controls");
    kindleToolbar.innerHTML = [
      '<button class="pmr-button" type="button" data-pmr-kindle-action="prev" title="Previous page">‹</button>',
      '<button class="pmr-button" type="button" data-pmr-kindle-action="next" title="Next page">›</button>',
      '<button class="pmr-button" type="button" data-pmr-kindle-action="night" title="Cycle night filter strength">Night</button>'
    ].join("");
    kindleToolbar.addEventListener("click", handleKindleToolbarClick);
    document.documentElement.appendChild(kindleToolbar);
    return kindleToolbar;
  }

  function removeKindleToolbar() {
    const existing = document.getElementById(KINDLE_TOOLBAR_ID);
    if (existing) {
      existing.remove();
    }
    kindleToolbar = null;
  }

  function handleKindleToolbarClick(event) {
    if (!(event.target instanceof Element)) {
      return;
    }
    const button = event.target.closest("[data-pmr-kindle-action]");
    if (!button) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const action = button.getAttribute("data-pmr-kindle-action");
    if (action === "night") cycleKindleNightMode();
    if (action === "prev") navigateKindleByPlan({ action: "prev", nativeKey: "ArrowLeft", turnerSide: "left" });
    if (action === "next") navigateKindleByPlan({ action: "next", nativeKey: "ArrowRight", turnerSide: "right" });
  }

  function handleKindleKeyDown(event) {
    if (!isKindleMangaContext()) {
      teardownKindleMangaHandler();
      return;
    }

    if (!kindleHandlerActive || kindleForwardingKey || isKindleTextEntryTarget(event.target)) {
      return;
    }

    if (event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }

    const key = event.key;
    if (key === "n" || key === "N") {
      event.preventDefault();
      event.stopImmediatePropagation();
      cycleKindleNightMode();
      return;
    }

    const plan = kindleNavigationPlanFromKey(key, event.shiftKey);
    if (!plan) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    navigateKindleByPlan(plan);
  }

  function handleKindleFrameMessage(event) {
    const data = event.data;
    if (!data || data.type !== KINDLE_FRAME_MESSAGE_TYPE || !isKindleMangaContext()) {
      return;
    }
    if (isTopWindow || (event.source !== window.parent && event.source !== window.top)) {
      return;
    }
    if (data.command === "night") {
      settings.night = isValidNightMode(data.night) ? data.night : settings.night;
      updateKindleNightUi();
      scheduleKindleSurfaceRefresh(0);
      return;
    }

    if (data.command === "navigate" && isValidKindleNavigationPlan(data.plan)) {
      navigateKindleByPlan(data.plan, { broadcast: false });
    }
  }

  function kindleNavigationPlanFromKey(key, shiftKey = false) {
    const normalized = key === "Spacebar" ? " " : key;
    if (normalized === "Home") return { action: "start", nativeKey: "Home" };
    if (normalized === "End") return { action: "end", nativeKey: "End" };
    if (normalized === "PageDown") return { action: "next", nativeKey: "PageDown", wheelDirection: 1 };
    if (normalized === "PageUp") return { action: "prev", nativeKey: "PageUp", wheelDirection: -1 };
    if (normalized === "ArrowRight") return { action: "next", nativeKey: "ArrowRight", turnerSide: "right" };
    if (normalized === "ArrowDown") return { action: "next", nativeKey: "ArrowDown", wheelDirection: 1 };
    if (normalized === "ArrowLeft") return { action: "prev", nativeKey: "ArrowLeft", turnerSide: "left" };
    if (normalized === "ArrowUp") return { action: "prev", nativeKey: "ArrowUp", wheelDirection: -1 };
    if (normalized === " ") return shiftKey ? { action: "prev", nativeKey: " ", shiftKey: true, wheelDirection: -1 } : { action: "next", nativeKey: " ", wheelDirection: 1 };
    return null;
  }

  function isKindleTextEntryTarget(target) {
    if (!(target instanceof Element)) {
      return false;
    }
    if (target.isContentEditable || target.closest("[contenteditable='true'], [role='textbox']")) {
      return true;
    }
    const tag = target.tagName.toLowerCase();
    if (tag === "textarea" || tag === "select") {
      return true;
    }
    if (tag !== "input") {
      return false;
    }
    const type = String(target.getAttribute("type") || "text").toLowerCase();
    return ["", "text", "search", "email", "password", "tel", "url", "number"].includes(type);
  }

  function navigateKindleByPlan(plan, options = {}) {
    if (!isValidKindleNavigationPlan(plan)) {
      return false;
    }

    const shouldBroadcast = options.broadcast !== false && isTopWindow;
    if (shouldBroadcast) {
      broadcastKindleFrameCommand({ command: "navigate", plan });
    }

    if (plan.action === "next" || plan.action === "prev") {
      if (plan.wheelDirection) {
        dispatchKindleWheel(plan);
      }
      if (plan.turnerSide) {
        clickKindlePageTurner(plan) || clickKindlePageRegion(plan);
      }
    }

    const dispatched = dispatchKindleNavigationKey(plan);
    window.setTimeout(() => scrollKindleFallback(plan), 80);
    return dispatched;
  }

  function broadcastKindleFrameCommand(command) {
    let delivered = 0;
    Array.from(document.querySelectorAll("iframe")).forEach((frame) => {
      try {
        if (!frame.contentWindow) {
          return;
        }
        frame.contentWindow.postMessage({ type: KINDLE_FRAME_MESSAGE_TYPE, ...command }, "*");
        delivered += 1;
      } catch (_error) {
        // Cross-origin or sandboxed frames can reject access; ignore them.
      }
    });
    return delivered;
  }

  function isValidKindleNavigationPlan(plan) {
    if (!plan || typeof plan !== "object") {
      return false;
    }
    if (!["next", "prev", "start", "end"].includes(plan.action)) {
      return false;
    }
    if (plan.nativeKey !== undefined && typeof plan.nativeKey !== "string") {
      return false;
    }
    if (plan.turnerSide !== undefined && !["left", "right"].includes(plan.turnerSide)) {
      return false;
    }
    if (plan.wheelDirection !== undefined && plan.wheelDirection !== 1 && plan.wheelDirection !== -1) {
      return false;
    }
    if (plan.shiftKey !== undefined && typeof plan.shiftKey !== "boolean") {
      return false;
    }
    return true;
  }

  function clickKindlePageTurner(plan) {
    const selectors = kindleTurnerSelectors(plan);
    for (const selector of selectors) {
      const elements = Array.from(document.querySelectorAll(selector));
      for (const element of elements) {
        const target = closestKindleClickable(element);
        if (!isSafeKindleControl(target) || !isLikelyKindlePageTurner(target, plan) || !isVisibleElement(target)) {
          continue;
        }
        clickKindleElement(target);
        return true;
      }
    }
    return false;
  }

  function clickKindlePageRegion(plan) {
    const point = kindlePageRegionPoint(plan);
    const target = document.elementFromPoint?.(point.x, point.y);
    if (!(target instanceof Element) || target.closest(`#${KINDLE_TOOLBAR_ID}, #${ROOT_ID}, #${ACTIVATOR_ID}`)) {
      return false;
    }
    dispatchKindlePointerClick(target, point);
    return true;
  }

  function dispatchKindleWheel(plan) {
    const point = kindlePageRegionPoint({ action: plan.action });
    const target = document.elementFromPoint?.(point.x, point.y) || document.body || document.documentElement;
    if (!target || typeof target.dispatchEvent !== "function") {
      return false;
    }
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 900;
    target.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: point.x,
      clientY: point.y,
      deltaX: 0,
      deltaY: (plan.wheelDirection || 1) * Math.max(520, viewportHeight * 0.72),
      deltaMode: 0
    }));
    return true;
  }

  function kindlePageRegionPoint(plan) {
    const width = window.innerWidth || document.documentElement.clientWidth || 900;
    const height = window.innerHeight || document.documentElement.clientHeight || 900;
    const edgeOffset = Math.max(28, Math.min(96, width * 0.08));
    const x = plan.turnerSide === "left"
      ? edgeOffset
      : plan.turnerSide === "right"
        ? width - edgeOffset
        : Math.max(edgeOffset, Math.min(width - edgeOffset, width / 2));
    return { x, y: Math.max(40, Math.min(height - 40, height / 2)) };
  }

  function dispatchKindlePointerClick(target, point) {
    const pointerOptions = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: point.x,
      clientY: point.y,
      screenX: window.screenX + point.x,
      screenY: window.screenY + point.y,
      button: 0,
      buttons: 1,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true
    };
    const mouseOptions = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: point.x,
      clientY: point.y,
      screenX: window.screenX + point.x,
      screenY: window.screenY + point.y,
      button: 0,
      buttons: 1
    };

    if (typeof PointerEvent === "function") {
      target.dispatchEvent(new PointerEvent("pointerover", pointerOptions));
      target.dispatchEvent(new PointerEvent("pointermove", pointerOptions));
      target.dispatchEvent(new PointerEvent("pointerdown", pointerOptions));
    }
    target.dispatchEvent(new MouseEvent("mouseover", mouseOptions));
    target.dispatchEvent(new MouseEvent("mousemove", mouseOptions));
    target.dispatchEvent(new MouseEvent("mousedown", mouseOptions));
    target.dispatchEvent(new MouseEvent("mouseup", { ...mouseOptions, buttons: 0 }));
    if (typeof PointerEvent === "function") {
      target.dispatchEvent(new PointerEvent("pointerup", { ...pointerOptions, buttons: 0 }));
    }
    target.dispatchEvent(new MouseEvent("click", { ...mouseOptions, buttons: 0 }));
  }

  function kindleTurnerSelectors(plan) {
    const nextLabelSelectors = [
      "button[aria-label*='next' i]",
      "button[title*='next' i]",
      "button[data-testid*='next' i]",
      "[role='button'][aria-label*='next' i]",
      "[role='button'][title*='next' i]",
      "[onclick][aria-label*='next' i]",
      "button[aria-label*='次']",
      "button[title*='次']",
      "[role='button'][aria-label*='次']",
      "[onclick][aria-label*='次']"
    ];
    const prevLabelSelectors = [
      "button[aria-label*='previous' i]",
      "button[aria-label*='prev' i]",
      "button[title*='previous' i]",
      "button[title*='prev' i]",
      "button[data-testid*='previous' i]",
      "button[data-testid*='prev' i]",
      "[role='button'][aria-label*='previous' i]",
      "[role='button'][aria-label*='prev' i]",
      "[role='button'][title*='previous' i]",
      "[role='button'][title*='prev' i]",
      "[onclick][aria-label*='previous' i]",
      "[onclick][aria-label*='prev' i]",
      "button[aria-label*='前']",
      "button[title*='前']",
      "[role='button'][aria-label*='前']",
      "[onclick][aria-label*='前']"
    ];
    const rightSelectors = ["#sitbreaderrightpageturner", "[id*='rightpageturner' i]"];
    const leftSelectors = ["#sitbreaderleftpageturner", "[id*='leftpageturner' i]"];

    const sideSelectors = plan.turnerSide === "right" ? rightSelectors : plan.turnerSide === "left" ? leftSelectors : [];
    const actionSelectors = plan.action === "next" ? nextLabelSelectors : prevLabelSelectors;
    return [...sideSelectors, ...actionSelectors];
  }

  function closestKindleClickable(element) {
    if (!element?.closest) {
      return element;
    }
    return element.closest("button, [role='button'], a[href], [onclick], [tabindex]") || element;
  }

  function isSafeKindleControl(element) {
    if (!(element instanceof Element)) {
      return false;
    }
    if (element.closest(`#${KINDLE_TOOLBAR_ID}, #${ROOT_ID}, #${ACTIVATOR_ID}`)) {
      return false;
    }
    const href = element.getAttribute("href");
    if (!href) {
      return true;
    }
    const url = safeUrl(href, location.href);
    return !url || url.origin === location.origin;
  }

  function isLikelyKindlePageTurner(element, plan) {
    const signature = kindleElementSignature(element);
    if (/sitbreader(?:right|left)pageturner|page[-_\s]?turn|pageturner/.test(signature)) {
      return true;
    }
    if (/(?:next|prev|previous)\s+page|page\s+(?:next|prev|previous)|次.*ページ|前.*ページ/.test(signature)) {
      return true;
    }
    if (/reader|kindle|manga/.test(signature) && /next|prev|previous|left|right|次|前/.test(signature)) {
      return true;
    }

    const rect = element.getBoundingClientRect?.();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    if (!rect || viewportWidth <= 0) {
      return false;
    }
    if (plan.turnerSide === "right") {
      return rect.left >= viewportWidth * 0.55;
    }
    if (plan.turnerSide === "left") {
      return rect.right <= viewportWidth * 0.45;
    }
    return false;
  }

  function kindleElementSignature(element) {
    return [
      element.id,
      element.className,
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("title"),
      element.getAttribute?.("data-testid")
    ].join(" ").toLowerCase();
  }

  function clickKindleElement(element) {
    if (typeof element.click === "function") {
      element.click();
      return;
    }
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
  }

  function dispatchKindleNavigationKey(plan) {
    const key = plan.nativeKey || (plan.action === "next" ? "ArrowRight" : plan.action === "prev" ? "ArrowLeft" : plan.action === "start" ? "Home" : "End");
    const keyInfo = kindleKeyInfo(key);
    const targets = uniqueTargets([
      isSafeKindleEventTarget(document.activeElement) ? document.activeElement : null,
      document.body,
      document.documentElement,
      document,
      window
    ]);

    kindleForwardingKey = true;
    try {
      for (const type of ["keydown", "keyup"]) {
        for (const target of targets) {
          target.dispatchEvent(new KeyboardEvent(type, {
            key,
            code: keyInfo.code,
            keyCode: keyInfo.keyCode,
            which: keyInfo.keyCode,
            bubbles: true,
            cancelable: true,
            composed: true,
            shiftKey: Boolean(plan.shiftKey)
          }));
        }
      }
      return targets.length > 0;
    } finally {
      kindleForwardingKey = false;
    }
  }

  function isSafeKindleEventTarget(target) {
    return target && target !== document.body && target !== document.documentElement && !target.closest?.(`#${KINDLE_TOOLBAR_ID}`);
  }

  function kindleKeyInfo(key) {
    const keyMap = {
      " ": { code: "Space", keyCode: 32 },
      ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
      ArrowUp: { code: "ArrowUp", keyCode: 38 },
      ArrowRight: { code: "ArrowRight", keyCode: 39 },
      ArrowDown: { code: "ArrowDown", keyCode: 40 },
      PageUp: { code: "PageUp", keyCode: 33 },
      PageDown: { code: "PageDown", keyCode: 34 },
      End: { code: "End", keyCode: 35 },
      Home: { code: "Home", keyCode: 36 }
    };
    return keyMap[key] || { code: key, keyCode: 0 };
  }

  function uniqueTargets(targets) {
    return targets.filter((target, index) => target && targets.indexOf(target) === index && typeof target.dispatchEvent === "function");
  }

  function scrollKindleFallback(plan) {
    const scroller = findKindleScrollSurface();
    if (!scroller) {
      return;
    }

    const horizontal = scroller.scrollWidth > scroller.clientWidth + 8;
    const viewportWidth = scroller.clientWidth || window.innerWidth || document.documentElement.clientWidth || 900;
    const viewportHeight = scroller.clientHeight || window.innerHeight || document.documentElement.clientHeight || 900;

    if (plan.action === "start" || plan.action === "end") {
      const left = plan.action === "start" ? 0 : Math.max(0, scroller.scrollWidth - viewportWidth);
      const top = plan.action === "start" ? 0 : Math.max(0, scroller.scrollHeight - viewportHeight);
      scroller.scrollTo?.({ left, top, behavior: "smooth" });
      return;
    }

    const direction = plan.action === "next" ? 1 : -1;
    scroller.scrollBy?.({
      left: horizontal ? direction * viewportWidth * 0.9 : 0,
      top: horizontal ? 0 : direction * viewportHeight * 0.9,
      behavior: "smooth"
    });
  }

  function findKindleScrollSurface() {
    const containers = queryKindlePageContainers(document);
    for (const container of containers) {
      const scrollable = nearestScrollableElement(container);
      if (scrollable) {
        return scrollable;
      }
    }
    return document.scrollingElement || document.documentElement;
  }

  function nearestScrollableElement(element) {
    let current = element;
    while (current && current !== document.documentElement) {
      if (isScrollableElement(current)) {
        return current;
      }
      current = current.parentElement;
    }
    return isScrollableElement(document.documentElement) ? document.documentElement : null;
  }

  function isScrollableElement(element) {
    return Boolean(element && (element.scrollHeight > element.clientHeight + 8 || element.scrollWidth > element.clientWidth + 8));
  }

  function cycleKindleNightMode() {
    settings.night = (settings.night + 1) % (NIGHT_MODE_LEVELS + 1);
    saveSettings();
    updateKindleNightUi();
    scheduleKindleSurfaceRefresh(0);
    if (isTopWindow) {
      broadcastKindleFrameCommand({ command: "night", night: settings.night });
    }
    showToast(NIGHT_MODE_LABELS[settings.night]);
  }

  function updateKindleNightUi() {
    const root = document.documentElement;
    if (!root) {
      return;
    }
    root.classList.remove("pmr-kindle-night-1", "pmr-kindle-night-2", "pmr-kindle-night-3");
    root.classList.toggle("pmr-kindle-handler-active", kindleHandlerActive);
    if (settings.night > 0) {
      root.classList.add(`pmr-kindle-night-${settings.night}`);
    }
    const nightButton = kindleToolbar?.querySelector("[data-pmr-kindle-action='night']");
    if (nightButton) {
      nightButton.textContent = NIGHT_MODE_LABELS[settings.night];
    }
  }

  function scheduleKindleSurfaceRefresh(delay = KINDLE_SURFACE_REFRESH_DELAY_MS) {
    const refreshDelay = Number.isFinite(delay) ? delay : KINDLE_SURFACE_REFRESH_DELAY_MS;
    window.clearTimeout(kindleSurfaceRefreshTimer);
    kindleSurfaceRefreshTimer = window.setTimeout(refreshKindlePageSurfaces, refreshDelay);
  }

  function refreshKindlePageSurfaces() {
    if (!isKindleMangaContext()) {
      teardownKindleMangaHandler();
      return;
    }

    if (!kindleHandlerActive) {
      return;
    }

    const nextSurfaces = collectKindlePageSurfaces(document);
    document.querySelectorAll(".pmr-kindle-page-surface").forEach((element) => {
      if (!nextSurfaces.has(element)) {
        element.classList.remove("pmr-kindle-page-surface");
      }
    });
    nextSurfaces.forEach((element) => element.classList.add("pmr-kindle-page-surface"));
  }

  function collectKindlePageSurfaces(root = document) {
    const surfaces = new Set();
    const containers = queryKindlePageContainers(root);

    containers.forEach((container) => {
      const media = Array.from(container.querySelectorAll?.(KINDLE_PAGE_SURFACE_SELECTOR) || []).filter(isKindleFilterSurface);
      if (media.length > 0) {
        media.forEach((element) => surfaces.add(element));
      } else if (isKindleFilterSurface(container)) {
        surfaces.add(container);
      }
    });

    if (surfaces.size === 0) {
      Array.from(root.querySelectorAll?.("canvas, img, [role='img'], [style*='background-image']") || [])
        .filter(isLikelyLargeKindleSurface)
        .forEach((element) => surfaces.add(element));
    }

    return surfaces;
  }

  function queryKindlePageContainers(root = document) {
    const containers = [];
    const byId = root.getElementById?.("sitbreaderpagecontainer");
    if (byId) {
      containers.push(byId);
    }
    Array.from(root.querySelectorAll?.(KINDLE_PAGE_CONTAINER_SELECTOR) || []).forEach((element) => {
      if (!containers.includes(element)) {
        containers.push(element);
      }
    });
    return containers.filter((element) => element instanceof Element && !element.closest(`#${KINDLE_TOOLBAR_ID}, #${ROOT_ID}, #${ACTIVATOR_ID}`));
  }

  function isKindleFilterSurface(element) {
    if (!(element instanceof Element) || element.closest(`#${KINDLE_TOOLBAR_ID}, #${ROOT_ID}, #${ACTIVATOR_ID}`)) {
      return false;
    }
    const rect = element.getBoundingClientRect?.();
    if (rect && (rect.width <= 2 || rect.height <= 2)) {
      return false;
    }
    return true;
  }

  function isLikelyLargeKindleSurface(element) {
    if (!isKindleFilterSurface(element)) {
      return false;
    }
    const rect = element.getBoundingClientRect?.();
    if (!rect) {
      return false;
    }
    const minWidth = Math.min(360, Math.max(180, (window.innerWidth || 0) * 0.24));
    const minHeight = Math.min(360, Math.max(180, (window.innerHeight || 0) * 0.24));
    return rect.width >= minWidth && rect.height >= minHeight;
  }

  function isVisibleElement(element) {
    if (!(element instanceof Element)) {
      return false;
    }
    const rect = element.getBoundingClientRect?.();
    if (rect && (rect.width <= 1 || rect.height <= 1)) {
      return false;
    }
    const style = window.getComputedStyle?.(element);
    return !style || (style.display !== "none" && style.visibility !== "hidden" && style.pointerEvents !== "none");
  }

  async function toggleReader() {
    await loadSettings();
    if (active) {
      deactivateReader();
      return { active: false, pages: pages.length };
    }
    await activateReader();
    return { active, pages: pages.length };
  }

  async function activateReader(options = {}) {
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
    window.clearTimeout(activatorRefreshTimer);

    const readerData = await collectReaderData({ includeEmbedded: true });
    const detected = readerData.pages;
    if (detected.length < MIN_DETECTED_PAGES) {
      showToast(readerData.error || "No manga page sequence found on this page.");
      return;
    }

    pages = detected;
    chapterNav = readerData.chapterNav;
    currentMangaKey = readerData.mangaKey || "";
    settings.mode = readerModeForMangaKey(currentMangaKey);
    active = true;
    currentSpreadIndex = 0;
    removeActivator();
    removeReaderRoot();

    readerRoot = document.createElement("div");
    readerRoot.id = ROOT_ID;
    readerRoot.setAttribute("role", "dialog");
    readerRoot.setAttribute("aria-label", "Prettify Manga Reader");

    const toolbar = document.createElement("div");
    toolbar.className = "pmr-toolbar";
    toolbar.innerHTML = [
      '<button class="pmr-button" type="button" data-pmr-action="prev" title="Previous page/spread">‹</button>',
      '<span class="pmr-indicator" data-pmr-indicator>1 / 1</span>',
      '<button class="pmr-button" type="button" data-pmr-action="next" title="Next page/spread">›</button>',
      '<button class="pmr-button" type="button" data-pmr-action="mode" title="Cycle single/double/book modes">Mode</button>',
      '<button class="pmr-button" type="button" data-pmr-action="snap" title="Toggle scroll snap">Snap</button>',
      '<button class="pmr-button" type="button" data-pmr-action="night" title="Cycle night filter strength">Night</button>',
      '<button class="pmr-button" type="button" data-pmr-action="home" title="Back to your library (h)">⌂</button>',
      '<button class="pmr-button" type="button" data-pmr-action="help" title="Keyboard shortcuts">?</button>',
      '<button class="pmr-button pmr-button-primary" type="button" data-pmr-action="close" title="Turn reader off">Off</button>'
    ].join("");

    scrollEl = document.createElement("div");
    scrollEl.className = "pmr-scroll";
    scrollEl.setAttribute("tabindex", "-1");

    const help = document.createElement("div");
    help.className = "pmr-help-backdrop";
    help.innerHTML = helpDialogMarkup();

    readerRoot.append(toolbar, scrollEl, help);
    document.documentElement.appendChild(readerRoot);
    ensureHomeButton();
    document.documentElement.classList.add("pmr-reader-active");

    toolbar.addEventListener("click", handleToolbarClick);
    help.addEventListener("click", (event) => {
      if (event.target === help || event.target.closest("[data-pmr-action='help-close']")) {
        toggleHelp(false);
      }
    });
    scrollEl.addEventListener("scroll", handleReaderScroll, { passive: true });
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("resize", handleReaderResize, { passive: true });

    renderSpreads(readerData.targetPageIndex || 0);
    scrollEl.focus({ preventScroll: true });
    showToast(options.autoOpen
      ? `Reader reopened in ${MODE_LABELS[settings.mode]} mode.`
      : `Reader on: ${pages.length} pages detected.`);
  }

  function deactivateReader() {
    active = false;
    readerClosedByUser = true;
    window.clearTimeout(layoutRefreshTimer);
    window.clearTimeout(rasterNudgeTimer);
    window.removeEventListener("resize", handleReaderResize);
    chapterNav = null;
    currentMangaKey = "";
    document.removeEventListener("keydown", handleKeyDown, true);
    document.documentElement.classList.remove("pmr-reader-active");
    removeReaderRoot();
    scheduleActivatorRefresh(ACTIVATOR_AFTER_CLOSE_DELAY_MS);
  }

  function removeReaderRoot() {
    const existing = document.getElementById(ROOT_ID);
    if (existing) {
      existing.remove();
    }
    readerRoot = null;
    scrollEl = null;
  }

  function handleToolbarClick(event) {
    const button = event.target.closest("[data-pmr-action]");
    if (!button) {
      return;
    }
    const action = button.getAttribute("data-pmr-action");
    if (action === "prev") goToSpread(currentSpreadIndex - 1);
    if (action === "next") goToSpread(currentSpreadIndex + 1);
    if (action === "mode") cycleMode();
    if (action === "snap") toggleSnap();
    if (action === "night") cycleNightMode();
    if (action === "home") goHome();
    if (action === "help") toggleHelp();
    if (action === "close") deactivateReader();
  }

  function handleKeyDown(event) {
    if (!active || isEditableTarget(event.target)) {
      return;
    }

    const key = event.key;
    const helpOpen = readerRoot?.classList.contains("pmr-help-open");

    if (key === "Escape") {
      event.preventDefault();
      if (helpOpen) toggleHelp(false);
      else deactivateReader();
      return;
    }

    if (key === "?" || (key === "/" && event.shiftKey)) {
      event.preventDefault();
      toggleHelp();
      return;
    }

    if (helpOpen) {
      return;
    }

    const chapterDirection = chapterDirectionFromKey(key);
    if (chapterDirection) {
      event.preventDefault();
      navigateToChapter(chapterDirection);
      return;
    }

    if (key === "d" || key === "D") {
      event.preventDefault();
      cycleMode();
      return;
    }

    if (key === "s" || key === "S") {
      event.preventDefault();
      toggleSnap();
      return;
    }

    if (key === "n" || key === "N") {
      event.preventDefault();
      cycleNightMode();
      return;
    }

    if (key === "Home") {
      event.preventDefault();
      goToSpread(0);
      return;
    }

    if (key === "End") {
      event.preventDefault();
      goToSpread(spreads.length - 1);
      return;
    }

    const pageIntent = pageNavigationIntentFromKey(key, event.shiftKey, currentSpreadIndex, spreads);
    if (pageIntent) {
      event.preventDefault();
      if (pageIntent.type === "chapter") {
        navigateToChapter(pageIntent.direction);
      } else {
        goToSpread(currentSpreadIndex + pageIntent.delta);
      }
    }
  }

  function pageNavigationIntentFromKey(key, shiftKey = false, spreadIndex = currentSpreadIndex, spreadList = spreads, nav = chapterNav) {
    const direction = pageDirectionFromKey(key, shiftKey);
    if (!direction) {
      return null;
    }
    if (shouldNavigateChapterAtBoundary(direction, spreadIndex, spreadList, nav)) {
      return { type: "chapter", direction };
    }
    return { type: "spread", delta: direction === "next" ? 1 : -1 };
  }

  function pageDirectionFromKey(key, shiftKey = false) {
    if (key === "PageDown" || key === "ArrowDown" || key === "ArrowRight" || (key === " " && !shiftKey)) {
      return "next";
    }
    if (key === "PageUp" || key === "ArrowUp" || key === "ArrowLeft" || (key === " " && shiftKey)) {
      return "prev";
    }
    return "";
  }

  function shouldNavigateChapterAtBoundary(direction, spreadIndex = currentSpreadIndex, spreadList = spreads, nav = chapterNav) {
    if (!nav?.[direction]?.url) {
      return false;
    }
    if (direction === "prev") {
      return spreadIndex <= 0;
    }
    const lastReadingSpread = lastReadableSpreadIndex(spreadList);
    return lastReadingSpread >= 0 && spreadIndex >= lastReadingSpread;
  }

  function lastReadableSpreadIndex(spreadList = spreads) {
    for (let index = spreadList.length - 1; index >= 0; index -= 1) {
      if (spreadList[index]?.type !== "chapter-nav") {
        return index;
      }
    }
    return -1;
  }

  function chapterDirectionFromKey(key) {
    if (key === "Enter") {
      return "next";
    }
    if (key === "Backspace") {
      return "prev";
    }
    return "";
  }

  function navigateToChapter(direction) {
    const link = chapterNav?.[direction];
    if (!link?.url) {
      showToast(`No ${direction === "prev" ? "previous" : "next"} chapter detected.`);
      return false;
    }

    armChapterAutoOpen(link.url, direction);
    location.href = link.url;
    return true;
  }

  function isEditableTarget(target) {
    if (!(target instanceof Element)) {
      return false;
    }
    const tag = target.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable || target.closest("[contenteditable='true'], [role='textbox']");
  }

  function cycleMode() {
    const currentPage = spreads[currentSpreadIndex]?.pageIndexes?.[0] || 0;
    const nextIndex = (MODES.indexOf(settings.mode) + 1) % MODES.length;
    settings.mode = MODES[nextIndex];
    rememberCurrentMangaMode();
    saveSettings();
    renderSpreads(currentPage);
    showToast(`Mode: ${MODE_LABELS[settings.mode]}`);
  }

  function toggleSnap() {
    settings.snap = !settings.snap;
    saveSettings();
    updateRootClasses();
    updateToolbar();
    showToast(`Scroll snap ${settings.snap ? "on" : "off"}.`);
  }

  function cycleNightMode() {
    settings.night = (settings.night + 1) % (NIGHT_MODE_LEVELS + 1);
    saveSettings();
    updateRootClasses();
    updateToolbar();
    showToast(NIGHT_MODE_LABELS[settings.night]);
  }

  function isValidNightMode(value) {
    return Number.isInteger(value) && value >= 0 && value <= NIGHT_MODE_LEVELS;
  }

  function toggleHelp(force) {
    if (!readerRoot) {
      return;
    }
    const shouldOpen = typeof force === "boolean" ? force : !readerRoot.classList.contains("pmr-help-open");
    readerRoot.classList.toggle("pmr-help-open", shouldOpen);
  }

  function renderSpreads(targetPageIndex = 0) {
    if (!readerRoot || !scrollEl) {
      return;
    }
    spreads = buildSpreads(settings.mode, pages);
    scrollEl.replaceChildren();

    spreads.forEach((spread, spreadIndex) => {
      if (spread.type === "chapter-nav") {
        scrollEl.appendChild(createChapterNavSpread(spreadIndex));
        return;
      }

      const section = document.createElement("section");
      const isSingleton = spread.pageIndexes.length === 1;
      const isLandscape = isSingleton && isLandscapePage(pages[spread.pageIndexes[0]]);
      section.className = ["pmr-spread", isSingleton ? "pmr-singleton" : "", isLandscape ? "pmr-landscape" : ""].filter(Boolean).join(" ");
      section.dataset.spreadIndex = String(spreadIndex);
      section.dataset.pageStart = String(spread.pageIndexes[0] + 1);
      section.setAttribute("aria-label", spreadLabel(spread));

      visualPageIndexesForSpread(spread).forEach((pageIndex) => {
        const page = pages[pageIndex];
        const figure = document.createElement("figure");
        figure.className = "pmr-page";
        figure.dataset.pageIndex = String(pageIndex + 1);

        const image = document.createElement("img");
        image.src = page.url;
        image.alt = page.alt || `Manga page ${pageIndex + 1}`;
        image.decoding = "async";
        image.loading = spreadIndex <= 1 ? "eager" : "lazy";
        image.draggable = false;
        image.addEventListener("load", () => recordLoadedPageSize(pageIndex, image), { once: true });
        figure.appendChild(image);
        section.appendChild(figure);
      });

      scrollEl.appendChild(section);
    });

    updateRootClasses();
    const nextSpreadIndex = findSpreadForPage(targetPageIndex);
    markSpreadsNearTargetEager(nextSpreadIndex);
    currentSpreadIndex = nextSpreadIndex;
    updateToolbar();
    requestAnimationFrame(() => goToSpread(nextSpreadIndex, "auto"));
    scheduleRasterNudge(150);
  }

  function markSpreadsNearTargetEager(targetSpreadIndex) {
    if (!scrollEl) {
      return;
    }
    Array.from(scrollEl.children).forEach((section, spreadIndex) => {
      if (Math.abs(spreadIndex - targetSpreadIndex) > 1) {
        return;
      }
      section.querySelectorAll("img").forEach((image) => {
        image.loading = "eager";
      });
    });
  }

  function buildSpreads(mode, pageList) {
    const result = [];
    if (mode === "single") {
      pageList.forEach((_page, index) => result.push({ pageIndexes: [index] }));
      appendChapterNavSpread(result);
      return result;
    }

    let index = 0;
    if (mode === "book" && pageList.length > 0) {
      result.push({ pageIndexes: [0] });
      index = 1;
    }

    while (index < pageList.length) {
      if (isLandscapePage(pageList[index])) {
        result.push({ pageIndexes: [index] });
        index += 1;
        continue;
      }

      const pair = [index];
      if (index + 1 < pageList.length && !isLandscapePage(pageList[index + 1])) {
        pair.push(index + 1);
      }
      result.push({ pageIndexes: pair });
      index += pair.length;
    }

    appendChapterNavSpread(result);
    return result;
  }

  function visualPageIndexesForSpread(spread) {
    if (!spread || spread.type === "chapter-nav" || spread.pageIndexes.length <= 1) {
      return spread?.pageIndexes || [];
    }
    return [...spread.pageIndexes].reverse();
  }

  function appendChapterNavSpread(spreadList) {
    if (chapterNav?.prev || chapterNav?.next) {
      spreadList.push({ type: "chapter-nav", pageIndexes: [] });
    }
  }

  function createChapterNavSpread(spreadIndex) {
    const section = document.createElement("section");
    section.className = "pmr-spread pmr-chapter-nav-spread";
    section.dataset.spreadIndex = String(spreadIndex);
    section.setAttribute("aria-label", "Chapter navigation");

    const card = document.createElement("div");
    card.className = "pmr-chapter-nav-card";

    const heading = document.createElement("h2");
    heading.textContent = "End of chapter";

    const summary = document.createElement("p");
    summary.textContent = `${pages.length} page${pages.length === 1 ? "" : "s"} detected.`;

    const actions = document.createElement("div");
    actions.className = "pmr-chapter-nav-actions";

    if (chapterNav?.prev) {
      actions.appendChild(createChapterNavLink(chapterNav.prev, "prev", "‹ Previous chapter"));
    }
    if (chapterNav?.next) {
      actions.appendChild(createChapterNavLink(chapterNav.next, "next", "Next chapter ›"));
    }

    card.append(heading, summary, actions);
    section.appendChild(card);
    return section;
  }

  function createChapterNavLink(link, rel, fallbackText) {
    const anchor = document.createElement("a");
    anchor.className = `pmr-button pmr-chapter-link pmr-chapter-link-${rel}`;
    anchor.href = link.url;
    anchor.rel = rel;
    anchor.textContent = fallbackText;
    anchor.title = link.title || fallbackText;
    anchor.addEventListener("click", (event) => {
      if (shouldArmChapterAutoOpenClick(event)) {
        armChapterAutoOpen(link.url, rel);
      }
    });
    return anchor;
  }

  function shouldArmChapterAutoOpenClick(event) {
    return !event.defaultPrevented
      && event.button === 0
      && !event.metaKey
      && !event.ctrlKey
      && !event.shiftKey
      && !event.altKey;
  }

  function armChapterAutoOpen(targetUrl, direction = "next") {
    const intent = chapterAutoOpenIntentForTarget(targetUrl, direction);
    if (!intent) {
      return false;
    }
    try {
      window.sessionStorage?.setItem(CHAPTER_AUTO_OPEN_KEY, JSON.stringify(intent));
      return true;
    } catch (_error) {
      return false;
    }
  }

  function chapterAutoOpenIntentForTarget(targetUrl, direction = "next", now = Date.now(), sourceUrl = location.href) {
    const source = safeUrl(sourceUrl, location.href);
    const target = safeUrl(targetUrl, source?.href || location.href);
    if (!source || !target || target.origin !== source.origin || navigationUrlKey(target) === navigationUrlKey(source)) {
      return null;
    }
    return {
      targetUrl: target.href,
      fromUrl: source.href,
      direction: direction === "prev" ? "prev" : "next",
      mode: DEFAULT_READER_MODE,
      expiresAt: now + CHAPTER_AUTO_OPEN_TTL_MS
    };
  }

  function readChapterAutoOpenIntent(now = Date.now()) {
    let raw = "";
    try {
      raw = window.sessionStorage?.getItem(CHAPTER_AUTO_OPEN_KEY) || "";
    } catch (_error) {
      return null;
    }
    if (!raw) {
      return null;
    }

    try {
      const intent = JSON.parse(raw);
      if (!intent || typeof intent !== "object" || Number(intent.expiresAt) <= now) {
        clearChapterAutoOpenIntent();
        return null;
      }
      return intent;
    } catch (_error) {
      clearChapterAutoOpenIntent();
      return null;
    }
  }

  function shouldConsumeChapterAutoOpenIntent(intent, currentUrl = location.href, now = Date.now()) {
    if (!intent || typeof intent !== "object" || intent.mode !== DEFAULT_READER_MODE || Number(intent.expiresAt) <= now) {
      return false;
    }
    const current = safeUrl(currentUrl, location.href);
    const target = safeUrl(intent.targetUrl, current?.href || location.href);
    return Boolean(current && target && target.origin === current.origin && navigationUrlKey(target) === navigationUrlKey(current));
  }

  function consumeChapterAutoOpenIntentIfCurrent(intent = readChapterAutoOpenIntent()) {
    if (!shouldConsumeChapterAutoOpenIntent(intent)) {
      return false;
    }
    clearChapterAutoOpenIntent();
    return true;
  }

  function clearChapterAutoOpenIntent() {
    try {
      window.sessionStorage?.removeItem(CHAPTER_AUTO_OPEN_KEY);
    } catch (_error) {
      // Ignore storage failures; auto-open is best-effort only.
    }
  }

  function navigationUrlKey(url) {
    const mangaDexInfo = mangaDexChapterInfoFromUrl(url.href);
    if (mangaDexInfo) {
      return `${url.origin}/chapter/${mangaDexInfo.chapterId}${url.search}`;
    }
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.origin}${pathname}${url.search}`;
  }

  function isLandscapePage(page) {
    const width = Number(page?.width || 0);
    const height = Number(page?.height || 0);
    return width > 0 && height > 0 && width / height >= LANDSCAPE_SPREAD_RATIO;
  }

  function recordLoadedPageSize(pageIndex, image) {
    const page = pages[pageIndex];
    if (!page || !image.naturalWidth || !image.naturalHeight) {
      return;
    }

    const wasLandscape = isLandscapePage(page);
    page.width = image.naturalWidth;
    page.height = image.naturalHeight;

    const isLandscape = isLandscapePage(page);
    if (settings.mode !== "single" && wasLandscape !== isLandscape) {
      scheduleSpreadLayoutRefresh(pageIndex);
    }
  }

  function scheduleSpreadLayoutRefresh(pageIndex) {
    window.clearTimeout(layoutRefreshTimer);
    layoutRefreshTimer = window.setTimeout(() => {
      if (!active || !readerRoot || !scrollEl) {
        return;
      }
      const currentPage = spreads[currentSpreadIndex]?.pageIndexes?.[0] ?? pageIndex;
      renderSpreads(currentPage);
    }, LAYOUT_REFRESH_DELAY_MS);
  }

  function spreadLabel(spread) {
    if (spread.type === "chapter-nav") {
      return "Chapter navigation";
    }
    const labels = spread.pageIndexes.map((index) => index + 1);
    return labels.length === 1 ? `Page ${labels[0]}` : `Pages ${labels[0]} and ${labels[1]}`;
  }

  function findSpreadForPage(pageIndex) {
    const clampedPage = Math.max(0, Math.min(pageIndex, pages.length - 1));
    const exact = spreads.findIndex((spread) => spread.pageIndexes.includes(clampedPage));
    if (exact >= 0) {
      return exact;
    }
    return Math.max(0, Math.min(currentSpreadIndex, spreads.length - 1));
  }

  function goToSpread(index, behavior = "instant") {
    if (!scrollEl || spreads.length === 0) {
      return;
    }
    const next = Math.max(0, Math.min(index, spreads.length - 1));
    const child = scrollEl.children[next];
    if (!child) {
      return;
    }
    currentSpreadIndex = next;
    updateToolbar();
    scrollEl.scrollTo({ top: child.offsetTop, behavior });
    scheduleRasterNudge();
  }

  // WebKitGTK on NVIDIA stops rasterizing content that scrolls into
  // view inside the overlay at large window sizes — layout is correct,
  // images are loaded, the tiles just never paint. Any real style
  // invalidation forces the visible viewport to rasterize, so after
  // every scroll/resize we "nudge" the page images with an alternating,
  // imperceptible transform. Harmless on healthy renderers.
  function nudgeRasterization() {
    if (!active || !scrollEl) {
      return;
    }
    lastRasterNudgeAt = Date.now();
    rasterNudgeTick = !rasterNudgeTick;
    const transform = `translateZ(0) scale(${rasterNudgeTick ? "1.0001" : "1.0002"})`;
    // Only spreads near the viewport: invalidating every image in a
    // long chapter makes each nudge needlessly expensive.
    Array.from(scrollEl.children).forEach((section, spreadIndex) => {
      if (Math.abs(spreadIndex - currentSpreadIndex) > 2) {
        return;
      }
      section.querySelectorAll("img, .pmr-chapter-nav-card").forEach((el) => {
        el.style.transform = transform;
      });
    });
  }

  function scheduleRasterNudge(delay = 100) {
    window.clearTimeout(rasterNudgeTimer);
    rasterNudgeTimer = window.setTimeout(nudgeRasterization, delay);
  }

  function handleReaderResize() {
    if (active) {
      scheduleRasterNudge(150);
    }
  }

  function handleReaderScroll() {
    // Throttled leading nudge so continuous wheel scrolling keeps
    // painting, plus a trailing one for wherever the scroll settles.
    if (Date.now() - lastRasterNudgeAt > 120) {
      nudgeRasterization();
    }
    scheduleRasterNudge();
    if (scrollRaf) {
      return;
    }
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      if (!scrollEl) {
        return;
      }

      let closestIndex = currentSpreadIndex;
      let closestDistance = Infinity;
      Array.from(scrollEl.children).forEach((child, index) => {
        const distance = Math.abs(child.offsetTop - scrollEl.scrollTop);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestIndex = index;
        }
      });

      if (closestIndex !== currentSpreadIndex) {
        currentSpreadIndex = closestIndex;
        updateToolbar();
      }
    });
  }

  function updateRootClasses() {
    if (!readerRoot) {
      return;
    }
    readerRoot.classList.remove("pmr-mode-single", "pmr-mode-double", "pmr-mode-book", "pmr-snap-off", "pmr-night-1", "pmr-night-2", "pmr-night-3");
    readerRoot.classList.add(`pmr-mode-${settings.mode}`);
    if (!settings.snap) {
      readerRoot.classList.add("pmr-snap-off");
    }
    if (settings.night > 0) {
      readerRoot.classList.add(`pmr-night-${settings.night}`);
    }
  }

  function updateToolbar() {
    if (!readerRoot) {
      return;
    }
    const spread = spreads[currentSpreadIndex] || { pageIndexes: [0] };
    const pageNumbers = spread.pageIndexes.map((index) => index + 1);
    const label = spread.type === "chapter-nav"
      ? "End"
      : pageNumbers.length === 1
        ? String(pageNumbers[0])
        : `${pageNumbers[0]}–${pageNumbers[1]}`;
    const indicator = readerRoot.querySelector("[data-pmr-indicator]");
    const modeButton = readerRoot.querySelector("[data-pmr-action='mode']");
    const snapButton = readerRoot.querySelector("[data-pmr-action='snap']");
    const nightButton = readerRoot.querySelector("[data-pmr-action='night']");
    if (indicator) indicator.textContent = `${label} / ${pages.length}`;
    if (modeButton) modeButton.textContent = MODE_LABELS[settings.mode];
    if (snapButton) snapButton.textContent = `Snap ${settings.snap ? "On" : "Off"}`;
    if (nightButton) nightButton.textContent = NIGHT_MODE_LABELS[settings.night];
  }

  function detectChapterNav() {
    const currentInfo = getCurrentChapterInfo();
    const best = { prev: null, next: null };
    const elements = document.querySelectorAll("a[href], link[href][rel~='prev'], link[href][rel~='next']");

    elements.forEach((element) => {
      if (element.closest?.(`#${ROOT_ID}, #${ACTIVATOR_ID}`)) {
        return;
      }

      const candidate = scoreChapterNavElement(element, currentInfo);
      if (!candidate) {
        return;
      }

      const existing = best[candidate.direction];
      if (!existing || candidate.score > existing.score) {
        best[candidate.direction] = candidate;
      }
    });

    const result = {};
    if (best.prev) {
      result.prev = chapterNavLink(best.prev);
    }
    if (best.next) {
      result.next = chapterNavLink(best.next);
    }
    return result.prev || result.next ? result : null;
  }

  function scoreChapterNavElement(element, currentInfo) {
    const rawHref = element.getAttribute("href");
    const url = safeUrl(rawHref, location.href);
    if (!url || !/^https?:$/i.test(url.protocol) || url.origin !== location.origin) {
      return null;
    }
    if (isSameDocumentUrl(url) || /\.(?:jpe?g|png|webp|avif|gif|svg|css|js)(?:$|\?)/i.test(url.pathname)) {
      return null;
    }

    const text = chapterNavText(element);
    const rel = String(element.getAttribute("rel") || "").toLowerCase();
    if (isBadChapterNavLink(url, text, rel)) {
      return null;
    }

    const targetInfo = chapterInfoFromUrl(url.href);
    const chapterLike = looksChapterLikeNavTarget(url, text, currentInfo, targetInfo);
    if (!chapterLike) {
      return null;
    }

    const navish = isNavishElement(element);
    const nearChapterSelect = hasNearbyChapterSelect(element);
    const scopeText = `${text} ${ancestorNavText(element)}`.toLowerCase();
    const elementHtml = element.outerHTML ? element.outerHTML.slice(0, CHAPTER_NAV_HTML_SAMPLE_CHARS).toLowerCase() : "";
    const scores = { prev: 0, next: 0 };

    if (/\bprev(?:ious)?\b/.test(rel)) scores.prev += CHAPTER_NAV_REL_SCORE;
    if (/\bnext\b/.test(rel)) scores.next += CHAPTER_NAV_REL_SCORE;

    if (/\b(prev(?:ious)?|back|older)\b(?:\s*(?:chapter|chap|ch|episode|ep))?|\b(?:chapter|chap|ch|episode|ep)\s*(?:prev(?:ious)?|back)\b/i.test(text)) {
      scores.prev += CHAPTER_NAV_TEXT_SCORE;
    }
    if (/\b(next|newer)\b(?:\s*(?:chapter|chap|ch|episode|ep))?|\b(?:chapter|chap|ch|episode|ep)\s*next\b/i.test(text)) {
      scores.next += CHAPTER_NAV_TEXT_SCORE;
    }

    if (/nav-previous|\bprevious\b|\bprev\b|pagination-prev|chevron-left|arrow-left/.test(scopeText)) scores.prev += CHAPTER_NAV_SCOPE_SIGNAL_SCORE;
    if (/nav-next|\bnext\b|pagination-next|chevron-right|arrow-right/.test(scopeText)) scores.next += CHAPTER_NAV_SCOPE_SIGNAL_SCORE;
    if (/chevron-left|arrow-left|lucide-chevron-left|lucide-arrow-left/.test(elementHtml)) scores.prev += nearChapterSelect || navish ? CHAPTER_NAV_ICON_CONTEXT_SCORE : CHAPTER_NAV_ICON_WEAK_SCORE;
    if (/chevron-right|arrow-right|lucide-chevron-right|lucide-arrow-right/.test(elementHtml)) scores.next += nearChapterSelect || navish ? CHAPTER_NAV_ICON_CONTEXT_SCORE : CHAPTER_NAV_ICON_WEAK_SCORE;

    if (currentInfo && targetInfo && currentInfo.family === targetInfo.family && targetInfo.number !== currentInfo.number) {
      const delta = targetInfo.number - currentInfo.number;
      const absDelta = Math.abs(delta);
      const deltaScore = absDelta <= 3 ? 55 : absDelta <= 10 ? 35 : 15;
      const numericDirection = delta > 0 ? "next" : "prev";
      const opposingDirection = delta > 0 ? "prev" : "next";
      if (delta < 0) scores.prev += navish || nearChapterSelect ? deltaScore : 15;
      if (delta > 0) scores.next += navish || nearChapterSelect ? deltaScore : 15;

      if (delta < 0) scores.next -= CHAPTER_NAV_WRONG_DIRECTION_PENALTY;
      if (delta > 0) scores.prev -= CHAPTER_NAV_WRONG_DIRECTION_PENALTY;

      if (currentInfo.explicit && targetInfo.explicit && absDelta <= 10 && (navish || nearChapterSelect || /\b(prev(?:ious)?|next)\b/i.test(`${rel} ${text} ${scopeText}`))) {
        scores[numericDirection] += CHAPTER_NAV_NUMERIC_DIRECTION_OVERRIDE_SCORE;
        scores[opposingDirection] -= CHAPTER_NAV_NUMERIC_DIRECTION_OVERRIDE_SCORE;
      }
    }

    const direction = scores.next > scores.prev ? "next" : "prev";
    const score = scores[direction];
    const highConfidence = score >= CHAPTER_NAV_HIGH_CONFIDENCE;
    const contextualConfidence = (navish || nearChapterSelect) && score >= CHAPTER_NAV_CONTEXT_CONFIDENCE;
    if (!highConfidence && !contextualConfidence) {
      return null;
    }

    return {
      direction,
      score,
      url: url.href,
      title: readableChapterNavTitle(element, url, direction)
    };
  }

  function chapterNavLink(candidate) {
    return {
      url: candidate.url,
      title: candidate.title,
      score: candidate.score
    };
  }

  function chapterNavText(element) {
    return normalizeWhitespace([
      element.textContent || "",
      element.getAttribute("aria-label") || "",
      element.getAttribute("title") || "",
      element.getAttribute("data-title") || ""
    ].join(" "));
  }

  function ancestorNavText(element) {
    const ancestor = element.closest?.(".nav-previous, .nav-next, .navigation, .post-navigation, .nav-links, .pagination, nav, [role='navigation'], [class*='chapter' i], [id*='chapter' i]");
    if (!ancestor) {
      return "";
    }
    return normalizeWhitespace([
      ancestor.id || "",
      ancestor.className || "",
      ancestor.getAttribute?.("aria-label") || ""
    ].join(" "));
  }

  function isBadChapterNavLink(url, text, rel) {
    const haystack = `${decodeURIComponentSafe(url.href)} ${text}`.toLowerCase();
    if (/\bsponsored\b/.test(rel) && !/\b(prev(?:ious)?|next)\b/i.test(text)) {
      return true;
    }
    if (/\b(fill survey|earn\s*\$?\d+|advertisement|advertise|affiliate|sponsored|comments?|reply|login|register|privacy|terms|contact|about|latest chapters?|share|facebook|twitter|x\.com|pinterest|discord|rss|feed)\b/i.test(haystack)) {
      return true;
    }
    if (/\/(?:feed|comments|wp-json|tag|category|author|search|oembed)(?:\/|$)|[?&](?:replytocom|share)=/i.test(url.href)) {
      return true;
    }
    return false;
  }

  function looksChapterLikeNavTarget(url, text, currentInfo, targetInfo) {
    if (targetInfo) {
      return targetInfo.explicit
        || /\b(chapter|chap|ch\.?|episode|ep\.?|manga|comic|read)\b/i.test(`${url.pathname} ${text}`)
        || Boolean(currentInfo && currentInfo.family === targetInfo.family);
    }
    if (/\b(chapter|chap|ch\.?|episode|ep\.?|manga|comic|read)\b/i.test(`${url.pathname} ${text}`)) {
      return true;
    }
    return false;
  }

  function isNavishElement(element) {
    return Boolean(element.closest?.("nav, [role='navigation'], .navigation, .post-navigation, .nav-links, .pagination, [class*='chapter' i], [id*='chapter' i], [class*='pager' i], [id*='pager' i]"));
  }

  function hasNearbyChapterSelect(element) {
    let node = element;
    for (let depth = 0; node && depth < 5; depth += 1) {
      if (node.querySelector?.("select option[selected], select option:checked")) {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  function readableChapterNavTitle(element, url, direction) {
    const text = chapterNavText(element);
    if (text && text.length <= READABLE_TITLE_MAX_CHARS && /[a-z0-9]/i.test(text)) {
      return text;
    }
    const info = chapterInfoFromUrl(url.href);
    if (info) {
      return `${direction === "prev" ? "Previous" : "Next"} chapter ${info.number}`;
    }
    return `${direction === "prev" ? "Previous" : "Next"} chapter`;
  }

  function getCurrentChapterInfo() {
    return chapterInfoFromUrl(location.href) || chapterInfoFromText(document.title, location.href);
  }

  function chapterInfoFromUrl(urlValue) {
    const url = safeUrl(urlValue, location.href);
    if (!url) {
      return null;
    }
    return chapterInfoFromText(decodeURIComponentSafe(url.pathname), url.href);
  }

  function chapterInfoFromText(text, familySource = text) {
    const normalized = String(text || "").toLowerCase();
    let match = normalized.match(/(?:chapter|chap|ch|episode|ep)[-_\s\/]*([0-9]+)(?:(?:[._-]([0-9]+))|(?:[._-]?([a-z]))(?=$|[^a-z0-9]))?/i);
    let explicit = Boolean(match);
    let number = chapterNumberFromMatch(match);
    if (!match) {
      if (/(?:^|\/)page\/\d+(?:\/|$)/i.test(normalized)) {
        return null;
      }
      match = normalized.match(/(?:^|[-_\/\s])([0-9]{1,5})(?:\/?$|[-_\/\s])/i);
      number = match ? Number(match[1]) : NaN;
    }
    if (!match) {
      return null;
    }

    if (!Number.isFinite(number)) {
      return null;
    }
    const family = String(familySource || text)
      .toLowerCase()
      .replace(/(?:chapter|chap|ch|episode|ep)[-_\s\/]*[0-9]+(?:(?:[._-][0-9]+)|(?:[._-]?[a-z])(?=$|[^a-z0-9]))?/i, "chapter-#")
      .replace(/([\/_-])[0-9]{1,5}(?=\/?$|[\/_-])/i, "$1#")
      .replace(/\/+$/, "");
    return { number, family, explicit };
  }

  function chapterNumberFromMatch(match) {
    if (!match) {
      return NaN;
    }
    const base = Number(match[1]);
    if (!Number.isFinite(base)) {
      return NaN;
    }
    if (match[2]) {
      return Number(`${match[1]}.${match[2]}`);
    }
    if (match[3]) {
      return base + (match[3].charCodeAt(0) - 96) / 100;
    }
    return base;
  }

  function isExplicitChapterUrl(urlValue = location.href) {
    const info = chapterInfoFromUrl(urlValue);
    return Boolean(info && info.explicit);
  }

  function isSameDocumentUrl(url) {
    const current = safeUrl(location.href);
    if (!current) {
      return false;
    }
    return url.origin === current.origin && url.pathname === current.pathname && url.search === current.search;
  }

  function normalizeWhitespace(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  async function collectReaderData(options = {}) {
    if (isMangaDexReaderPage()) {
      return collectMangaDexReaderData();
    }
    const pageList = collectMangaPages(options);
    return {
      pages: pageList,
      chapterNav: pageList.length >= MIN_DETECTED_PAGES ? detectChapterNav() : null,
      targetPageIndex: 0,
      mangaKey: genericMangaPreferenceKey(),
      source: "generic"
    };
  }

  function isMangaDexReaderPage(source = location) {
    const url = safeUrl(source?.href || source, location.href);
    return Boolean(url && url.hostname.toLowerCase() === MANGADEX_HOST && MANGADEX_CHAPTER_PATH_RE.test(url.pathname));
  }

  function mangaDexChapterInfoFromUrl(urlValue = location.href) {
    const url = safeUrl(urlValue, location.href);
    if (!url || url.hostname.toLowerCase() !== MANGADEX_HOST) {
      return null;
    }
    const match = url.pathname.match(MANGADEX_CHAPTER_PATH_RE);
    if (!match) {
      return null;
    }
    const pageNumber = Math.max(1, Number.parseInt(match[2] || "1", 10) || 1);
    return { chapterId: match[1].toLowerCase(), pageNumber };
  }

  function mangaDexMangaKeyFromTitleUrl(urlValue) {
    const url = safeUrl(urlValue, location.href);
    if (!url || url.hostname.toLowerCase() !== MANGADEX_HOST) {
      return "";
    }
    const match = url.pathname.match(/^\/title\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i);
    return match ? `mangadex:title:${match[1].toLowerCase()}` : "";
  }

  function detectMangaDexMangaPreferenceKey() {
    const scoped = document.querySelector?.(".reader--header-manga[href*='/title/'], .md--reader-wrap a[href*='/title/'], .reader--menu a[href*='/title/']");
    const scopedKey = scoped ? mangaDexMangaKeyFromTitleUrl(scoped.href || scoped.getAttribute("href")) : "";
    if (scopedKey) {
      return scopedKey;
    }

    for (const anchor of document.querySelectorAll?.("a[href*='/title/']") || []) {
      const key = mangaDexMangaKeyFromTitleUrl(anchor.href || anchor.getAttribute("href"));
      if (key) {
        return key;
      }
    }
    return "";
  }

  function genericMangaPreferenceKey(urlValue = location.href, title = document.title) {
    const url = safeUrl(urlValue, location.href);
    if (!url || url.hostname.toLowerCase() === MANGADEX_HOST) {
      return "";
    }

    const source = `${url.origin}${url.pathname.replace(/\/+$/, "") || "/"}`;
    const pathInfo = chapterInfoFromText(decodeURIComponentSafe(url.pathname), source);
    if (pathInfo?.family && pathInfo.family.includes("#")) {
      return `generic:path:${pathInfo.family}`;
    }

    const titleSlug = mangaTitlePreferenceSlug(title);
    if (titleSlug) {
      return `generic:title:${url.origin}:${titleSlug}`;
    }

    if (pathInfo?.family && pathInfo.family !== url.origin && pathInfo.family !== `${url.origin}/`) {
      return `generic:path:${pathInfo.family}`;
    }
    return "";
  }

  function mangaTitlePreferenceSlug(value) {
    const cleaned = normalizeWhitespace(value)
      .toLowerCase()
      .replace(/\b(?:chapter|chap|ch|episode|ep|volume|vol)\.?\s*[-_:#]*\s*\d+(?:[._-]\d+)?\b/gi, " ")
      .replace(/\b\d+(?:[._-]\d+)?\b\s*(?:[-:|–—]\s*)?$/g, " ")
      .replace(/\s*[-:|–—]\s*$/g, " ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 90);
    return cleaned.length >= 3 ? cleaned : "";
  }

  async function collectMangaDexReaderData() {
    const info = mangaDexChapterInfoFromUrl();
    if (!info) {
      return { pages: [], chapterNav: null, targetPageIndex: 0, source: "mangadex" };
    }

    try {
      const atHome = await fetchMangaDexAtHomeData(info.chapterId);
      const pageList = mangaDexPagesFromAtHomeData(atHome);
      // The extension scrapes MangaDex's reader-menu anchors, but in
      // this app the SPA reader menu is never opened — fall back to the
      // public API for prev/next when the DOM has nothing.
      const chapterNav = detectMangaDexChapterNav(info.chapterId)
        || await fetchMangaDexChapterNavFromApi(info.chapterId);
      return {
        pages: pageList,
        chapterNav,
        targetPageIndex: Math.max(0, Math.min(info.pageNumber - 1, pageList.length - 1)),
        mangaKey: detectMangaDexMangaPreferenceKey(),
        source: "mangadex"
      };
    } catch (error) {
      console.warn("Prettify Manga Reader could not load MangaDex pages", error);
      return {
        pages: [],
        chapterNav: null,
        targetPageIndex: 0,
        source: "mangadex",
        error: "Could not load MangaDex chapter pages."
      };
    }
  }

  async function fetchMangaDexAtHomeData(chapterId, now = Date.now()) {
    if (mangaDexAtHomeCache
      && mangaDexAtHomeCache.chapterId === chapterId
      && now - mangaDexAtHomeCache.createdAt < MANGADEX_AT_HOME_CACHE_MS) {
      return mangaDexAtHomeCache.promise;
    }

    const promise = fetch(`${MANGADEX_AT_HOME_API_BASE}${encodeURIComponent(chapterId)}`, {
      credentials: "omit",
      headers: { Accept: "application/json" }
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`MangaDex at-home request failed: ${response.status}`);
      }
      return response.json();
    }).catch((error) => {
      if (mangaDexAtHomeCache?.chapterId === chapterId && mangaDexAtHomeCache.promise === promise) {
        mangaDexAtHomeCache = null;
      }
      throw error;
    });

    mangaDexAtHomeCache = { chapterId, createdAt: now, promise };
    return promise;
  }

  function mangaDexPagesFromAtHomeData(atHomeData) {
    const baseUrl = String(atHomeData?.baseUrl || "").replace(/\/+$/, "");
    const hash = String(atHomeData?.chapter?.hash || "");
    const files = Array.isArray(atHomeData?.chapter?.data) ? atHomeData.chapter.data : [];
    if (!baseUrl || !hash || files.length === 0) {
      return [];
    }

    return files.map((filename, index) => ({
      url: `${baseUrl}/data/${encodeURIComponent(hash)}/${encodeURIComponent(String(filename))}`,
      pageNumber: index + 1,
      width: 0,
      height: 0,
      alt: `MangaDex page ${index + 1}`,
      score: 100
    }));
  }

  async function fetchMangaDexChapterNavFromApi(chapterId) {
    if (mangaDexNavCache?.chapterId === chapterId) {
      return mangaDexNavCache.nav;
    }
    let nav = null;
    try {
      const chapterResp = await fetch(`https://api.mangadex.org/chapter/${encodeURIComponent(chapterId)}`, {
        credentials: "omit",
        headers: { Accept: "application/json" }
      });
      if (!chapterResp.ok) {
        return null;
      }
      const chapterData = await chapterResp.json();
      const attributes = chapterData?.data?.attributes || {};
      const language = attributes.translatedLanguage || "en";
      const mangaId = (chapterData?.data?.relationships || []).find((rel) => rel?.type === "manga")?.id;
      const currentNumber = Number.parseFloat(attributes.chapter);
      if (!mangaId || !Number.isFinite(currentNumber)) {
        return null;
      }

      const chapters = [];
      let offset = 0;
      let total = Infinity;
      for (let page = 0; page < 8 && offset < total; page += 1) {
        const feedResp = await fetch(
          `https://api.mangadex.org/manga/${encodeURIComponent(mangaId)}/feed`
            + `?translatedLanguage%5B%5D=${encodeURIComponent(language)}`
            + `&order%5Bchapter%5D=asc&limit=500&offset=${offset}`,
          { credentials: "omit", headers: { Accept: "application/json" } }
        );
        if (!feedResp.ok) {
          break;
        }
        const feed = await feedResp.json();
        const entries = Array.isArray(feed?.data) ? feed.data : [];
        entries.forEach((entry) => {
          const number = Number.parseFloat(entry?.attributes?.chapter);
          if (Number.isFinite(number) && !entry?.attributes?.externalUrl && entry?.id) {
            chapters.push({ number, id: entry.id });
          }
        });
        total = Number(feed?.total) || 0;
        offset += entries.length;
        if (entries.length === 0) {
          break;
        }
      }

      nav = mangaDexNavFromChapterList(chapters, currentNumber, location.origin);
    } catch (error) {
      console.warn("Prettify Manga Reader could not load MangaDex chapter nav", error);
      nav = null;
    }
    mangaDexNavCache = { chapterId, nav };
    return nav;
  }

  function mangaDexNavFromChapterList(chapters, currentNumber, origin = "https://mangadex.org") {
    const seen = new Set();
    const unique = [...chapters]
      .sort((a, b) => a.number - b.number)
      .filter((chapter) => {
        if (seen.has(chapter.number)) {
          return false;
        }
        seen.add(chapter.number);
        return true;
      });

    const prev = [...unique].reverse().find((chapter) => chapter.number < currentNumber);
    const next = unique.find((chapter) => chapter.number > currentNumber);
    const result = {};
    if (prev) {
      result.prev = { url: `${origin}/chapter/${prev.id}`, title: `Previous chapter ${prev.number}`, score: 120 };
    }
    if (next) {
      result.next = { url: `${origin}/chapter/${next.id}`, title: `Next chapter ${next.number}`, score: 120 };
    }
    return result.prev || result.next ? result : null;
  }

  function detectMangaDexChapterNav(currentChapterId) {
    const anchors = uniqueMangaDexChapterAnchors(currentChapterId);
    if (anchors.length === 0) {
      return null;
    }

    const sorted = sortMangaDexChapterAnchors(anchors);
    const result = {};
    if (sorted.length >= 2) {
      result.prev = mangaDexChapterNavLink(sorted[0].url, "prev");
      result.next = mangaDexChapterNavLink(sorted[sorted.length - 1].url, "next");
    } else {
      const direction = mangaDexSingleChapterAnchorDirection(sorted[0].element);
      result[direction] = mangaDexChapterNavLink(sorted[0].url, direction);
    }
    return result.prev || result.next ? result : null;
  }

  function uniqueMangaDexChapterAnchors(currentChapterId) {
    const byChapter = new Map();
    document.querySelectorAll(".md--reader-menu a[href*='/chapter/'], .reader--menu a[href*='/chapter/'], .md--reader-wrap a[href*='/chapter/']").forEach((anchor) => {
      const info = mangaDexChapterInfoFromUrl(anchor.href || anchor.getAttribute("href"));
      if (!info || info.chapterId === currentChapterId) {
        return;
      }
      if (!byChapter.has(info.chapterId)) {
        byChapter.set(info.chapterId, { element: anchor, url: chapterUrlWithoutMangaDexPage(anchor.href) });
      }
    });
    return Array.from(byChapter.values());
  }

  function sortMangaDexChapterAnchors(anchors) {
    return [...anchors].sort((a, b) => {
      const aRect = a.element.getBoundingClientRect?.();
      const bRect = b.element.getBoundingClientRect?.();
      if (aRect && bRect && aRect.left !== bRect.left) {
        return aRect.left - bRect.left;
      }
      return documentOrderCompare(a.element, b.element);
    });
  }

  function mangaDexSingleChapterAnchorDirection(anchor) {
    const rect = anchor.getBoundingClientRect?.();
    const parentRect = anchor.parentElement?.getBoundingClientRect?.();
    if (rect && parentRect && rect.width > 0 && parentRect.width > 0) {
      return rect.left + rect.width / 2 >= parentRect.left + parentRect.width / 2 ? "next" : "prev";
    }
    return "next";
  }

  function mangaDexChapterNavLink(url, direction) {
    return {
      url,
      title: direction === "prev" ? "Previous MangaDex chapter" : "Next MangaDex chapter",
      score: 120
    };
  }

  function documentOrderCompare(a, b) {
    if (a === b) {
      return 0;
    }
    return a.compareDocumentPosition?.(b) & 4 ? -1 : 1;
  }

  function chapterUrlWithoutMangaDexPage(urlValue) {
    const info = mangaDexChapterInfoFromUrl(urlValue);
    const url = safeUrl(urlValue, location.href);
    if (!info || !url) {
      return urlValue;
    }
    return `${url.origin}/chapter/${info.chapterId}${url.search}`;
  }

  function collectMangaPages(options = {}) {
    const candidates = collectCandidates(options);
    if (candidates.length === 0) {
      return [];
    }
    scoreCandidates(candidates);
    const selected = selectBestSequence(candidates);

    return selected
      .sort(compareCandidates)
      .map((candidate, index) => ({
        url: candidate.url,
        pageNumber: candidate.numeric?.page || index + 1,
        width: candidate.width,
        height: candidate.height,
        alt: candidate.alt || `Manga page ${index + 1}`,
        score: candidate.finalScore
      }));
  }

  function collectCandidates(options = {}) {
    const byKey = new Map();
    let sourceIndex = 0;

    const upsert = (rawUrl, context = {}) => {
      const url = toAbsoluteImageUrl(rawUrl, context);
      if (!url) {
        return;
      }
      const key = logicalImageKey(url);
      const existing = byKey.get(key);
      const dims = context.element ? getElementDimensions(context.element) : {};
      const next = existing || {
        key,
        url,
        sourceKinds: new Set(),
        sourceIndex: context.sourceIndex ?? sourceIndex++,
        domIndex: Number.MAX_SAFE_INTEGER,
        width: 0,
        height: 0,
        alt: "",
        title: "",
        containerKey: "",
        element: null,
        score: 0,
        finalScore: 0,
        groupKey: "",
        numeric: null
      };

      if (imageUrlQuality(url) > imageUrlQuality(next.url)) {
        next.url = url;
      }
      if (context.kind) {
        next.sourceKinds.add(context.kind);
      }
      if (Number.isFinite(context.domIndex)) {
        next.domIndex = Math.min(next.domIndex, context.domIndex);
      }
      if (context.element && !next.element) {
        next.element = context.element;
      }
      if (dims.width > next.width) {
        next.width = dims.width;
      }
      if (dims.height > next.height) {
        next.height = dims.height;
      }
      if (!next.alt && context.alt) {
        next.alt = context.alt;
      }
      if (!next.title && context.title) {
        next.title = context.title;
      }
      if (!next.containerKey && context.containerKey) {
        next.containerKey = context.containerKey;
      }
      byKey.set(key, next);
    };

    document.querySelectorAll("img").forEach((img, domIndex) => {
      const baseContext = {
        element: img,
        domIndex,
        alt: img.getAttribute("alt") || "",
        title: img.getAttribute("title") || "",
        containerKey: containerKeyForElement(img)
      };

      IMAGE_ATTRS.forEach((attr) => {
        const value = attr === "currentSrc" ? img.currentSrc : img.getAttribute(attr);
        upsert(value, { ...baseContext, kind: attr.startsWith("data-") ? "lazy-img" : "img" });
      });

      SRCSET_ATTRS.forEach((attr) => {
        parseSrcset(img.getAttribute(attr)).forEach((url) => upsert(url, { ...baseContext, kind: "srcset" }));
      });

      const anchor = img.closest("a[href]");
      if (anchor) {
        upsert(anchor.getAttribute("href"), { ...baseContext, kind: "anchor" });
      }
    });

    document.querySelectorAll("picture source").forEach((source, domIndex) => {
      SRCSET_ATTRS.forEach((attr) => {
        parseSrcset(source.getAttribute(attr)).forEach((url) => upsert(url, { domIndex, kind: "source-srcset" }));
      });
    });

    document.querySelectorAll("link[rel~='preload'][as='image'], link[rel~='prefetch'][as='image']").forEach((link) => {
      upsert(link.getAttribute("href"), { kind: "preload" });
    });

    document.querySelectorAll("meta[property='og:image'], meta[property='og:image:secure_url'], meta[name='twitter:image'], meta[property='twitter:image']").forEach((meta) => {
      upsert(meta.getAttribute("content"), { kind: "meta" });
    });

    if (options.includeEmbedded !== false) {
      scanEmbeddedImageUrls(upsert);
    }
    return Array.from(byKey.values());
  }

  function scanEmbeddedImageUrls(upsert) {
    let scannedBytes = 0;
    const maxBytes = EMBEDDED_SCAN_MAX_BYTES;
    const textNodes = [
      ...document.querySelectorAll("noscript"),
      ...document.querySelectorAll("script:not([src])")
    ];

    for (const node of textNodes) {
      const text = node.textContent || "";
      if (!text || scannedBytes >= maxBytes) {
        break;
      }
      if (!/\.(?:jpe?g|png|webp|avif)|\/api\/img\//i.test(text)) {
        continue;
      }
      if (text.length > EMBEDDED_SCRIPT_MAX_BYTES && node.tagName.toLowerCase() !== "noscript" && node.id !== "__NEXT_DATA__") {
        continue;
      }
      const normalizedText = text.replace(/\\\//g, "/").replace(/\\u002F/gi, "/");
      scannedBytes += normalizedText.length;
      for (const match of normalizedText.matchAll(IMAGE_URL_RE)) {
        upsert(match[0], { kind: node.tagName.toLowerCase() === "noscript" ? "noscript" : "script" });
      }
    }
  }

  function scoreCandidates(candidates) {
    candidates.forEach((candidate) => {
      candidate.numeric = parseNumericInfo(candidate.url);
      candidate.score = baseScore(candidate);
      candidate.groupKey = groupKeyForCandidate(candidate);
    });

    const groups = new Map();
    candidates.forEach((candidate) => {
      if (!candidate.groupKey) {
        return;
      }
      if (!groups.has(candidate.groupKey)) {
        groups.set(candidate.groupKey, []);
      }
      groups.get(candidate.groupKey).push(candidate);
    });

    groups.forEach((group) => {
      const bonus = groupBonus(group);
      group.forEach((candidate) => {
        candidate.finalScore = candidate.score + bonus;
      });
    });

    candidates.forEach((candidate) => {
      if (!candidate.groupKey) {
        candidate.finalScore = candidate.score;
      }
    });
  }

  function baseScore(candidate) {
    const urlText = decodeURIComponentSafe(candidate.url).toLowerCase();
    const sourceKinds = candidate.sourceKinds;
    let score = 0;

    if (isImageLikeUrl(candidate.url)) score += 1;
    if (sourceKinds.has("img") || sourceKinds.has("lazy-img") || sourceKinds.has("srcset")) score += 2;
    if (sourceKinds.has("lazy-img")) score += 1;
    if (sourceKinds.has("anchor")) score += 1;
    if (sourceKinds.has("preload")) score += 1;
    if (sourceKinds.has("meta")) score -= 1;
    if (candidate.numeric) score += 4;
    if (/\bpage\s*0*\d+\b/i.test(candidate.alt || "")) score += 3;
    if (/\bpage\s*0*\d+\b/i.test(candidate.title || "")) score += 2;

    if (candidate.width && candidate.height) {
      const area = candidate.width * candidate.height;
      const ratio = candidate.height / Math.max(candidate.width, 1);
      const sizeKey = `${candidate.width}x${candidate.height}`;
      if (candidate.width >= 450 && candidate.height >= 650) score += 2;
      if (area >= 300_000) score += 1;
      if (ratio >= 1.15) score += 2;
      if (ratio >= 0.65 && candidate.width >= 700 && candidate.height >= 700) score += 1;
      if (COMMON_AD_SIZES.has(sizeKey) || (candidate.width / Math.max(candidate.height, 1) > 3 && candidate.height <= 260)) {
        score -= 8;
      }
    }

    if (BAD_URL_RE.test(urlText)) score -= 8;
    if (/data:image\/svg/i.test(candidate.url)) score -= 20;

    return score;
  }

  function groupBonus(group) {
    const pageNumbers = Array.from(new Set(group.map((candidate) => candidate.numeric?.page).filter(Number.isFinite))).sort((a, b) => a - b);
    let bonus = 0;
    if (group.length >= 3) bonus += 2;
    if (group.length >= 8) bonus += 1;
    if (pageNumbers.length >= 3) bonus += 4;
    if (longestConsecutiveRun(pageNumbers) >= 3) bonus += 3;
    if (pageNumbers.length >= 8) bonus += 1;
    return bonus;
  }

  function selectBestSequence(candidates) {
    const groups = new Map();
    candidates.forEach((candidate) => {
      if (!candidate.groupKey) {
        return;
      }
      if (!groups.has(candidate.groupKey)) {
        groups.set(candidate.groupKey, []);
      }
      groups.get(candidate.groupKey).push(candidate);
    });

    const rankedGroups = Array.from(groups.values())
      .map((group) => {
        const pageNumbers = new Set(group.map((candidate) => candidate.numeric?.page).filter(Number.isFinite));
        const highQuality = group.filter((candidate) => candidate.finalScore >= 6 && candidate.score > -2);
        const rank = pageNumbers.size * 14 + highQuality.length * 4 + average(group.map((candidate) => candidate.finalScore));
        return { group, pageNumbers, highQuality, rank };
      })
      .filter((entry) => entry.pageNumbers.size >= 3 || entry.highQuality.length >= 5)
      .sort((a, b) => b.rank - a.rank);

    if (rankedGroups.length > 0) {
      const best = rankedGroups[0].group
        .filter((candidate) => candidate.finalScore >= 5 && candidate.score > -4)
        .sort((a, b) => b.finalScore - a.finalScore);
      return dedupeByPage(best).sort(compareCandidates);
    }

    return dedupeByPage(candidates.filter((candidate) => candidate.finalScore >= 8)).sort(compareCandidates);
  }

  function dedupeByPage(candidates) {
    const byPage = new Map();
    const withoutPage = [];

    candidates.forEach((candidate) => {
      const page = candidate.numeric?.page;
      if (!Number.isFinite(page)) {
        withoutPage.push(candidate);
        return;
      }
      const existing = byPage.get(page);
      if (!existing || isBetterCandidate(candidate, existing)) {
        byPage.set(page, candidate);
      }
    });

    return [...byPage.values(), ...withoutPage].slice(0, MAX_SELECTED_PAGES);
  }

  function compareCandidates(a, b) {
    const aPage = a.numeric?.page;
    const bPage = b.numeric?.page;
    if (Number.isFinite(aPage) && Number.isFinite(bPage) && aPage !== bPage) {
      return aPage - bPage;
    }
    if (a.domIndex !== b.domIndex) {
      return a.domIndex - b.domIndex;
    }
    return a.sourceIndex - b.sourceIndex;
  }

  function groupKeyForCandidate(candidate) {
    const url = safeUrl(candidate.url);
    if (!url) {
      return "";
    }
    const sourceScope = candidate.containerKey || url.origin;
    if (candidate.numeric) {
      return `num:${imageExtension(url.pathname)}:${sourceScope}:${candidate.numeric.family}`;
    }
    if (candidate.score >= 4) {
      return `path:${sourceScope}:${url.pathname.replace(/\/[^/]*$/, "/")}`;
    }
    return "";
  }

  function parseNumericInfo(urlValue) {
    const url = safeUrl(urlValue);
    if (!url) {
      return null;
    }
    const pathname = decodeURIComponentSafe(url.pathname);
    const filename = pathname.split("/").pop() || "";
    const ext = imageExtension(filename);
    const base = stripResponsiveImageSize(filename).replace(/\.(?:jpe?g|png|webp|avif)$/i, "").toLowerCase();
    if (!base) {
      return null;
    }

    let match = base.match(/^0*(\d{1,4})$/);
    if (match) {
      return { page: Number(match[1]), family: `pure:${ext}` };
    }

    match = base.match(/^0*(\d{1,3})[-_.\s]+(.+)$/);
    if (match && (Number(match[1]) <= MAX_REASONABLE_PAGE_NUMBER || /(?:chapter|chap|manga|page|comic)/i.test(base))) {
      const rest = match[2].replace(/\d+/g, "#");
      if (/^\d{4,}[-_.\s]+0*\d{1,3}$/i.test(base)) {
        const trailing = base.match(/^(.+[-_.\s])0*(\d{1,3})$/);
        return { page: Number(trailing[2]), family: `trailing:${trailing[1].replace(/\d+/g, "#")}:${ext}` };
      }
      return { page: Number(match[1]), family: `leading:${rest}:${ext}` };
    }

    match = base.match(/^(.+[-_.\s])0*(\d{1,3})$/);
    if (match) {
      return { page: Number(match[2]), family: `trailing:${match[1].replace(/\d+/g, "#")}:${ext}` };
    }

    return null;
  }

  function getElementDimensions(img) {
    const width = firstPositiveNumber(
      img.naturalWidth,
      img.getAttribute("width"),
      img.getAttribute("data-original-width"),
      img.getAttribute("data-width")
    );
    const height = firstPositiveNumber(
      img.naturalHeight,
      img.getAttribute("height"),
      img.getAttribute("data-original-height"),
      img.getAttribute("data-height")
    );
    return { width, height };
  }

  function firstPositiveNumber(...values) {
    for (const value of values) {
      const number = Number.parseInt(String(value || "").replace(/[^0-9]/g, ""), 10);
      if (Number.isFinite(number) && number > 0) {
        return number;
      }
    }
    return 0;
  }

  function parseSrcset(value) {
    if (!value) {
      return [];
    }
    return value
      .split(",")
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean);
  }

  function toAbsoluteImageUrl(rawValue, context = {}) {
    if (!rawValue || typeof rawValue !== "string") {
      return null;
    }
    let value = decodeEntities(rawValue.trim());
    if (!value || /^data:image\/(?:svg|gif)/i.test(value) || /^blob:/i.test(value)) {
      return null;
    }
    value = value.replace(/\\\//g, "/").replace(/\\u002F/gi, "/");
    if (value.startsWith("//")) {
      value = `${location.protocol}${value}`;
    }
    const url = safeUrl(value, location.href);
    if (!url || !/^https?:$/i.test(url.protocol) || !isImageLikeUrl(url.href, context)) {
      return null;
    }
    return url.href;
  }

  function isImageLikeUrl(urlValue, context = {}) {
    const url = safeUrl(urlValue, location.href);
    if (!url) {
      return false;
    }
    if (/\.(?:jpe?g|png|webp|avif)$/i.test(url.pathname) || /[?&](?:format|type|mime)=image\//i.test(url.search)) {
      return true;
    }

    const imageContextKinds = new Set(["img", "lazy-img", "srcset", "source-srcset", "preload"]);
    const hasImageContext = imageContextKinds.has(context.kind);
    if (!hasImageContext) {
      return false;
    }

    return /\/(?:api\/)?(?:img|image|images|media|scan|scans|page|pages|manga|uploads?)(?:\/|$)/i.test(url.pathname);
  }

  function logicalImageKey(urlValue) {
    const url = safeUrl(urlValue);
    if (!url) {
      return urlValue;
    }
    const path = decodeURIComponentSafe(url.pathname)
      .replace(/\/s\d+(?:-[^/]+)?\//gi, "/s*/")
      .replace(/\/(?:w|h)\d+(?:-[whcp]\d+)*\//gi, "/size*/")
      .replace(/-\d{2,5}x\d{2,5}(\.(?:jpe?g|png|webp|avif))$/i, "$1");
    return `${url.origin}${path}${normalizedSearch(url.searchParams)}`.toLowerCase();
  }

  function imageUrlQuality(urlValue) {
    const url = safeUrl(urlValue);
    if (!url) {
      return 0;
    }
    const path = url.pathname;
    const bloggerSize = path.match(/\/s(\d+)(?:-[^/]+)?\//i);
    const widthHeight = path.match(/(?:^|[/-])(?:w|h)(\d+)(?:-[wh](\d+))?/i);
    let quality = 1;
    if (bloggerSize) quality += Number(bloggerSize[1]);
    if (widthHeight) quality += Number(widthHeight[1] || 0) + Number(widthHeight[2] || 0);
    if (/\.(?:webp|png|jpe?g|avif)$/i.test(path)) quality += 10;
    if (/-\d{2,5}x\d{2,5}\.(?:jpe?g|png|webp|avif)$/i.test(path)) quality -= 10_000;
    return quality;
  }

  function isBetterCandidate(candidate, existing) {
    if (candidate.finalScore > existing.finalScore + 0.5) {
      return true;
    }
    if (existing.finalScore > candidate.finalScore + 0.5) {
      return false;
    }

    const candidateQuality = imageUrlQuality(candidate.url);
    const existingQuality = imageUrlQuality(existing.url);
    if (candidateQuality !== existingQuality) {
      return candidateQuality > existingQuality;
    }

    if (candidate.domIndex !== existing.domIndex) {
      return candidate.domIndex < existing.domIndex;
    }

    return candidate.sourceIndex < existing.sourceIndex;
  }

  function containerKeyForElement(element) {
    const container = element.closest([
      "[id*='reader' i]",
      "[class*='reader' i]",
      "[id*='chapter' i]",
      "[class*='chapter' i]",
      "[class*='entry-content' i]",
      "[class*='single-content' i]",
      "[class*='post-content' i]",
      "[class*='manga' i]",
      "article",
      "main"
    ].join(","));

    if (container) {
      return elementSignature(container);
    }

    const repeatedWrapper = element.closest("figure, .separator, p, div");
    return repeatedWrapper ? elementSignature(repeatedWrapper) : "document";
  }

  function elementSignature(element) {
    if (!element) {
      return "document";
    }
    const tag = element.tagName.toLowerCase();
    if (element.id) {
      return `${tag}#${element.id.slice(0, ELEMENT_SIGNATURE_MAX_CHARS)}`;
    }
    const classes = Array.from(element.classList || [])
      .filter((className) => !/^\d/.test(className) && className.length <= 48)
      .slice(0, 4)
      .join(".");
    if (classes) {
      return `${tag}.${classes}`;
    }
    return tag;
  }

  function normalizedSearch(searchParams) {
    const params = new URLSearchParams(searchParams);
    const ignored = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid", "ver", "v", "cache", "cachebuster", "cb", "_"]);
    for (const key of Array.from(params.keys())) {
      const normalizedKey = key.toLowerCase();
      if (ignored.has(normalizedKey) || normalizedKey.startsWith("utm_")) {
        params.delete(key);
      }
    }
    const serialized = params.toString();
    return serialized ? `?${serialized}` : "";
  }

  function longestConsecutiveRun(numbers) {
    if (numbers.length === 0) {
      return 0;
    }
    let best = 1;
    let current = 1;
    for (let index = 1; index < numbers.length; index += 1) {
      if (numbers[index] === numbers[index - 1] + 1) {
        current += 1;
        best = Math.max(best, current);
      } else if (numbers[index] !== numbers[index - 1]) {
        current = 1;
      }
    }
    return best;
  }

  function average(values) {
    if (values.length === 0) {
      return 0;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function imageExtension(pathname) {
    return (pathname.match(/\.(jpe?g|png|webp|avif)(?:$|\?)/i)?.[1] || "img").toLowerCase();
  }

  function stripResponsiveImageSize(filename) {
    return filename.replace(/-\d{2,5}x\d{2,5}(\.(?:jpe?g|png|webp|avif))$/i, "$1");
  }

  function safeUrl(value, base) {
    try {
      return new URL(value, base);
    } catch (_error) {
      return null;
    }
  }

  function decodeEntities(value) {
    return value
      .replace(/&amp;/gi, "&")
      .replace(/&#038;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#x2F;/gi, "/")
      .replace(/&#47;/gi, "/");
  }

  function decodeURIComponentSafe(value) {
    try {
      return decodeURIComponent(value);
    } catch (_error) {
      return value;
    }
  }

  function scheduleActivatorRefresh(delay = 0) {
    if (active) {
      return;
    }
    window.clearTimeout(activatorRefreshTimer);
    activatorRefreshTimer = window.setTimeout(refreshActivator, delay);
  }

  async function refreshActivator() {
    if (active || document.getElementById(ROOT_ID)) {
      return;
    }
    const autoOpenIntent = readChapterAutoOpenIntent();
    const shouldAutoOpen = shouldConsumeChapterAutoOpenIntent(autoOpenIntent);
    const chapterUrl = isExplicitChapterUrl(location.href) || isMangaDexReaderPage();
    const readerData = await collectReaderData({ includeEmbedded: shouldAutoOpen || chapterUrl });
    const detected = readerData.pages;
    if (detected.length >= MIN_DETECTED_PAGES) {
      if (shouldAutoOpen && consumeChapterAutoOpenIntentIfCurrent(autoOpenIntent)) {
        await activateReader({ autoOpen: true });
        return;
      }
      if (chapterUrl && !readerClosedByUser) {
        await activateReader({ autoOpen: true });
        return;
      }
      showActivator(detected.length);
    } else {
      removeActivator();
    }
  }

  function showActivator(count) {
    let activator = document.getElementById(ACTIVATOR_ID);
    if (!activator) {
      activator = document.createElement("div");
      activator.id = ACTIVATOR_ID;
      activator.innerHTML = '<button class="pmr-button pmr-button-primary" type="button">Reader</button>';
      activator.addEventListener("click", () => {
        toggleReader().catch((error) => {
          console.warn("Prettify Manga Reader activation failed", error);
          showToast("Could not open manga reader.");
        });
      });
      document.documentElement.appendChild(activator);
    }
    const button = activator.querySelector("button");
    if (button) {
      button.textContent = `Reader · ${count}`;
      button.title = `Open manga reader (${count} pages detected)`;
    }
  }

  function removeActivator() {
    document.getElementById(ACTIVATOR_ID)?.remove();
  }

  function observeEarlyMutations() {
    if (!document.body || mutationObserver) {
      return;
    }
    let refreshes = 0;
    mutationObserver = new MutationObserver(() => {
      if (active) {
        return;
      }
      refreshes += 1;
      scheduleActivatorRefresh(ACTIVATOR_MUTATION_DELAY_MS);
      if (refreshes > ACTIVATOR_MAX_MUTATION_REFRESHES) {
        mutationObserver.disconnect();
        mutationObserver = null;
      }
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "srcset", "data-src", "data-lazy-src"] });
  }

  function showToast(message) {
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement("div");
      toast.id = TOAST_ID;
      document.documentElement.appendChild(toast);
    }
    toast.textContent = message;
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.remove(), TOAST_DURATION_MS);
  }

  function helpDialogMarkup() {
    return `
      <div class="pmr-help-dialog" role="document">
        <h2>FRANK Scanlation Reader</h2>
        <p>The reader builds this view from detected page-image sequences instead of site-specific selectors.</p>
        <ul>
          <li><kbd>Space</kbd>, <kbd>PageDown</kbd>, <kbd>↓</kbd>, <kbd>→</kbd>: next page/spread, then next chapter at the end</li>
          <li><kbd>Shift</kbd> + <kbd>Space</kbd>, <kbd>PageUp</kbd>, <kbd>↑</kbd>, <kbd>←</kbd>: previous page/spread, then previous chapter at the start</li>
          <li><kbd>Enter</kbd>: next chapter, <kbd>Backspace</kbd>: previous chapter</li>
          <li><kbd>Home</kbd> / <kbd>End</kbd>: chapter start/end</li>
          <li><kbd>D</kbd>: cycle Single → Double → Book spread mode</li>
          <li><kbd>S</kbd>: toggle scroll snapping</li>
          <li><kbd>N</kbd>: cycle Night Off → Night 1 → Night 2 → Night 3</li>
          <li><kbd>H</kbd>: back to your FRANK Scanlation library</li>
          <li><kbd>?</kbd>: show/hide this help</li>
          <li><kbd>Esc</kbd>: close help, then turn reader off</li>
        </ul>
        <p><strong>Modes:</strong> Single shows one fitted page. Double pairs pages from the beginning. Book keeps the first page alone, then pairs the rest. Mode changes are remembered per manga when possible.</p>
        <button class="pmr-button pmr-button-primary" type="button" data-pmr-action="help-close">Close</button>
      </div>
    `;
  }

  if (window.__PMR_ENABLE_TEST_API__) {
    window.__PMR_TEST_API__ = {
      HOME_SIGNAL_URL,
      hostileOverlayVerdict,
      goHome,
      loadSettings,
      saveSettings,
      getSettings: () => settings,
      DEFAULT_READER_MODE,
      DEFAULT_NIGHT_MODE,
      NIGHT_MODE_LEVELS,
      buildSpreads,
      chapterInfoFromText,
      chapterInfoFromUrl,
      chapterAutoOpenIntentForTarget,
      chapterDirectionFromKey,
      genericMangaPreferenceKey,
      isExplicitChapterUrl,
      isKindleMangaReaderPage,
      isMangaDexReaderPage,
      kindleNavigationPlanFromKey,
      mangaDexChapterInfoFromUrl,
      mangaDexNavFromChapterList,
      mangaDexMangaKeyFromTitleUrl,
      mangaDexPagesFromAtHomeData,
      navigationUrlKey,
      pageNavigationIntentFromKey,
      readerModeForMangaKey,
      sanitizeMangaModePrefs,
      scoreChapterNavElement,
      shouldConsumeChapterAutoOpenIntent,
      visualPageIndexesForSpread,
      withMangaModePreference,
      isBadChapterNavLink,
      isLandscapePage,
      logicalImageKey,
      parseNumericInfo,
      setChapterNavForTest(value) {
        chapterNav = value;
      }
    };
  }
})();
