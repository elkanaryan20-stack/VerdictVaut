/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@verdictvaut/shared-types"],
  // Phase 15 — needed for apps/web/Dockerfile's minimal runtime image
  // (traces only the production dependency subset into .next/standalone).
  // Purely a build-output layout change; no runtime behavior difference.
  output: "standalone",
};

export default nextConfig;
