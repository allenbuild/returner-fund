import { readFileSync, statSync } from "node:fs";
import { dirname, normalize, resolve } from "node:path";

const MEBIBYTE = 1024 * 1024;
const MAX_TRACE_BYTES = 140 * MEBIBYTE;
// The refresh route intentionally carries the nine static graph fallbacks.
// The 52-company S26 census expansion increases only those bounded artifacts,
// so retain a separate ceiling while staying well below the deployment limit.
const MAX_REFRESH_TRACE_BYTES = 150 * MEBIBYTE;
const routeTraces = [
  {
    label: "graph",
    manifest: ".next/server/app/api/graph/route.js.nft.json",
    maxBytes: MAX_TRACE_BYTES,
    forbidden: [
      `${normalize("/public/graph/")}`,
      `${normalize("/src/lib/social/public-evidence-current.json")}`,
      `${normalize("/src/lib/social/logged-in-evidence-current.json")}`
    ]
  },
  {
    label: "graph refresh",
    manifest: ".next/server/app/api/graph/refresh/route.js.nft.json",
    maxBytes: MAX_REFRESH_TRACE_BYTES,
    forbidden: [
      `${normalize("/src/lib/social/public-evidence-current.json")}`,
      `${normalize("/src/lib/social/logged-in-evidence-current.json")}`
    ]
  },
  {
    label: "insider recompute",
    manifest: ".next/server/app/api/insiders/recompute/route.js.nft.json",
    maxBytes: 45 * MEBIBYTE,
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
      `${normalize("/src/lib/social/targeted-evidence-current.json")}`
    ]
  }
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
  const forbiddenFiles = tracedFiles.filter((filePath) =>
    route.forbidden.some((fragment) => normalize(filePath).includes(fragment))
  );
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
      `${route.label} trace contains oversized runtime artifacts:\n${forbiddenFiles.join("\n")}`
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
