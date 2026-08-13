import path from "node:path";

const SAFE_EXACT_PATHS = new Set([
  "artifacts/company-timeline/coverage.json",
  "artifacts/company-timeline/public-discovery-current.json",
  "artifacts/scoring-v5/generated/candidate-search.json",
  "artifacts/scoring-v5/generated/canonical-dataset.json",
  "artifacts/scoring-v5/generated/evaluation.json",
  "artifacts/scoring-v5/generated/export-manifest.json",
  "artifacts/scoring-v5/generated/model.json",
  "artifacts/scoring-v5/generated/reproducibility.json",
  "artifacts/scoring-v5/generated/split-manifest.json",
  "docs/outputs/scoring-diagnostics-v4-audit.json",
  "docs/outputs/scoring-diagnostics-v4-report.md",
  "outputs/cohort-coverage-current.json",
  "outputs/discovery-attempts-current.json",
  "outputs/ingestion-source-delta-current.json",
  "outputs/ingestion-source-delta-history.json",
  "outputs/benchmarks/daily-publication-receipt.json",
  "outputs/public-ingestion-operational-ledger-current.json",
  "outputs/public-ingestion-review-ledger-current.json",
  "outputs/source-discovery-paths-current.json",
  "public/graph/manifest.json",
  "public/timelines/coverage.json",
  "src/lib/graph/ranked-posts-sidecar.generated.json",
  "src/lib/social/github-traction-a16z-speedrun-006.json",
  "src/lib/social/github-traction-quarantine.json",
  "src/lib/social/github-traction-summer-2026.json",
  "src/lib/social/github-traction.json",
  "src/lib/social/logged-in-evidence-current.json",
  "src/lib/social/public-evidence-current.json",
  "src/lib/social/targeted-evidence-current.json",
  "src/lib/yc/summer-2026-companies.json",
  "src/lib/yc/summer-2026-company-aliases.json"
]);

const SAFE_GENERATED_PATH_PATTERNS = Object.freeze([
  /^outputs\/benchmarks\/(?:a16zsr006|s2025|s2026|s26|w2026)-score-benchmarks\.json$/,
  /^public\/graph\/(?:a16zsr006|s2026|s26)(?:-(?:insiders|yc-partners))?\.json$/,
  /^public\/timelines\/companies\/[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?\.json$/,
  /^public\/timelines\/events\/tle-[0-9a-f]{24}\.json$/,
  /^public\/topic-facets\/(?:a16zsr006|s2026|s26)\.json$/
]);

const POLICY_OR_CONFIG_JSON_PATH =
  /(?:^|\/)(?:package(?:-lock)?|npm-shrinkwrap|tsconfig(?:\.[^/]+)?|jsconfig|deno|bunfig|[^/]*(?:config|policy|settings))\.json$/i;

export function normalizeTrackedRepositoryPath(value) {
  const normalized = String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    path.posix.normalize(normalized) !== normalized
  ) {
    throw new Error(`Unsafe tracked repository path: ${String(value)}`);
  }
  return normalized;
}

export function isReplaySafePublicationDataPath(value) {
  const filePath = normalizeTrackedRepositoryPath(value);
  if (POLICY_OR_CONFIG_JSON_PATH.test(filePath)) return false;
  if (SAFE_EXACT_PATHS.has(filePath)) return true;
  return SAFE_GENERATED_PATH_PATTERNS.some((pattern) => pattern.test(filePath));
}

export function assertReplaySafePublicationChanges(changedPaths, { label = "publication base" } = {}) {
  const unsafe = [...new Set(changedPaths.map(normalizeTrackedRepositoryPath))]
    .filter((filePath) => !isReplaySafePublicationDataPath(filePath))
    .sort();
  if (unsafe.length > 0) {
    throw new Error(
      `${label} contains executable, policy, dependency, or non-allowlisted drift: ${unsafe.join(", ")}`
    );
  }
  return true;
}

export function isProtectedSourcePolicyPath(value) {
  const filePath = normalizeTrackedRepositoryPath(value);
  if (filePath.startsWith("scripts/")) return true;
  if (filePath.startsWith("src/")) return !isReplaySafePublicationDataPath(filePath);
  if (filePath.startsWith(".github/")) return true;
  if (filePath.startsWith("supabase/")) return true;
  if (/^(?:package(?:-lock)?|npm-shrinkwrap|pnpm-lock|yarn\.lock)/.test(filePath)) return true;
  if (/^(?:next|eslint|vitest|playwright|postcss|tailwind|tsconfig)(?:\.|-)/.test(filePath)) return true;
  return new Set([
    ".node-version",
    ".nvmrc",
    "Dockerfile",
    "middleware.ts",
    "vercel.json"
  ]).has(filePath);
}
