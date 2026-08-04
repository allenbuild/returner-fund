import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";

const MEBIBYTE = 1024 * 1024;
// The protected release now carries the complete refreshed 1,297-entity
// catalog and its reconciled evidence projection. Keep headroom above the
// measured graph trace without permitting repository-wide data leakage.
const MAX_TRACE_BYTES = 75 * MEBIBYTE;
const MAX_FULL_GRAPH_TRACE_BYTES = 140 * MEBIBYTE;
// Vercel traces both the glibc and musl Sharp binary families for these
// server-rendered debug pages, while local macOS builds trace one native
// family. Keep a route-specific ceiling with headroom for that platform delta.
const MAX_DEBUG_TRACE_BYTES = 100 * MEBIBYTE;
// The refresh route intentionally carries the nine static graph fallbacks.
// The 52-company S26 census expansion increases only those bounded artifacts,
// so retain a separate ceiling while staying well below the deployment limit.
const MAX_REFRESH_TRACE_BYTES = 150 * MEBIBYTE;
const REPOSITORY_ROOT = resolve(".");
const GRAPH_RUNTIME_PROJECTIONS = [
  "generated-runtime/graph/public-evidence-current.json",
  "generated-runtime/graph/logged-in-evidence-current.json",
  "generated-runtime/graph/targeted-evidence-current.json"
];
const WHOLE_REPOSITORY_TRACE_FRAGMENTS = [
  `${normalize("/artifacts/")}`,
  `${normalize("/docs/")}`,
  `${normalize("/public/timelines/")}`,
  `${normalize("/scripts/")}`,
  `${normalize("/supabase/")}`,
  `${normalize("/tests/")}`,
  `${normalize("/work/")}`,
  `${normalize("/next.config.mjs")}`
];
const RAW_EVIDENCE_FRAGMENTS = [
  `${normalize("/src/lib/social/public-evidence-current.json")}`,
  `${normalize("/src/lib/social/logged-in-evidence-current.json")}`,
  `${normalize("/src/lib/social/targeted-evidence-current.json")}`
];
const UNSUPPORTED_DEBUG_NATIVE_FRAGMENTS = [
  `${normalize("/node_modules/@img/sharp-libvips-linuxmusl-arm64/")}`,
  `${normalize("/node_modules/@img/sharp-libvips-linuxmusl-x64/")}`,
  `${normalize("/node_modules/@img/sharp-linuxmusl-arm64/")}`,
  `${normalize("/node_modules/@img/sharp-linuxmusl-x64/")}`
];
const debugRouteTraces = [
  "duplicates",
  "evidence",
  "instagram-coverage",
  "scoring",
  "thumbnails",
  "workers"
].map((route) => ({
  label: `debug ${route}`,
  manifest: `.next/server/app/debug/${route}/page.js.nft.json`,
  maxBytes: MAX_DEBUG_TRACE_BYTES,
  required: GRAPH_RUNTIME_PROJECTIONS,
  forbidden: [
    ...WHOLE_REPOSITORY_TRACE_FRAGMENTS,
    ...RAW_EVIDENCE_FRAGMENTS,
    ...UNSUPPORTED_DEBUG_NATIVE_FRAGMENTS
  ]
}));
const routeTraces = [
  {
    label: "graph",
    manifest: ".next/server/app/api/graph/route.js.nft.json",
    maxBytes: MAX_TRACE_BYTES,
    required: [
      "public/graph/s2026.json",
      "public/graph/s2026-yc-partners.json",
      "public/graph/s2026-insiders.json",
      "public/graph/s26.json",
      "public/graph/s26-yc-partners.json",
      "public/graph/s26-insiders.json",
      "public/graph/a16zsr006.json",
      "public/graph/a16zsr006-yc-partners.json",
      "public/graph/a16zsr006-insiders.json"
    ],
    forbidden: [
      `${normalize("/src/lib/social/public-evidence-current.json")}`,
      `${normalize("/src/lib/social/logged-in-evidence-current.json")}`,
      `${normalize("/src/lib/social/targeted-evidence-current.json")}`
    ]
  },
  {
    label: "full graph diagnostics",
    manifest: ".next/server/app/api/graph/full/route.js.nft.json",
    maxBytes: MAX_FULL_GRAPH_TRACE_BYTES,
    required: GRAPH_RUNTIME_PROJECTIONS,
    forbidden: [
      `${normalize("/public/graph/")}`,
      ...WHOLE_REPOSITORY_TRACE_FRAGMENTS,
      ...RAW_EVIDENCE_FRAGMENTS
    ]
  },
  {
    label: "graph refresh",
    manifest: ".next/server/app/api/graph/refresh/route.js.nft.json",
    maxBytes: MAX_REFRESH_TRACE_BYTES,
    required: GRAPH_RUNTIME_PROJECTIONS,
    forbidden: [
      ...WHOLE_REPOSITORY_TRACE_FRAGMENTS,
      ...RAW_EVIDENCE_FRAGMENTS
    ]
  },
  {
    label: "insider recompute",
    manifest: ".next/server/app/api/insiders/recompute/route.js.nft.json",
    maxBytes: 70 * MEBIBYTE,
    required: [
      "public/graph/s2026.json",
      "public/graph/s2026-insiders.json",
      "public/graph/s26.json",
      "public/graph/s26-insiders.json",
      "public/graph/a16zsr006.json",
      "public/graph/a16zsr006-insiders.json"
    ],
    forbidden: [
      `${normalize("/src/lib/social/public-evidence-current.json")}`,
      `${normalize("/src/lib/social/logged-in-evidence-current.json")}`,
      `${normalize("/src/lib/social/targeted-evidence-current.json")}`,
      `${normalize("/public/graph/s2026-yc-partners.json")}`,
      `${normalize("/public/graph/s26-yc-partners.json")}`,
      `${normalize("/public/graph/a16zsr006-yc-partners.json")}`,
      `${normalize("/public/graph/manifest.json")}`
    ]
  },
  {
    label: "admin ingestion diagnostics",
    manifest: ".next/server/app/api/admin/ingestion/route.js.nft.json",
    maxBytes: 12 * MEBIBYTE,
    required: [],
    forbidden: [
      ...WHOLE_REPOSITORY_TRACE_FRAGMENTS,
      ...RAW_EVIDENCE_FRAGMENTS,
      `${normalize("/generated-runtime/")}`,
      `${normalize("/outputs/")}`,
      `${normalize("/public/graph/")}`
    ]
  },
  ...debugRouteTraces
];

let failed = false;

for (const route of routeTraces) {
  const manifestPath = resolve(route.manifest);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const tracedFiles = [...new Set(
    manifest.files.map((entry) => resolve(dirname(manifestPath), entry))
  )];
  const traceBytes = tracedFiles.reduce((total, filePath) => {
    try {
      const file = statSync(filePath);
      return file.isFile() ? total + file.size : total;
    } catch {
      return total;
    }
  }, 0);
  const forbiddenFiles = tracedFiles.filter((filePath) => {
    const policyPath = repositoryRelativePolicyPath(filePath);
    return policyPath !== null && route.forbidden.some((fragment) => matchesRepositoryPolicy(policyPath, fragment));
  });
  const missingRequiredFiles = (route.required ?? []).filter((requiredPath) => {
    const resolvedRequiredPath = normalize(resolve(requiredPath));
    return !tracedFiles.some(
      (filePath) => normalize(filePath) === resolvedRequiredPath
    );
  });

  console.log(
    `${route.label} trace: ${tracedFiles.length} entries, ${(traceBytes / MEBIBYTE).toFixed(1)} MiB`
  );

  if (traceBytes > route.maxBytes) {
    console.error(
      `${route.label} trace exceeds the ${(route.maxBytes / MEBIBYTE).toFixed(0)} MiB deployment budget.`
    );
    failed = true;
  }
  if (forbiddenFiles.length) {
    console.error(
      `${route.label} trace contains forbidden runtime artifacts:\n${forbiddenFiles.join("\n")}`
    );
    failed = true;
  }
  if (missingRequiredFiles.length) {
    console.error(
      `${route.label} trace is missing required runtime snapshots:\n${missingRequiredFiles.join("\n")}`
    );
    failed = true;
  }
}

if (failed) {
  process.exitCode = 1;
}

function repositoryRelativePolicyPath(filePath) {
  const relativePath = relative(REPOSITORY_ROOT, filePath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return null;
  }
  return normalize(`/${relativePath}`);
}

function matchesRepositoryPolicy(policyPath, fragment) {
  const normalizedFragment = normalize(fragment);
  if (!normalizedFragment.endsWith(sep)) {
    return policyPath === normalizedFragment;
  }
  const directoryPath = normalizedFragment.slice(0, -sep.length);
  return policyPath === directoryPath || policyPath.startsWith(`${directoryPath}${sep}`);
}
