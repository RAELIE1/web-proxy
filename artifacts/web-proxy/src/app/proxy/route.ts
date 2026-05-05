import { NextRequest, NextResponse } from "next/server";
import { rewriteHtml, rewriteCssUrls, makeProxyUrl } from "@/lib/rewrite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Headers we strip from the outgoing request to the target
const BLOCKED_REQ_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "cf-ray",
  "cf-connecting-ip",
  "true-client-ip",
]);

// Headers we strip from the proxied response before sending to the browser
const BLOCKED_RES_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "strict-transport-security",
  "transfer-encoding",
  "content-encoding", // We fully decode before rewriting
  "alt-svc",
]);

function parseTargetUrl(request: NextRequest): URL | null {
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get("url");
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function handleProxy(request: NextRequest): Promise<NextResponse> {
  const target = parseTargetUrl(request);

  if (!target) {
    return NextResponse.json(
      { error: "Missing or invalid `url` query parameter." },
      { status: 400 }
    );
  }

  // Build forwarded request headers
  const reqHeaders = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (!BLOCKED_REQ_HEADERS.has(key.toLowerCase())) {
      reqHeaders.set(key, value);
    }
  }
  // Set the correct Host for the target origin
  reqHeaders.set("host", target.host);
  // Pretend to be a normal browser
  if (!reqHeaders.has("user-agent")) {
    reqHeaders.set(
      "user-agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
  }
  reqHeaders.set("accept-encoding", "identity"); // Prevent compressed responses we can't easily decode

  // Body for non-GET/HEAD requests
  let body: ArrayBuffer | undefined;
  if (!["GET", "HEAD"].includes(request.method)) {
    body = await request.arrayBuffer();
  }

  let res: Response;
  try {
    res = await fetch(target.href, {
      method: request.method,
      headers: reqHeaders,
      body: body ?? null,
      redirect: "follow", // Next.js/Node fetch follows redirects and we get the final URL via res.url
      signal: AbortSignal.timeout(25_000),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown fetch error";
    return errorPage(
      502,
      "Upstream Error",
      `Could not reach ${target.origin}: ${message}`,
      target.href
    );
  }

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const finalUrl = res.url || target.href; // After redirects

  // Build response headers
  const resHeaders = new Headers();
  for (const [key, value] of res.headers.entries()) {
    if (!BLOCKED_RES_HEADERS.has(key.toLowerCase())) {
      resHeaders.set(key, value);
    }
  }

  // Rewrite Set-Cookie domain so cookies work
  const cookies = res.headers.getSetCookie?.() ?? [];
  for (const cookie of cookies) {
    const cleaned = cookie
      .replace(/;\s*domain=[^;]*/gi, "")
      .replace(/;\s*secure/gi, "")
      .replace(/;\s*samesite=[^;]*/gi, "");
    resHeaders.append("set-cookie", cleaned);
  }

  // Open up for embedding
  resHeaders.set("access-control-allow-origin", "*");
  resHeaders.delete("x-frame-options");

  // ── No-body statuses (1xx, 204, 304) ─────────────────────────────────────
  // The HTTP spec forbids a message body for these; NextResponse throws if you pass one.
  const NO_BODY_STATUSES = new Set([101, 204, 205, 304]);
  if (NO_BODY_STATUSES.has(res.status) || res.status < 200) {
    return new NextResponse(null, { status: res.status, headers: resHeaders });
  }

  // ── HTML ──────────────────────────────────────────────────────────────────
  if (contentType.includes("text/html")) {
    const html = await res.text();
    const rewritten = rewriteHtml(html, finalUrl);
    resHeaders.set("content-type", "text/html; charset=utf-8");
    return new NextResponse(rewritten, {
      status: res.status,
      headers: resHeaders,
    });
  }

  // ── CSS ───────────────────────────────────────────────────────────────────
  if (contentType.includes("text/css")) {
    const css = await res.text();
    const rewritten = rewriteCssUrls(css, finalUrl);
    resHeaders.set("content-type", contentType);
    return new NextResponse(rewritten, {
      status: res.status,
      headers: resHeaders,
    });
  }

  // ── JavaScript ────────────────────────────────────────────────────────────
  // We pass JS through as-is. Rewriting JS statically is complex and error-prone;
  // the injected runtime interceptor handles dynamic URL calls instead.
  if (
    contentType.includes("javascript") ||
    contentType.includes("application/x-javascript") ||
    contentType.includes("application/ecmascript")
  ) {
    const js = await res.arrayBuffer();
    return new NextResponse(js, { status: res.status, headers: resHeaders });
  }

  // ── JSON / XML / SVG (text-based) ─────────────────────────────────────────
  if (
    contentType.includes("application/json") ||
    contentType.includes("application/xml") ||
    contentType.includes("text/xml") ||
    contentType.includes("image/svg+xml")
  ) {
    const text = await res.arrayBuffer();
    return new NextResponse(text, { status: res.status, headers: resHeaders });
  }

  // ── Binary (images, fonts, audio, video, wasm, etc.) ─────────────────────
  const binary = await res.arrayBuffer();
  return new NextResponse(binary, { status: res.status, headers: resHeaders });
}

function errorPage(
  status: number,
  title: string,
  description: string,
  targetUrl: string
): NextResponse {
  const proxyHome = makeProxyUrl(targetUrl, targetUrl); // just for display
  void proxyHome; // unused

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
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

  return new NextResponse(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export async function GET(request: NextRequest) {
  return handleProxy(request);
}

export async function POST(request: NextRequest) {
  return handleProxy(request);
}

export async function PUT(request: NextRequest) {
  return handleProxy(request);
}

export async function PATCH(request: NextRequest) {
  return handleProxy(request);
}

export async function DELETE(request: NextRequest) {
  return handleProxy(request);
}

export async function HEAD(request: NextRequest) {
  return handleProxy(request);
}

export async function OPTIONS(request: NextRequest) {
  return handleProxy(request);
}
