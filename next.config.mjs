const graphRuntimeData = [
  "outputs/benchmarks/**/*.json",
  "src/lib/social/targeted-evidence-current.json",
  "src/lib/social/a16z-speedrun-006-social-accounts.json",
  "src/lib/social/verified-social-overrides.json",
  "src/lib/yc/summer-2026-companies.json",
  "src/lib/yc/spring-2026-companies.json"
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
    "/api/graph/refresh": [...graphRuntimeData, "public/graph/*.json"]
  },
  outputFileTracingExcludes: {
    "/api/graph": graphTraceExcludes,
    "/api/graph/refresh": graphTraceExcludes
  }
};

export default nextConfig;
