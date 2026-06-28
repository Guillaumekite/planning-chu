import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep native/WASM server packages out of the bundler so they load correctly at runtime.
  serverExternalPackages: ['glpk.js', 'postgres', '@electric-sql/pglite'],
};

export default nextConfig;
