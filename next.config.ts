import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Allow the preview gateway (preview-*.space-z.ai) to talk to the Next.js
  // dev server. Without this, Next.js 16 refuses to push HMR updates to the
  // cross-origin preview iframe, so the user never sees code changes until
  // they manually hard-refresh. Listing the wildcard pattern lets all the
  // preview subdomains work — they're all trusted gateways in this sandbox.
  allowedDevOrigins: [
    "*.space-z.ai",
    "localhost:3000",
    "127.0.0.1:3000",
  ],
};

export default nextConfig;
