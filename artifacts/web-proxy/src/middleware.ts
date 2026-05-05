import { NextRequest, NextResponse } from "next/server";

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

  // Always let through: homepage, proxy handler, Next.js internals, favicon
  if (
    pathname === "/" ||
    pathname.startsWith("/proxy") ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  // ── Strategy 1: recover origin from Referer header ───────────────────────
  // Referer looks like: https://host/proxy?url=https%3A%2F%2Fchess.com%2F...
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

  // ── Strategy 2: cookie-based fallback ────────────────────────────────────
  // The proxy route sets __proxy_origin on every response so that requests
  // arriving without a Referer (dynamic import(), web workers, importmap
  // entries, etc.) can still be redirected correctly.
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
