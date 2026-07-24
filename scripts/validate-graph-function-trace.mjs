import { readFileSync, statSync } from "node:fs";
import { dirname, normalize, resolve } from "node:path";

const MEBIBYTE = 1024 * 1024;
const MAX_TRACE_BYTES = 140 * MEBIBYTE;
const routeTraces = [
  {
    label: "graph",
    manifest: ".next/server/app/api/graph/route.js.nft.json",
    forbidden: [
      `${normalize("/public/graph/")}`,
      `${normalize("/src/lib/social/public-evidence-current.json")}`,
      `${normalize("/src/lib/social/logged-in-evidence-current.json")}`
    ]
  },
  {
    label: "graph refresh",
    manifest: ".next/server/app/api/graph/refresh/route.js.nft.json",
    forbidden: [
      `${normalize("/src/lib/social/public-evidence-current.json")}`,
      `${normalize("/src/lib/social/logged-in-evidence-current.json")}`
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

  console.log(
    `${route.label} trace: ${tracedFiles.length} entries, ${(traceBytes / MEBIBYTE).toFixed(1)} MiB`
  );

  if (traceBytes > MAX_TRACE_BYTES) {
    console.error(
      `${route.label} trace exceeds the ${(MAX_TRACE_BYTES / MEBIBYTE).toFixed(0)} MiB deployment budget.`
    );
    failed = true;
  }
  if (forbiddenFiles.length) {
    console.error(
      `${route.label} trace contains oversized runtime artifacts:\n${forbiddenFiles.join("\n")}`
    );
    failed = true;
  }
}

if (failed) {
  process.exitCode = 1;
}
