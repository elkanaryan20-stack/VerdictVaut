/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Phase 39 — found serving the production standalone build: every response
  // advertised "X-Powered-By: Next.js". No functional use; only fingerprints
  // the framework for anyone probing the site.
  poweredByHeader: false,
  transpilePackages: ["@verdictvaut/shared-types"],
  // Phase 15 — needed for apps/web/Dockerfile's minimal runtime image
  // (traces only the production dependency subset into .next/standalone).
  // Purely a build-output layout change; no runtime behavior difference.
  output: "standalone",
};

export default nextConfig;
