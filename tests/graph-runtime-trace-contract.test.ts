import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const validatorPath = join(process.cwd(), "scripts/validate-graph-function-trace.mjs");
const graphRuntimeProjections = [
  "generated-runtime/graph/public-evidence-current.json",
  "generated-runtime/graph/logged-in-evidence-current.json",
  "generated-runtime/graph/targeted-evidence-current.json",
  "generated-runtime/graph/volume-evidence-current.json"
];
const publishedGraphSnapshots = [
  "public/graph/s2026.json",
  "public/graph/s2026-yc-partners.json",
  "public/graph/s2026-insiders.json",
  "public/graph/s26.json",
  "public/graph/s26-yc-partners.json",
  "public/graph/s26-insiders.json",
  "public/graph/a16zsr006.json",
  "public/graph/a16zsr006-yc-partners.json",
  "public/graph/a16zsr006-insiders.json"
];
const returnerFundApiSnapshots = [
  "public/graph/s2026.json",
  "public/graph/s26.json",
  "public/graph/a16zsr006.json"
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
      expect(source).toContain("join(/* turbopackIgnore: true */ root, relativePath)");
      expect(source).toContain("existsSync(/* turbopackIgnore: true */ runtimePath)");
      expect(source).toContain("readFileSync(/* turbopackIgnore: true */ runtimePath");
    }
  });
});

function runValidator(options: {
  missingFromFull?: string;
  leakWholeRepositoryFileIntoFull?: boolean;
  leakRepositoryWorkFileIntoFull?: boolean;
  leakMuslSharpIntoDebug?: boolean;
  runUnderWorkParent?: boolean;
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

    writeManifest(root, ".next/server/app/api/graph/route.js.nft.json", publishedGraphSnapshots);
    writeManifest(
      root,
      ".next/server/app/api/v1/companies/[slug]/returner-fund/route.js.nft.json",
      returnerFundApiSnapshots
    );
    const fullTraceFiles = graphRuntimeProjections.filter((file) => file !== options.missingFromFull);
    const allowedPackageScript = "node_modules/trace-fixture/scripts/allowed.js";
    writeFixtureFile(root, allowedPackageScript);
    fullTraceFiles.push(allowedPackageScript);
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
      fullTraceFiles
    );
    writeManifest(root, ".next/server/app/api/graph/refresh/route.js.nft.json", graphRuntimeProjections);
    writeManifest(root, ".next/server/app/api/insiders/recompute/route.js.nft.json", [
      "public/graph/s2026.json",
      "public/graph/s2026-insiders.json",
      "public/graph/s26.json",
      "public/graph/s26-insiders.json",
      "public/graph/a16zsr006.json",
      "public/graph/a16zsr006-insiders.json"
    ]);
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
