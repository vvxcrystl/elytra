import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Lets a phone on the LAN or tailnet load the dev server's JS; without it the page renders but never hydrates.
  allowedDevOrigins: ["10.0.0.192", "100.110.0.109"],
  typescript: {
    // scripts/build.mjs sets this only after route generation and Rust checking pass.
    // Running next build directly still uses Next's built-in TypeScript check.
    ignoreBuildErrors: process.env.ELYTRA_RUST_TYPECHECKED === "1",
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "21mb",
    },
  },
  turbopack: {
    root: import.meta.dirname,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
