import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const validatorPath = join(process.cwd(), "scripts/validate-graph-function-trace.mjs");
const graphRuntimeProjections = [
  "generated-runtime/graph/public-evidence-current.json.gz",
  "generated-runtime/graph/logged-in-evidence-current.json.gz",
  "generated-runtime/graph/targeted-evidence-current.json.gz",
  "generated-runtime/graph/volume-evidence-current.json.gz"
];
const publishedGraphSnapshots = [
  "generated-runtime/published-graph/s2026.json.gz",
  "generated-runtime/published-graph/s2026-yc-partners.json.gz",
  "generated-runtime/published-graph/s2026-insiders.json.gz",
  "generated-runtime/published-graph/s26.json.gz",
  "generated-runtime/published-graph/f26.json.gz",
  "generated-runtime/published-graph/s26-yc-partners.json.gz",
  "generated-runtime/published-graph/f26-yc-partners.json.gz",
  "generated-runtime/published-graph/s26-insiders.json.gz",
  "generated-runtime/published-graph/f26-insiders.json.gz",
  "generated-runtime/published-graph/a16zsr006.json.gz",
  "generated-runtime/published-graph/a16zsr006-yc-partners.json.gz",
  "generated-runtime/published-graph/a16zsr006-insiders.json.gz"
];
const returnerFundApiSnapshots = [
  "generated-runtime/published-graph/s2026.json.gz",
  "generated-runtime/published-graph/s26.json.gz",
  "generated-runtime/published-graph/f26.json.gz",
  "generated-runtime/published-graph/a16zsr006.json.gz"
];
const nextBootstrapRuntimeDependencies = [
  "node_modules/next/dist/lib/framework/boundary-constants.js",
  "node_modules/@swc/helpers/_/_interop_require_default/package.json"
];

describe("graph runtime trace contract", () => {
  it("accepts full and refresh traces containing every compact evidence projection", () => {
    const result = runValidator();

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("full graph diagnostics trace:");
    expect(result.output).toContain("graph refresh trace:");
  });

  it("rejects a full graph trace that omits one compact evidence projection", () => {
    const missing = graphRuntimeProjections[2];
    const result = runValidator({ missingFromFull: missing });

    expect(result.status).toBe(1);
    expect(result.output).toContain("full graph diagnostics trace is missing required runtime snapshots:");
    expect(result.output).toContain(missing);
  });

  it("rejects semantic whole-repository leaks even when they fit below byte budgets", () => {
    const result = runValidator({ leakWholeRepositoryFileIntoFull: true });

    expect(result.status).toBe(1);
    expect(result.output).toContain("full graph diagnostics trace contains forbidden runtime artifacts:");
    expect(result.output).toContain("trace-leak-sentinel.json");
  });

  it.each(["public", "logged-in", "targeted", "volume"])("rejects an uncompressed %s runtime file even when gzip is present", (name) => {
    const path = `generated-runtime/graph/${name}-evidence-current.json`;
    const result = runValidator({ leakUncompressedIntoFull: path });
    expect(result.status).toBe(1);
    expect(result.output).toContain("full graph diagnostics trace contains forbidden runtime artifacts:");
    expect(result.output).toContain(path);
  });

  it("rejects a public graph function missing its compressed Fall snapshot", () => {
    const result = runValidator({ missingFromGraph: "generated-runtime/published-graph/f26.json.gz" });
    expect(result.status).toBe(1);
    expect(result.output).toContain("graph trace is missing required runtime snapshots:");
  });

  it.each(["graph", "insider", "company"])("rejects raw public snapshots in the %s function", (route) => {
    const result = runValidator({ leakPublicSnapshot: route });
    expect(result.status).toBe(1);
    expect(result.output).toContain("contains forbidden runtime artifacts:");
    expect(result.output).toContain("public/graph/f26.json");
  });

  it("does not treat the GitHub Actions work parent as a repository leak", () => {
    const result = runValidator({ runUnderWorkParent: true });

    expect(result.status, result.output).toBe(0);
  });

  it("still rejects a repository-local work directory under the GitHub Actions parent", () => {
    const result = runValidator({
      runUnderWorkParent: true,
      leakRepositoryWorkFileIntoFull: true
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain("full graph diagnostics trace contains forbidden runtime artifacts:");
    expect(result.output).toContain("trace-leak-sentinel.json");
  });

  it("keeps the unusable Sharp musl family out of glibc debug traces", () => {
    const config = readFileSync(join(process.cwd(), "next.config.mjs"), "utf8");
    expect(config).toContain("node_modules/@img/sharp-libvips-linuxmusl-*/**/*");
    expect(config).toContain("node_modules/@img/sharp-linuxmusl-*/**/*");

    const result = runValidator({ leakMuslSharpIntoDebug: true });

    expect(result.status).toBe(1);
    expect(result.output).toContain("debug duplicates trace contains forbidden runtime artifacts:");
    expect(result.output).toContain("sharp-libvips-linuxmusl-x64");
  });

  it("keeps Turbopack ignore directives on both dynamic path construction and filesystem consumers", () => {
    for (const file of [
      "src/lib/graph/a16z-speedrun-006-dataset.ts",
      "src/lib/graph/yc-spring-2026-dataset.ts"
    ]) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source).toContain('import { readGraphRuntimeJson } from "./runtime-json.mjs"');
      expect(source).toContain("readGraphRuntimeJson(");
    }
    const reader = readFileSync(join(process.cwd(), "src/lib/graph/runtime-json.mjs"), "utf8");
    expect(reader).toContain("join(/* turbopackIgnore: true */ root, relativePath)");
    expect(reader).toContain("existsSync(/* turbopackIgnore: true */ runtimePath)");
    expect(reader).toContain("readFileSync(/* turbopackIgnore: true */ runtimePath");
    expect(reader).toContain("existsSync(/* turbopackIgnore: true */ compressedPath)");
    expect(reader).toContain("readFileSync(/* turbopackIgnore: true */ compressedPath)");
  });

  it("keeps unused audience snapshots out of the company API", () => {
    const result = runValidator({ leakUnusedGraphSnapshotIntoReturnerApi: true });
    expect(result.status).toBe(1);
    expect(result.output).toContain("Returner Fund company API trace contains forbidden runtime artifacts:");
    expect(result.output).toContain("s26-yc-partners.json.gz");
  });

  it("traces only compressed evidence projections", () => {
    const config = readFileSync(join(process.cwd(), "next.config.mjs"), "utf8");
    for (const projection of graphRuntimeProjections) expect(config).toContain(`"${projection}"`);
    expect(config).not.toMatch(/generated-runtime\/graph\/[a-z-]+-evidence-current\.json["']/);
  });

  it.each(["graph", "full", "refresh", "insider", "company"])("rejects missing Node bootstrap metadata in the %s trace", (route) => {
    const result = runValidator({ missingBootstrapDescriptorFrom: route });
    expect(result.status).toBe(1);
    expect(result.output).toContain("trace is missing Node package descriptors:");
    expect(result.output).toContain("node_modules/next/dist/compiled/source-map/package.json");
  });

  it.each(["graph", "full", "refresh", "insider", "company"].flatMap((route) =>
    nextBootstrapRuntimeDependencies.map((dependency) => ({ route, dependency }))
  ))("rejects a missing launcher asset in $route: $dependency", ({ route, dependency }) => {
    const result = runValidator({ missingBootstrapAssetFrom: route, missingBootstrapAsset: dependency });
    expect(result.status).toBe(1);
    expect(result.output).toContain("trace is missing required runtime snapshots:");
    expect(result.output).toContain(dependency);
  });
});

function runValidator(options: {
  missingFromFull?: string;
  missingFromGraph?: string;
  leakPublicSnapshot?: string;
  leakWholeRepositoryFileIntoFull?: boolean;
  leakRepositoryWorkFileIntoFull?: boolean;
  leakMuslSharpIntoDebug?: boolean;
  leakUncompressedIntoFull?: string;
  leakUnusedGraphSnapshotIntoReturnerApi?: boolean;
  runUnderWorkParent?: boolean;
  missingBootstrapDescriptorFrom?: string;
  missingBootstrapAssetFrom?: string;
  missingBootstrapAsset?: string;
} = {}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "graph-trace-contract-"));
  const root = options.runUnderWorkParent
    ? join(fixtureRoot, "home", "runner", "work", "returner-fund", "returner-fund")
    : fixtureRoot;
  try {
    mkdirSync(root, { recursive: true });
    for (const file of [...publishedGraphSnapshots, ...graphRuntimeProjections]) {
      writeFixtureFile(root, file);
    }
    for (const dependency of nextBootstrapRuntimeDependencies) writeFixtureFile(root, dependency);

    const rawPublicSnapshot = "public/graph/f26.json";
    if (options.leakPublicSnapshot) writeFixtureFile(root, rawPublicSnapshot);
    const graphFiles = publishedGraphSnapshots.filter((file) => file !== options.missingFromGraph);
    const bootstrapMain = "node_modules/next/dist/compiled/source-map/source-map.js";
    const bootstrapDescriptor = "node_modules/next/dist/compiled/source-map/package.json";
    if (options.missingBootstrapDescriptorFrom) {
      writeFixtureFile(root, bootstrapMain);
      writeFixtureFile(root, bootstrapDescriptor);
    }
    const withBootstrap = (route: string, files: string[]) => [
      ...files,
      ...nextBootstrapRuntimeDependencies.filter((dependency) =>
        !(options.missingBootstrapAssetFrom === route && options.missingBootstrapAsset === dependency)
      ),
      ...(options.missingBootstrapDescriptorFrom === route ? [bootstrapMain] : [])
    ];
    if (options.leakPublicSnapshot === "graph") graphFiles.push(rawPublicSnapshot);
    writeManifest(root, ".next/server/app/api/graph/route.js.nft.json", withBootstrap("graph", graphFiles));
    writeManifest(
      root,
      ".next/server/app/api/v1/companies/[slug]/returner-fund/route.js.nft.json",
      withBootstrap("company", [
        ...returnerFundApiSnapshots,
        ...(options.leakPublicSnapshot === "company" ? [rawPublicSnapshot] : []),
        ...(options.leakUnusedGraphSnapshotIntoReturnerApi ? ["generated-runtime/published-graph/s26-yc-partners.json.gz"] : [])
      ])
    );
    const fullTraceFiles = graphRuntimeProjections.filter((file) => file !== options.missingFromFull);
    const allowedPackageScript = "node_modules/trace-fixture/scripts/allowed.js";
    writeFixtureFile(root, allowedPackageScript);
    fullTraceFiles.push(allowedPackageScript);
    if (options.leakUncompressedIntoFull) {
      const leakPath = options.leakUncompressedIntoFull;
      writeFixtureFile(root, leakPath);
      fullTraceFiles.push(leakPath);
    }
    if (options.leakWholeRepositoryFileIntoFull) {
      const leakPath = "public/timelines/companies/trace-leak-sentinel.json";
      writeFixtureFile(root, leakPath);
      fullTraceFiles.push(leakPath);
    }
    if (options.leakRepositoryWorkFileIntoFull) {
      const leakPath = "work/trace-leak-sentinel.json";
      writeFixtureFile(root, leakPath);
      fullTraceFiles.push(leakPath);
    }
    writeManifest(
      root,
      ".next/server/app/api/graph/full/route.js.nft.json",
      withBootstrap("full", fullTraceFiles)
    );
    writeManifest(root, ".next/server/app/api/graph/refresh/route.js.nft.json", withBootstrap("refresh", graphRuntimeProjections));
    writeManifest(root, ".next/server/app/api/insiders/recompute/route.js.nft.json", withBootstrap("insider", [
      "generated-runtime/published-graph/s2026.json.gz",
      "generated-runtime/published-graph/s2026-insiders.json.gz",
      "generated-runtime/published-graph/s26.json.gz",
      "generated-runtime/published-graph/f26.json.gz",
      "generated-runtime/published-graph/s26-insiders.json.gz",
      "generated-runtime/published-graph/f26-insiders.json.gz",
      "generated-runtime/published-graph/a16zsr006.json.gz",
      "generated-runtime/published-graph/a16zsr006-insiders.json.gz",
      ...(options.leakPublicSnapshot === "insider" ? [rawPublicSnapshot] : [])
    ]));
    writeManifest(root, ".next/server/app/api/admin/ingestion/route.js.nft.json", []);
    for (const route of [
      "duplicates",
      "evidence",
      "instagram-coverage",
      "scoring",
      "thumbnails",
      "workers"
    ]) {
      const debugTraceFiles = [...graphRuntimeProjections];
      if (options.leakMuslSharpIntoDebug && route === "duplicates") {
        const leakPath = "node_modules/@img/sharp-libvips-linuxmusl-x64/lib/libvips-cpp.so";
        writeFixtureFile(root, leakPath);
        debugTraceFiles.push(leakPath);
      }
      writeManifest(
        root,
        `.next/server/app/debug/${route}/page.js.nft.json`,
        debugTraceFiles,
      );
    }

    const result = spawnSync(process.execPath, [validatorPath], {
      cwd: root,
      encoding: "utf8"
    });
    return {
      status: result.status,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`
    };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function writeFixtureFile(root: string, relativePath: string) {
  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, "{}\n", "utf8");
}

function writeManifest(root: string, relativePath: string, files: string[]) {
  const manifestPath = join(root, relativePath);
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(
    manifestPath,
    `${JSON.stringify({
      version: 1,
      files: files.map((file) => relative(dirname(manifestPath), join(root, file)))
    })}\n`,
    "utf8"
  );
}
