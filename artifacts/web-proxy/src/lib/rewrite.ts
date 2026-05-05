import * as cheerio from "cheerio";

export const PROXY_ROUTE = "/proxy";

/**
 * Convert any URL (relative or absolute) into a proxy URL.
 * Returns the original value untouched for non-http(s) schemes.
 */
export function makeProxyUrl(raw: string, base: string): string {
  if (!raw || raw.startsWith("data:") || raw.startsWith("blob:") || raw.startsWith("javascript:") || raw.startsWith("mailto:") || raw.startsWith("tel:") || raw.startsWith("#")) {
    return raw;
  }
  try {
    const absolute = new URL(raw, base).href;
    if (!absolute.startsWith("http://") && !absolute.startsWith("https://")) {
      return raw;
    }
    // Don't double-proxy
    if (absolute.includes(PROXY_ROUTE + "?url=")) {
      return raw;
    }
    return `${PROXY_ROUTE}?url=${encodeURIComponent(absolute)}`;
  } catch {
    return raw;
  }
}

/**
 * Rewrite all URLs in an HTML document so they route through the proxy.
 * Also injects a runtime interceptor for fetch/XHR calls.
 */
export function rewriteHtml(html: string, baseUrl: string): string {
  const $ = cheerio.load(html);

  // Remove base tag — we control all URLs ourselves
  $("base").remove();

  // Remove CSP and other blocking meta tags
  $('meta[http-equiv="Content-Security-Policy"]').remove();
  $('meta[http-equiv="X-Frame-Options"]').remove();

  // href: <a>, <link>, <area>, <use>
  $("[href]").each((_, el) => {
    const val = $(el).attr("href");
    if (val) $(el).attr("href", makeProxyUrl(val, baseUrl));
  });

  // src: <img>, <script>, <iframe>, <audio>, <video>, <source>, <track>, <embed>
  $("[src]").each((_, el) => {
    const val = $(el).attr("src");
    if (val) $(el).attr("src", makeProxyUrl(val, baseUrl));
  });

  // srcset: <img>, <source>
  $("[srcset]").each((_, el) => {
    const val = $(el).attr("srcset");
    if (val) $(el).attr("srcset", rewriteSrcset(val, baseUrl));
  });

  // action: <form>
  $("[action]").each((_, el) => {
    const val = $(el).attr("action");
    if (val) $(el).attr("action", makeProxyUrl(val, baseUrl));
  });

  // poster: <video>
  $("[poster]").each((_, el) => {
    const val = $(el).attr("poster");
    if (val) $(el).attr("poster", makeProxyUrl(val, baseUrl));
  });

  // data-src / data-href (lazy-load patterns)
  $("[data-src]").each((_, el) => {
    const val = $(el).attr("data-src");
    if (val) $(el).attr("data-src", makeProxyUrl(val, baseUrl));
  });
  $("[data-href]").each((_, el) => {
    const val = $(el).attr("data-href");
    if (val) $(el).attr("data-href", makeProxyUrl(val, baseUrl));
  });

  // Inline style attributes
  $("[style]").each((_, el) => {
    const val = $(el).attr("style");
    if (val) $(el).attr("style", rewriteCssUrls(val, baseUrl));
  });

  // <style> blocks
  $("style").each((_, el) => {
    const content = $(el).html();
    if (content) $(el).html(rewriteCssUrls(content, baseUrl));
  });

  // Inject runtime interceptor as the very first thing in <head>
  const interceptor = buildInterceptorScript(baseUrl);
  if ($("head").length) {
    $("head").prepend(`<script>${interceptor}</script>`);
  } else {
    $.root().prepend(`<script>${interceptor}</script>`);
  }

  return $.html();
}

/**
 * Rewrite url() references in CSS text.
 */
export function rewriteCssUrls(css: string, baseUrl: string): string {
  return css.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (_, quote, url: string) => {
      const rewritten = makeProxyUrl(url.trim(), baseUrl);
      return `url(${quote}${rewritten}${quote})`;
    }
  );
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
      if (spaceIdx === -1) {
        return makeProxyUrl(trimmed, baseUrl);
      }
      const url = trimmed.slice(0, spaceIdx);
      const descriptor = trimmed.slice(spaceIdx);
      return makeProxyUrl(url, baseUrl) + descriptor;
    })
    .join(", ");
}

/**
 * Build a JS snippet that intercepts runtime network calls and rewrites their URLs
 * through the proxy. Injected at the top of <head> so it runs before any other JS.
 */
function buildInterceptorScript(baseUrl: string): string {
  return `
(function() {
  var PROXY = '/proxy?url=';
  var BASE = ${JSON.stringify(baseUrl)};

  function proxify(url) {
    if (!url || typeof url !== 'string') return url;
    if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:')) return url;
    if (url.indexOf('/proxy?url=') !== -1) return url;
    try {
      var abs = new URL(url, BASE).href;
      if (abs.startsWith('http://') || abs.startsWith('https://')) {
        return PROXY + encodeURIComponent(abs);
      }
    } catch(e) {}
    return url;
  }

  /* ── fetch ── */
  var _fetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      if (typeof input === 'string') input = proxify(input);
      else if (input && input.url) input = new Request(proxify(input.url), input);
    } catch(e) {}
    return _fetch.call(this, input, init);
  };

  /* ── XMLHttpRequest ── */
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function() {
    var args = Array.prototype.slice.call(arguments);
    try { args[1] = proxify(String(args[1])); } catch(e) {}
    return _open.apply(this, args);
  };

  /* ── WebSocket (best-effort) ── */
  if (typeof WebSocket !== 'undefined') {
    var _WS = WebSocket;
    window.WebSocket = function(url, protocols) {
      /* WebSockets can't go through a simple HTTP proxy; just pass through */
      return protocols ? new _WS(url, protocols) : new _WS(url);
    };
    Object.setPrototypeOf(window.WebSocket, _WS);
  }

  /* ── history.pushState / replaceState ── */
  var _push = history.pushState.bind(history);
  history.pushState = function(state, title, url) {
    try { if (url) url = proxify(String(url)); } catch(e) {}
    return _push(state, title, url);
  };
  var _replace = history.replaceState.bind(history);
  history.replaceState = function(state, title, url) {
    try { if (url) url = proxify(String(url)); } catch(e) {}
    return _replace(state, title, url);
  };
})();
`.trim();
}
