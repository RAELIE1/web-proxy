import { NextRequest, NextResponse } from "next/server";
import { rewriteHtml, rewriteCssUrls, makeProxyUrl } from "@/lib/rewrite";
import zlib from "node:zlib";
import { promisify } from "node:util";

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const brotliDecompress = promisify(zlib.brotliDecompress);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── Pre-compiled sets — created once at module load, never recreated ───────
const BLOCKED_REQ_HEADERS = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade",
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port",
  "x-real-ip", "cf-ray", "cf-connecting-ip", "true-client-ip",
]);

const BLOCKED_RES_HEADERS = new Set([
  "content-security-policy", "content-security-policy-report-only",
  "x-frame-options", "strict-transport-security",
  "transfer-encoding", "content-encoding", "content-length", "alt-svc",
]);

const JS_PASSTHROUGH_DOMAINS = new Set([
  "pagead2.googlesyndication.com", "adservice.google.com",
  "ssl.p.jwpcdn.com", "cdn.jwplayer.com",
  "mc.yandex.ru", "mc.yandex.com", "yandex.ru",
  "cdn.jsdelivr.net", "unpkg.com",
  "highperformanceformat.com", "chagnougroalry.net",
  "adfox.yandex.ru", "ad.mail.ru",
  "challenges.cloudflare.com", "cloudflare.com",
  // ad networks on anime-sama
  "a-zzz.com", "uchaihoo.com",
  // Adcash — aclib.js must load unmodified so aclib.runBanner() works
  "acscdn.com", "aclib.net", "aclibrary.net",
]);

const JS_PASSTHROUGH_PATTERNS: RegExp[] = [
  /adsbygoogle/i, /jwplayer/i, /yandex.*metrika/i,
  /metrika.*tag/i, /adblockdetect/i, /invoke\.js/i,
  /banner\.js/i, /adfox/i, /googlesyndication/i,
  /btag/i, /aclib/i,
];

const NO_BODY_STATUSES = new Set([101, 204, 205, 304]);

// Standard UA — defined once
const PROXY_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const PROXY_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
const PROXY_ACCEPT_LANG = "en-US,en;q=0.9";

// ── Decompression ──────────────────────────────────────────────────────────
async function decompressBody(buf: Buffer, encoding: string): Promise<Buffer> {
  const enc = encoding.trim().toLowerCase();
  try {
    if (enc === "gzip" || enc === "x-gzip") return await gunzip(buf) as Buffer;
    if (enc === "deflate") return await inflate(buf) as Buffer;
    if (enc === "br" || enc === "brotli") return await brotliDecompress(buf) as Buffer;
  } catch { /* decompression failed — return raw */ }
  return buf;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function isJsPassthrough(requestUrl: string, finalUrl: string): boolean {
  for (const url of [requestUrl, finalUrl]) {
    try {
      if (JS_PASSTHROUGH_DOMAINS.has(new URL(url).hostname)) return true;
    } catch { /* ignore */ }
    if (JS_PASSTHROUGH_PATTERNS.some(p => p.test(url))) return true;
  }
  return false;
}

function parseTargetUrl(request: NextRequest): URL | null {
  const raw = new URL(request.url).searchParams.get("url");
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed : null;
  } catch { return null; }
}

// ── Error page (HTML template literal — built on demand, not cached) ───────
function errorPage(status: number, title: string, description: string, targetUrl: string): NextResponse {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${status} — ${title}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f1117;color:#e8eaf0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem;text-align:center}
    .wrap{display:flex;flex-direction:column;gap:1rem;align-items:center}
    .code{font-size:4rem;font-weight:700;color:#6c63ff}
    .title{font-size:1.25rem;font-weight:600}
    .desc{color:#8b8fa8;max-width:400px;line-height:1.6;font-size:.9rem}
    a{color:#6c63ff;text-decoration:none;font-weight:500;margin-top:.5rem;display:inline-block}
    a:hover{text-decoration:underline}
    pre{background:#1a1d27;border:1px solid #2e3147;border-radius:8px;padding:.75rem 1rem;font-size:.75rem;color:#8b8fa8;max-width:500px;overflow:auto;text-align:left;margin-top:.5rem}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="code">${status}</div>
    <div class="title">${title}</div>
    <div class="desc">${description}</div>
    <pre>${targetUrl}</pre>
    <a href="/">← Back to proxy home</a>
  </div>
</body>
</html>`;
  return new NextResponse(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

// ── Core proxy handler ────────────────────────────────────────────────────
async function handleProxy(request: NextRequest): Promise<NextResponse> {
  try {
    return await _handleProxy(request);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[proxy] unhandled error:", msg);
    return errorPage(500, "Proxy Error", msg, request.url);
  }
}

async function _handleProxy(request: NextRequest): Promise<NextResponse> {
  const target = parseTargetUrl(request);
  if (!target) {
    return NextResponse.json({ error: "Missing or invalid `url` query parameter." }, { status: 400 });
  }

  // Block self-referential requests
  if (target.hostname === "localhost" || target.hostname === "127.0.0.1") {
    const isJs = (request.headers.get("accept") ?? "").includes("javascript") || target.pathname.endsWith(".js");
    return new NextResponse(
      isJs ? "/* proxy: self-referential JS request blocked */" : "",
      {
        status: 200,
        headers: {
          "content-type": isJs ? "text/javascript; charset=utf-8" : "text/plain",
          "access-control-allow-origin": "*",
        },
      }
    );
  }

  // ── Build outgoing request headers ────────────────────────────────────
  const reqHeaders = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (!BLOCKED_REQ_HEADERS.has(key.toLowerCase())) reqHeaders.set(key, value);
  }

  reqHeaders.set("host", target.host);
  reqHeaders.set("user-agent", PROXY_UA);
  reqHeaders.set("accept-encoding", "identity");
  if (!reqHeaders.has("accept")) reqHeaders.set("accept", PROXY_ACCEPT);
  if (!reqHeaders.has("accept-language")) reqHeaders.set("accept-language", PROXY_ACCEPT_LANG);

  // Strip ALL sec-fetch-* headers — we'll set only what's needed.
  // Sending sec-fetch-dest: script can trigger bot-detection on some servers
  // (confirmed: anime-sama returns HTML when this header is present from a
  // non-browser IP, but serves JS fine to curl which sends no sec-fetch-*).
  reqHeaders.delete("sec-fetch-dest");
  reqHeaders.delete("sec-fetch-mode");
  reqHeaders.delete("sec-fetch-site");
  reqHeaders.delete("sec-fetch-user");

  // Rewrite Referer / Origin to avoid WAF detection
  const rawReferer = request.headers.get("referer");
  if (rawReferer) {
    try {
      const proxiedUrl = new URL(rawReferer).searchParams.get("url");
      reqHeaders.set("referer", proxiedUrl ? proxiedUrl : target.origin + "/");
    } catch { reqHeaders.delete("referer"); }
  }
  if (reqHeaders.has("origin")) reqHeaders.set("origin", target.origin);

  // Body for non-GET/HEAD
  let body: ArrayBuffer | undefined;
  if (!["GET", "HEAD"].includes(request.method)) body = await request.arrayBuffer();

  // ── Fetch upstream ────────────────────────────────────────────────────
  let res: Response;
  try {
    res = await fetch(target.href, {
      method: request.method,
      headers: reqHeaders,
      body: body ?? null,
      redirect: "follow",
      signal: AbortSignal.timeout(25_000),
      // @ts-expect-error Node-specific
      compress: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown fetch error";
    return errorPage(502, "Upstream Error", `Could not reach ${target.origin}: ${message}`, target.href);
  }

  // No-body responses
  if (NO_BODY_STATUSES.has(res.status) || res.status < 200) {
    const resHeaders = buildResHeaders(res, []);
    return new NextResponse(null, { status: res.status, headers: resHeaders });
  }

  // Decompress body
  const rawEncoding = res.headers.get("content-encoding") ?? "";
  const rawBuf = Buffer.from(await res.arrayBuffer());
  const bodyBuf = rawEncoding ? await decompressBody(rawBuf, rawEncoding) : rawBuf;

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const finalUrl = res.url || target.href;
  const cookies = res.headers.getSetCookie?.() ?? [];
  const resHeaders = buildResHeaders(res, cookies);

  // Store proxy origin cookie for middleware fallback
  try {
    const proxiedOrigin = new URL(finalUrl).origin;
    resHeaders.append("set-cookie", `__proxy_origin=${encodeURIComponent(proxiedOrigin)}; Path=/; SameSite=Lax`);
  } catch { /* ignore */ }

  // ── Content-type routing ───────────────────────────────────────────────

  // If the upstream returned HTML but the client expected a script (e.g. the
  // upstream sent a bot-check/error page for episodes.js), serve an empty JS
  // comment instead of the HTML.  Without this, Next.js adds
  // x-content-type-options: nosniff and the browser blocks it with
  // NS_ERROR_CORRUPTED_CONTENT.
  const requestedAsJs =
    target.pathname.endsWith(".js") ||
    target.pathname.endsWith(".mjs") ||
    (request.headers.get("accept") ?? "").includes("javascript");

  if (contentType.includes("text/html") && requestedAsJs) {
    resHeaders.set("content-type", "text/javascript; charset=utf-8");
    return new NextResponse("/* proxy: upstream returned HTML for JS request */", {
      status: 200,
      headers: resHeaders,
    });
  }

  if (contentType.includes("text/html")) {
    const rewritten = rewriteHtml(bodyBuf.toString("utf-8"), finalUrl);
    resHeaders.set("content-type", "text/html; charset=utf-8");
    return new NextResponse(rewritten, { status: res.status, headers: resHeaders });
  }

  if (contentType.includes("text/css")) {
    const rewritten = rewriteCssUrls(bodyBuf.toString("utf-8"), finalUrl);
    resHeaders.set("content-type", contentType);
    return new NextResponse(rewritten, { status: res.status, headers: resHeaders });
  }

  if (
    contentType.includes("javascript") ||
    contentType.includes("application/x-javascript") ||
    contentType.includes("application/ecmascript")
  ) {
    const raw = bodyBuf.toString("utf-8");

    // Upstream returned HTML for a JS request (bot-check / error page)
    if (raw.trimStart().startsWith("<")) {
      resHeaders.set("content-type", "text/javascript; charset=utf-8");
      return new NextResponse("/* proxy: upstream returned non-JS */", { status: 200, headers: resHeaders });
    }

    if (isJsPassthrough(target.href, finalUrl)) {
      resHeaders.set("content-type", "text/javascript; charset=utf-8");
      return new NextResponse(raw, { status: res.status, headers: resHeaders });
    }

    let js = raw;

    // Fix import.meta.url for Vite/Rolldown chunk resolution
    if (js.includes("import.meta.url")) {
      const imuVar = "__proxy_imu__";
      if (!js.includes(`var ${imuVar}`)) {
        js = `;var ${imuVar}=${JSON.stringify(finalUrl)};\n` + js;
      }
      js = js.replace(/\bimport\.meta\.url\b/g, imuVar);
    }

    // Patch webpack/vite public path globals
    if (js.includes("__webpack_public_path__") || js.includes("__vite_public_path__")) {
      js = js.replace(
        /\b(__webpack_public_path__|__vite_public_path__)\s*=\s*(['"`])([^'"`]*)\2/g,
        (match, varName, _quote, path) => {
          try { return `${varName}=${JSON.stringify(new URL(path || "/", finalUrl).href)}`; }
          catch { return match; }
        }
      );
    }

    resHeaders.set("content-type", "text/javascript; charset=utf-8");
    return new NextResponse(js, { status: res.status, headers: resHeaders });
  }

  // Binary / everything else — return decompressed buffer directly
  // .slice() always returns a concrete ArrayBuffer (never SharedArrayBuffer), satisfying BodyInit.
  const ab = bodyBuf.buffer.slice(bodyBuf.byteOffset, bodyBuf.byteOffset + bodyBuf.byteLength) as ArrayBuffer;
  return new NextResponse(ab, { status: res.status, headers: resHeaders });
}

/**
 * Build the outgoing response headers, stripping blocked ones and cleaning cookies.
 * Extracted to avoid code duplication between the no-body and body paths.
 */
function buildResHeaders(res: Response, cookies: string[]): Headers {
  const resHeaders = new Headers();
  for (const [key, value] of res.headers.entries()) {
    const lk = key.toLowerCase();
    if (!BLOCKED_RES_HEADERS.has(lk) && lk !== "content-length") resHeaders.set(key, value);
  }
  for (const cookie of cookies) {
    const cleaned = cookie
      .replace(/;\s*domain=[^;]*/gi, "")
      .replace(/;\s*secure/gi, "")
      .replace(/;\s*samesite=[^;]*/gi, "");
    resHeaders.append("set-cookie", cleaned);
  }
  resHeaders.set("access-control-allow-origin", "*");
  resHeaders.delete("x-frame-options");
  resHeaders.set("cache-control", "no-store, no-cache, must-revalidate");
  resHeaders.delete("etag");
  resHeaders.delete("last-modified");
  return resHeaders;
}

// ── Export all HTTP methods ────────────────────────────────────────────────
export async function GET(req: NextRequest)     { return handleProxy(req); }
export async function POST(req: NextRequest)    { return handleProxy(req); }
export async function PUT(req: NextRequest)     { return handleProxy(req); }
export async function PATCH(req: NextRequest)   { return handleProxy(req); }
export async function DELETE(req: NextRequest)  { return handleProxy(req); }
export async function HEAD(req: NextRequest)    { return handleProxy(req); }
export async function OPTIONS(req: NextRequest) { return handleProxy(req); }
