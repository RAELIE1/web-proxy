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

  // Try to recover the proxied origin from the Referer header
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      const ref = new URL(referer);
      // Referer should look like: https://host/proxy?url=https%3A%2F%2Fchess.com%2F...
      const proxiedUrl = ref.searchParams.get("url");
      if (proxiedUrl) {
        const proxiedOrigin = new URL(proxiedUrl).origin;
        // Reconstruct the full target URL: origin + our bare path + query
        const target = new URL(pathname + search, proxiedOrigin).href;
        const destination = new URL(request.url);
        destination.pathname = "/proxy";
        destination.search = "?url=" + encodeURIComponent(target);
        return NextResponse.redirect(destination, { status: 302 });
      }
    } catch {
      // Referer was unparseable – fall through and let Next.js 404 normally
    }
  }

  return NextResponse.next();
}

export const config = {
  // Run on every path except static Next.js assets which are handled by the
  // static file server and never need proxying.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
