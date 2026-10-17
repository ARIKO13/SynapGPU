import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Proxy /socket.io/ requests directly to the bun metrics service on port
  // 3003. This is the robust path — we don't depend on the external preview
  // gateway preserving the ?XTransformPort=3003 query param that Caddy uses
  // to route. Next.js itself handles the proxy, so the socket.io client just
  // talks to its own origin and gets transparently forwarded to the bun
  // service. Both polling and WebSocket upgrades work via this rewrite.
  async rewrites() {
    return [
      {
        source: "/socket.io/:path*",
        destination: "http://localhost:3003/socket.io/:path*",
      },
    ];
  },
  // Allow the preview gateway (preview-*.space-z.ai) to talk to the Next.js
  // dev server for HMR. Without this, Next.js 16 refuses to push HMR updates
  // to the cross-origin preview iframe, so the user never sees code changes
  // until they manually hard-refresh.
  allowedDevOrigins: [
    "*.space-z.ai",
    "localhost:3000",
    "127.0.0.1:3000",
  ],
};

export default nextConfig;

