// lib/discover.js
// Given a hub/landing page URL, extract candidate category/product-line
// links from it. This is intentionally a broad, permissive heuristic (same
// origin, not an obvious non-content page) rather than a precise one --
// every site organizes its nav differently, so the result is meant to be
// reviewed and edited by a human before anything is scraped, not queued
// automatically.

const EXCLUDE_HINTS = [
  "/blog/", "/blogs/", "/news/", "/about", "/contact", "/cart", "/checkout",
  "/account", "/login", "/register", "/policy", "/policies", "/terms",
  "/privacy", "/faq", "/pages/", "/page/", "/search", "/wishlist",
  "/careers", "/press", "/sitemap", ".xml", ".pdf", "/tag/", "/tags/",
  "/mylists/",
  "mailto:", "tel:", "javascript:",
];

// Class/id/name fragments that identify sitewide chrome rather than a hub
// page's own category tiles. The global nav, mega-menu dropdowns,
// off-canvas menus, breadcrumbs, footer, ads and announcement bars repeat
// the same links on every page, so they make poor "discover from this hub"
// candidates. <nav>, <footer> and <aside> are treated the same way.
const GLOBAL_NAV_HINTS = [
  "nav-main", "main-nav", "site-nav", "global-nav", "primary-nav", "navbar",
  "off-canvas", "offcanvas", "nav-offcanvas",
  "breadcrumbs", "breadcrumb",
  "footer", "subfooter",
  "banner-wrapper", "banner", "ad-", "advertisement",
  "hello-bar", "announcement-bar", "network-hello",
  "cookie-banner", "cookie-consent",
];

// Generic action labels that are not useful category names on their own.
const JUNK_TEXT = ["view all", "see all", "more...", "more", "read more", "learn more"];

// Labels that almost always belong to global navigation rather than a
// hub page's own categories. These are only used in the fallback pass for
// top-level catalog pages where the categories themselves live in the nav.
const GLOBAL_NAV_LABELS = [
  "new", "topics", "in stock", "get free samples", "projects", "brands", "magazine",
  "interior", "building", "design service", "home", "homepage", "go to the homepage",
  "search", "cart", "account", "login", "register", "about", "contact", "faq", "help",
  "blog", "news", "press", "careers", "terms", "privacy", "policies",
];

const MAX_CANDIDATES = 40;

function titleizeSlug(slug) {
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function isJunkText(text) {
  const lower = text.toLowerCase().replace(/[.…]+$/, "");
  return JUNK_TEXT.includes(lower);
}

async function discoverCategoryLinks(browser, hubUrl) {
  const page = await browser.newPage();
  let raw;
  try {
    await page.goto(hubUrl, { waitUntil: "domcontentloaded", timeout: 20000 });

    // We collect links in two passes inside the browser so we can inspect
    // the live DOM (bounding boxes and ancestor tags/classes).
    // 1. Visible links that are NOT inside global nav/footer/aside/banners.
    // 2. If that yields too few results, fall back to visible links that are
    //    only outside footer/aside/banners -- this lets top-level catalog
    //    pages (e.g. /en/product) return their main navigation categories
    //    when the page has no deeper content links of its own.
    raw = await page.$$eval(
      "a[href]",
      (as, navHints) => {
        function ancestorFlags(el) {
          let isNav = false;
          let isChrome = false;
          let depth = 0;
          while (el && depth < 8) {
            const tag = el.tagName.toLowerCase();
            const cls = (el.className || "").toLowerCase();
            const id = (el.id || "").toLowerCase();
            if (tag === "nav") isNav = true;
            if (tag === "footer" || tag === "aside") isChrome = true;
            if (navHints.some((h) => cls.includes(h) || id.includes(h))) {
              // nav-related hints count as nav; footer/ad/cookie hints count as chrome
              if (cls.includes("footer") || cls.includes("subfooter") || cls.includes("banner") || cls.includes("ad-") || cls.includes("advertisement") || cls.includes("hello-bar") || cls.includes("announcement-bar") || cls.includes("cookie")) {
                isChrome = true;
              } else {
                isNav = true;
              }
            }
            el = el.parentElement;
            depth++;
          }
          return { isNav, isChrome };
        }

        return as.map((a) => {
          const rect = a.getBoundingClientRect();
          const flags = ancestorFlags(a);
          return {
            href: a.href,
            text: a.textContent.replace(/\s+/g, " ").trim(),
            width: rect.width,
            height: rect.height,
            isNav: flags.isNav,
            isChrome: flags.isChrome,
          };
        });
      },
      GLOBAL_NAV_HINTS
    );
  } finally {
    await page.close();
  }

  const hubOrigin = new URL(hubUrl).origin;
  const hubPath = new URL(hubUrl).pathname.replace(/\/$/, "");

  // Keep only visible, same-origin links with some label text.
  const visible = raw.filter((a) => {
    if (a.width <= 0 || a.height <= 0) return false;
    if (!a.text || a.text.length < 2) return false;
    return true;
  });

  // Primary pass: exclude global nav and chrome. If we get enough, use these.
  let chosen = visible.filter((a) => !a.isNav && !a.isChrome && !isJunkText(a.text));
  // Fallback: top-level catalog pages often have their categories only in
  // the main nav. In that case, keep nav links but still drop footer/aside/
  // banner/chrome links, junk labels, and obvious global-nav labels.
  if (chosen.length < 3) {
    chosen = visible.filter(
      (a) =>
        !a.isChrome &&
        !isJunkText(a.text) &&
        !GLOBAL_NAV_LABELS.includes(a.text.toLowerCase())
    );
  }

  const seen = new Set();
  const candidates = [];

  for (const { href, text } of chosen) {
    let parsed;
    try {
      parsed = new URL(href);
    } catch {
      continue;
    }
    if (parsed.origin !== hubOrigin) continue;

    const normalizedPath = parsed.pathname.replace(/\/$/, "");
    if (!normalizedPath || normalizedPath === hubPath) continue;

    const lower = href.toLowerCase();
    if (EXCLUDE_HINTS.some((hint) => lower.includes(hint))) continue;

    const key = parsed.origin + normalizedPath;
    if (seen.has(key)) continue;
    seen.add(key);

    const lastSegment = normalizedPath.split("/").filter(Boolean).pop() || "";
    const label = text && text.length <= 40 ? text : titleizeSlug(lastSegment);

    candidates.push({ url: parsed.origin + normalizedPath, label });
    if (candidates.length >= MAX_CANDIDATES) break;
  }

  return candidates;
}

module.exports = { discoverCategoryLinks };
