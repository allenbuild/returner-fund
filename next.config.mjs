const graphRuntimeData = [
  "outputs/benchmarks/**/*.json",
  "public/graph/**/*.json",
  "src/lib/social/**/*.json",
  "src/lib/yc/**/*.json"
];

const graphTraceExcludes = [
  ".git/**/*",
  ".github/**/*",
  "docs/**/*",
  "outputs/*.*",
  "outputs/attribution-feedback-loop/**/*",
  "outputs/final-verification-process/**/*",
  "outputs/longrun/**/*",
  "outputs/source-hunt/**/*",
  "public/brand/**/*",
  "public/evidence-thumbnails/**/*",
  "scripts/**/*",
  "src/**/*.{css,ts,tsx}",
  "supabase/**/*",
  "tests/**/*",
  "work/**/*",
  ".gitignore",
  "README.md",
  "next.config.mjs",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.tsbuildinfo",
  "vercel.json",
  "vitest.config.ts"
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  typedRoutes: true,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  outputFileTracingIncludes: {
    "/api/graph": graphRuntimeData,
    "/api/graph/refresh": graphRuntimeData
  },
  outputFileTracingExcludes: {
    "/api/graph": graphTraceExcludes,
    "/api/graph/refresh": graphTraceExcludes
  }
};

export default nextConfig;
