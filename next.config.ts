import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The demo video is recorded from `next dev`: keep the floating "N" badge out of frame.
  // Compile and runtime errors are still shown.
  devIndicators: false,
  // cacheComponents is off: pages read SQLite synchronously and the layout reads
  // the view-as cookie, so every page renders per request without Suspense plumbing.
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
