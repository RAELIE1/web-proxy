import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Intercept all requests that are NOT already going through the proxy
 * and NOT internal Next.js routes.
 *
 * When a proxied page (e.g. chess.com) loads chunks with root-relative
 * paths like `/common.xxx.chunk.js`, the browser sends the request to
 * our Next.js server instead of chess.com.  We use the `Referer` header
 * to recover which origin is being browsed and redirect the request
 * through the proxy transparently.
 */
export function middleware(request: NextRequest) {
  const { pathname, search } = new URL(request.url);

  // Always let through: proxy handler, Next.js internals, favicon
  if (
    pathname.startsWith("/proxy") ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  // ── Strategy 1: recover origin from Referer header ───────────────────────
  // Referer looks like: https://host/proxy?url=https%3A%2F%2Fchess.com%2F...
  // This catches root-relative navigations FROM proxied pages (including meta
  // refresh, JS redirects, form submits) regardless of the target pathname,
  // even "/" — which would otherwise land on our own homepage.
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      const proxiedUrl = new URL(referer).searchParams.get("url");
      if (proxiedUrl) {
        const proxiedOrigin = new URL(proxiedUrl).origin;
        const target = new URL(pathname + search, proxiedOrigin).href;
        const dest = new URL(request.url);
        dest.pathname = "/proxy";
        dest.search = "?url=" + encodeURIComponent(target);
        return NextResponse.redirect(dest, { status: 302 });
      }
    } catch { /* unparseable, fall through */ }
  }

  // ── Homepage passthrough ──────────────────────────────────────────────────
  // If no Referer pointed to a proxied page, a request for "/" is a genuine
  // user navigation to our homepage (address-bar entry, back button, etc.).
  // Let it through.  We deliberately check this AFTER the Referer strategy so
  // that a proxied page doing `location.href = "/"` (or a meta-refresh to "/")
  // still gets redirected to the upstream site's root, not our homepage.
  if (pathname === "/") {
    return NextResponse.next();
  }

  // ── Strategy 2: cookie-based fallback ────────────────────────────────────
  // The proxy route sets __proxy_origin on every response so that requests
  // arriving without a Referer (dynamic import(), web workers, importmap
  // entries, etc.) can still be redirected correctly.
  // We do NOT apply this to "/" so that a user who manually navigates to the
  // root still sees our homepage rather than an old proxied origin.
  const cookieOrigin = request.cookies.get("__proxy_origin")?.value;
  if (cookieOrigin) {
    try {
      const origin = decodeURIComponent(cookieOrigin);
      const target = new URL(pathname + search, origin).href;
      const dest = new URL(request.url);
      dest.pathname = "/proxy";
      dest.search = "?url=" + encodeURIComponent(target);
      return NextResponse.redirect(dest, { status: 302 });
    } catch { /* ignore */ }
  }

  return NextResponse.next();
}

export const config = {
  // Run on every path except static Next.js assets which are handled by the
  // static file server and never need proxying.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
