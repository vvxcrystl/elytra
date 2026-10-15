import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Lets a phone on the LAN or tailnet load the dev server's JS; without it the page renders but never hydrates.
  allowedDevOrigins: ["10.0.0.192", "100.110.0.109"],
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
