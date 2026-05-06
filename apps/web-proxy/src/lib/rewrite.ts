import * as cheerio from "cheerio";

export const PROXY_ROUTE = "/proxy";

// ── Pre-compiled regex constants (avoid recompiling on every call) ─────────
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const META_REFRESH_RE = /^(\d*\s*;?\s*url=)(.+)$/i;
const BLOCKING_LIB_RE = /jwplayer|flowplayer|video\.js|plyr|mediaelement/i;
const PROXY_ROUTE_MARKER = PROXY_ROUTE + "?url=";

// Schemes that must never be proxied — checked with a fast Set lookup on prefix
const SKIP_PREFIXES = ["data:", "blob:", "javascript:", "mailto:", "tel:", "#", "about:"];

// Lazy-load data attributes we rewrite
const LAZY_ATTRS = ["data-src", "data-href", "data-lazy-src", "data-original"] as const;
const LAZY_ATTRS_SRCSET = ["data-srcset"] as const;

// ── Interceptor script cache ───────────────────────────────────────────────
// The interceptor has two parts:
//   1. A static body (patch functions, stubs) — identical for all pages.
//   2. A tiny per-page header that sets BASE_URL to the current page URL.
// We pre-build the static body once and prepend a fresh BASE_URL line per page.
// This avoids rebuilding the full 200-line string on every HTML response while
// still using the correct BASE_URL for relative-URL resolution on every page.
let _interceptorStaticBody: string | null = null;

function getInterceptorStaticBody(): string {
  if (_interceptorStaticBody) return _interceptorStaticBody;
  _interceptorStaticBody = buildInterceptorStaticBody();
  return _interceptorStaticBody;
}

/**
 * Convert any URL (relative or absolute) into a proxy URL.
 *
 * Critical: encodeURIComponent(absolute) ensures the entire upstream URL
 * (including its own query string, e.g. episodes.js?filever=1007) is encoded
 * as a single opaque value in our ?url= parameter. Without this the browser
 * would split "?filever=1007" off as a second query parameter and the proxy
 * would fetch the wrong URL.
 */
export function makeProxyUrl(raw: string, base: string): string {
  if (!raw) return raw;
  for (const prefix of SKIP_PREFIXES) {
    if (raw.startsWith(prefix)) return raw;
  }
  // Fast early-exit for already-proxied URLs (avoids URL parse)
  if (raw.includes(PROXY_ROUTE_MARKER)) return raw;
  try {
    const absolute = new URL(raw, base).href;
    if (!absolute.startsWith("http://") && !absolute.startsWith("https://")) return raw;
    if (absolute.includes(PROXY_ROUTE_MARKER)) return raw;
    // encodeURIComponent encodes '?' and '&' so the upstream query string is
    // never confused with our own proxy route's query parameters.
    return `${PROXY_ROUTE}?url=${encodeURIComponent(absolute)}`;
  } catch {
    return raw;
  }
}

/**
 * Rewrite all URLs in an HTML document so they route through the proxy.
 * Also injects a runtime interceptor for fetch/XHR calls.
 *
 * Uses separate Cheerio passes per attribute (e.g. $("[src]"), $("[href]")).
 * A single-pass $("*") scan does NOT work in Cheerio — attribute selectors
 * like $("[src]") are the correct and only reliable approach.
 */
export function rewriteHtml(html: string, baseUrl: string): string {
  const $ = cheerio.load(html);

  // ── Determine effective base URL ─────────────────────────────────────────
  // Many sites use <base href="/"> or <base href="https://example.com/"> to
  // make all relative paths resolve against the root, not the page's deep path.
  // We must read it BEFORE removing it, then use it as our resolution base.
  let effectiveBase = baseUrl;
  const baseTag = $("base[href]").first();
  if (baseTag.length) {
    const baseHref = baseTag.attr("href") ?? "";
    if (baseHref) {
      try {
        // Resolve the base href against the page URL to get an absolute URL
        effectiveBase = new URL(baseHref, baseUrl).href;
      } catch { /* ignore malformed base href */ }
    }
  }

  // Remove base tag — we control all URLs ourselves
  $("base").remove();

  // Remove CSP and other blocking meta tags
  $('meta[http-equiv="Content-Security-Policy"]').remove();
  $('meta[http-equiv="X-Frame-Options"]').remove();

  // ── Attribute rewriting — separate passes per attribute ──────────────────
  // NOTE: Cheerio's $("*") does NOT reliably visit script/link elements when
  // attribute selectors like $("[src]") are the correct approach. Each pass
  // below targets exactly the elements that have that attribute.

  // href: <a>, <link>, <area>, <use>, etc.
  $("[href]").each((_, el) => {
    const val = $(el).attr("href");
    if (val) $(el).attr("href", makeProxyUrl(val, effectiveBase));
  });

  // src: <img>, <script>, <iframe>, <audio>, <video>, <source>, <track>, <embed>
  $("[src]").each((_, el) => {
    const val = $(el).attr("src");
    if (!val) return;
    $(el).attr("src", makeProxyUrl(val, effectiveBase));
    // Strip async/defer from blocking player libs so they load synchronously
    if ($(el).is("script") && BLOCKING_LIB_RE.test(val)) {
      $(el).removeAttr("async");
      $(el).removeAttr("defer");
    }
  });

  // srcset: <img>, <source>
  $("[srcset]").each((_, el) => {
    const val = $(el).attr("srcset");
    if (val) $(el).attr("srcset", rewriteSrcset(val, effectiveBase));
  });

  // action: <form>
  $("[action]").each((_, el) => {
    const val = $(el).attr("action");
    if (val) $(el).attr("action", makeProxyUrl(val, effectiveBase));
  });

  // poster: <video>
  $("[poster]").each((_, el) => {
    const val = $(el).attr("poster");
    if (val) $(el).attr("poster", makeProxyUrl(val, effectiveBase));
  });

  // <meta http-equiv="refresh" content="0; url=...">
  $("meta[http-equiv]").each((_, el) => {
    if (($( el).attr("http-equiv") ?? "").toLowerCase() !== "refresh") return;
    const content = $(el).attr("content") ?? "";
    $(el).attr("content", content.replace(
      META_REFRESH_RE,
      (_, prefix: string, url: string) => prefix + makeProxyUrl(url.trim(), effectiveBase)
    ));
  });

  // Lazy-load data attributes
  $("[data-src],[data-href],[data-lazy-src],[data-original]").each((_, el) => {
    for (const attr of LAZY_ATTRS) {
      const val = $(el).attr(attr);
      if (val) $(el).attr(attr, makeProxyUrl(val, effectiveBase));
    }
  });
  $("[data-srcset]").each((_, el) => {
    const val = $(el).attr("data-srcset");
    if (val) $(el).attr("data-srcset", rewriteSrcset(val, effectiveBase));
  });

  // Inline style attributes
  $("[style]").each((_, el) => {
    const val = $(el).attr("style");
    if (val) $(el).attr("style", rewriteCssUrls(val, effectiveBase));
  });

  // <style> blocks (separate pass — these are text nodes, not attrs)
  $("style").each((_, el) => {
    const content = $(el).html();
    if (content) $(el).html(rewriteCssUrls(content, effectiveBase));
  });

  // Inject Referrer-Policy so middleware can recover origin from Referer header
  $('meta[name="referrer"]').remove();
  $("head").append('<meta name="referrer" content="no-referrer-when-downgrade">');

  // Inject runtime interceptor.
  // BASE_URL is per-page (affects relative URL resolution); the static body is
  // built once and reused so we don't rebuild 200 lines of JS on every response.
  const interceptorScript =
    `(function(){\n'use strict';\nvar PROXY_PREFIX='/proxy?url=';\nvar BASE_URL=${JSON.stringify(baseUrl)};\n` +
    getInterceptorStaticBody();

  const $script = $('<script id="proxy-interceptor"></script>');
  $script.text(interceptorScript);
  if ($("head").length) {
    $("head").prepend($script);
  } else {
    $.root().prepend($script);
  }

  return $.html();
}

/**
 * Rewrite url() references in CSS text.
 * Uses a module-level pre-compiled regex to avoid recompilation per call.
 */
export function rewriteCssUrls(css: string, baseUrl: string): string {
  // Reset lastIndex because the regex has the /g flag and is reused
  CSS_URL_RE.lastIndex = 0;
  return css.replace(CSS_URL_RE, (_, quote: string, url: string) => {
    const rewritten = makeProxyUrl(url.trim(), baseUrl);
    return `url(${quote}${rewritten}${quote})`;
  });
}

/**
 * Rewrite a srcset attribute value.
 * Format: "<url> <descriptor>, <url> <descriptor>, ..."
 */
function rewriteSrcset(srcset: string, baseUrl: string): string {
  return srcset
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      const spaceIdx = trimmed.search(/\s/);
      if (spaceIdx === -1) return makeProxyUrl(trimmed, baseUrl);
      const url = trimmed.slice(0, spaceIdx);
      const descriptor = trimmed.slice(spaceIdx);
      return makeProxyUrl(url, baseUrl) + descriptor;
    })
    .join(", ");
}

/**
 * Build the static body of the interceptor script — everything except the
 * per-page BASE_URL header, which the caller prepends.  Built once and cached.
 */
function buildInterceptorStaticBody(): string {
  return `
  var BASE_ORIGIN = (function() { try { return new URL(BASE_URL).origin; } catch(e) { return ''; } })();

  /* ── Stub console.clear so the target site can't wipe our devtools ── */
  try { console.clear = function() {}; } catch(e) {}

  /* ── Stub navigator.serviceWorker so cross-origin SW registration doesn't throw ── */
  // Sites try to register a SW with a scope like /sw.js?scope=/ but from the
  // proxy origin (localhost:3000) the scope URL won't match the upstream origin,
  // causing an uncaught DOMException. We no-op register() to prevent the crash.
  try {
    if (typeof navigator !== 'undefined') {
      if (navigator.serviceWorker) {
        navigator.serviceWorker.register = function() {
          return Promise.resolve({
            installing: null, waiting: null, active: null,
            update: function() { return Promise.resolve(undefined); },
            unregister: function() { return Promise.resolve(false); },
          });
        };
      }
    }
  } catch(e) {}

  /* ── Stub ad/tracking globals so missing ad scripts don't crash page JS ── */
  // aclib.js loads from acscdn.com directly (passthrough domain). If it loads
  // successfully it overwrites this stub. If it fails (e.g. ad-blocker, network
  // error) the stub silently absorbs all aclib.runBanner() calls.
  (function() {
    var noop = function() {};
    function makeStub() {
      if (typeof Proxy !== 'undefined') {
        return new Proxy(noop, { get: function() { return noop; }, apply: noop });
      }
      return { runBanner: noop, runInterstitial: noop, runAutoTag: noop, runPop: noop };
    }
    // Only stub if not already defined — real aclib.js may have loaded first
    if (typeof window.aclib === 'undefined') window.aclib = makeStub();
    if (typeof window._ase === 'undefined') window._ase = makeStub();
    if (typeof window.acpwd === 'undefined') window.acpwd = makeStub();
    if (typeof window.atOptions === 'undefined') window.atOptions = {};
  })();

  function proxify(url) {
    if (!url) return url;
    if (typeof url !== 'string') return url;
    var s = url.toLowerCase();
    if (s.indexOf('data:') === 0) return url;
    if (s.indexOf('blob:') === 0) return url;
    if (s.indexOf('javascript:') === 0) return url;
    if (s.indexOf('about:') === 0) return url;
    if (s.indexOf('mailto:') === 0) return url;
    if (s.indexOf('tel:') === 0) return url;
    if (s.indexOf('#') === 0) return url;
    if (url.indexOf(PROXY_PREFIX) !== -1) return url;
    try {
      var abs = new URL(url, BASE_URL).href;
      if (abs.indexOf('http://') === 0) return PROXY_PREFIX + encodeURIComponent(abs);
      if (abs.indexOf('https://') === 0) return PROXY_PREFIX + encodeURIComponent(abs);
    } catch(e) {}
    return url;
  }

  /* ── fetch ── */
  if (typeof window.fetch === 'function') {
    var _fetch = window.fetch;
    window.fetch = function(input, init) {
      try {
        if (typeof input === 'string') {
          input = proxify(input);
        } else if (input && input.url) {
          try { input = new Request(proxify(input.url), input); } catch(e) {}
        }
      } catch(e) {}
      return _fetch.call(this, input, init);
    };
  }

  /* ── XMLHttpRequest ── */
  if (typeof XMLHttpRequest !== 'undefined' && XMLHttpRequest.prototype.open) {
    var _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function() {
      var args = Array.prototype.slice.call(arguments);
      if (args.length >= 2 && typeof args[1] === 'string') {
        try { args[1] = proxify(args[1]); } catch(e) {}
      }
      return _open.apply(this, args);
    };
  }

  /* ── Element.prototype.setAttribute ── */
  if (typeof Element !== 'undefined' && Element.prototype.setAttribute) {
    var _setAttribute = Element.prototype.setAttribute;
    var ATTRS = ['src', 'href', 'action', 'data-src', 'data-href', 'data-lazy-src', 'data-original', 'poster'];
    Element.prototype.setAttribute = function(name, value) {
      try {
        if (typeof name === 'string' && ATTRS.indexOf(name.toLowerCase()) !== -1) {
          value = proxify(String(value));
        }
      } catch(e) {}
      return _setAttribute.call(this, name, value);
    };
  }

  /* ── Property Interceptors ── */
  function patch(proto, prop) {
    if (!proto) return;
    try {
      var desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (desc && desc.set && desc.configurable) {
        Object.defineProperty(proto, prop, {
          get: desc.get,
          set: function(val) {
            try { val = proxify(String(val)); } catch(e) {}
            desc.set.call(this, val);
          },
          configurable: true
        });
      }
    } catch(e) {}
  }

  if (typeof HTMLScriptElement !== 'undefined') patch(HTMLScriptElement.prototype, 'src');
  if (typeof HTMLLinkElement !== 'undefined') patch(HTMLLinkElement.prototype, 'href');
  if (typeof HTMLImageElement !== 'undefined') patch(HTMLImageElement.prototype, 'src');
  if (typeof HTMLMediaElement !== 'undefined') patch(HTMLMediaElement.prototype, 'src');
  if (typeof HTMLIFrameElement !== 'undefined') patch(HTMLIFrameElement.prototype, 'src');
  if (typeof HTMLSourceElement !== 'undefined') patch(HTMLSourceElement.prototype, 'src');

  /* ── location ── */
  if (typeof Location !== 'undefined' && Location.prototype) {
    patch(Location.prototype, 'href');
    var _assign = Location.prototype.assign;
    if (_assign) {
      Location.prototype.assign = function(url) {
        try { url = proxify(String(url)); } catch(e) {}
        return _assign.call(this, url);
      };
    }
    var _replace = Location.prototype.replace;
    if (_replace) {
      Location.prototype.replace = function(url) {
        try { url = proxify(String(url)); } catch(e) {}
        return _replace.call(this, url);
      };
    }
  }

  /* ── Worker ── */
  if (typeof Worker !== 'undefined') {
    var _Worker = Worker;
    window.Worker = function(url, opts) {
      try { url = proxify(String(url)); } catch(e) {}
      return new _Worker(url, opts);
    };
    window.Worker.prototype = _Worker.prototype;
  }

  /* ── document.write / document.writeln ── */
  (function() {
    function rewriteAttr(tag, attrName) {
      var dq = new RegExp('(' + attrName + '\\s*=\\s*")([^"]+)"');
      var sq = new RegExp("(" + attrName + "\\s*=\\s*')([^']+)'");
      tag = tag.replace(dq, function(_m, attr, url) { return attr + proxify(url) + '"'; });
      tag = tag.replace(sq, function(_m, attr, url) { return attr + proxify(url) + "'"; });
      return tag;
    }
    function rewriteWritten(markup) {
      try {
        markup = markup.replace(/<script\b[^>]*>/gi, function(tag) { return rewriteAttr(tag, 'src'); });
        markup = markup.replace(/<link\b[^>]*>/gi,   function(tag) { return rewriteAttr(tag, 'href'); });
        markup = markup.replace(/(<script\b[^>]*(?:jwplayer|flowplayer|video\.js|plyr)[^>]*)\s+(?:async|defer)(\s|>)/gi, function(m, tag, trail) { return tag + trail; });
      } catch(e) {}
      return markup;
    }
    function patchWriter(method) {
      var orig = document[method].bind(document);
      document[method] = function() {
        var args = Array.prototype.slice.call(arguments).map(function(a) { return typeof a === 'string' ? rewriteWritten(a) : a; });
        return orig.apply(document, args);
      };
    }
    if (document.write) patchWriter('write');
    if (document.writeln) patchWriter('writeln');
  })();
})();`.trim();
}
