import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

/** Response headers applied to every page render, built fresh per request because of the nonce. */
function securityHeaders(nonce: string): Record<string, string> {
  // React needs eval in development for readable server error stacks; production never does.
  const evaluation = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      // strict-dynamic lets the nonce cover every chunk Next injects during render.
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${evaluation}`,
      // Inline style attributes render progress bars and similar; styling is not code execution.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join("; "),
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
}

export function proxy(request: NextRequest) {
  const nonce = randomUUID().replace(/-/g, "");
  const requestHeaders = new Headers(request.headers);
  // Next.js extracts the nonce from the request CSP and applies it to the framework's own
  // scripts; the app reads x-nonce for the theme bootstrap script. No upgrade-insecure-requests:
  // self-hosted plain-http installs must keep loading same-origin media.
  for (const [key, value] of Object.entries(securityHeaders(nonce))) requestHeaders.set(key, value);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [key, value] of Object.entries(securityHeaders(nonce))) response.headers.set(key, value);
  return response;
}

export const config = {
  matcher: [{
    // Matches pages and server actions; API responses set their own headers and
    // _next/static plus _next/image never carry executable page context.
    source: "/((?!api|_next/static|_next/image|favicon.ico|icon.svg|robots.txt|sitemap.xml).*)",
    missing: [
      { type: "header", key: "next-router-prefetch" },
      { type: "header", key: "purpose", value: "prefetch" },
    ],
  }],
};
