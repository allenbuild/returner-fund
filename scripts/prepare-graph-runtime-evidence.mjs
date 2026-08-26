#!/usr/bin/env node

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { readPublicEvidenceArtifact } from "./lib/public-evidence-artifact.mjs";
import { validatedRepositoryDataRoot } from "./lib/validated-repository-data-root.mjs";

const snapshotNames = ["public", "logged-in", "targeted", "volume"];
const acceptedBatches = new Set(["S26", "S2026", "P26", "A16ZSR006"]);
const historicalSlugs = new Set(["blueprints", "bylaw", "litmus-build", "perceptron-ml"]);
const reviewKeys = [
  "id", "batchSlug", "batch_slug", "entityType", "entityId", "entityName",
  "platform", "candidateUrl", "review_state", "matchReason",
];

export async function prepareGraphRuntimeEvidence({ rootDir } = {}) {
  const root = validatedRepositoryDataRoot(rootDir, {
    fallbackRoot: process.cwd(),
    label: "graph runtime evidence data root"
  });
  const outputRoot = join(root, "generated-runtime", "graph");
  const readJson = async (relativePath) =>
    JSON.parse(await readFile(join(root, relativePath), "utf8"));
  const [summer, spring, overrides] = await Promise.all([
    readJson("src/lib/yc/summer-2026-companies.json"),
    readJson("src/lib/yc/spring-2026-companies.json"),
    readJson("src/lib/social/verified-social-overrides.json"),
  ]);
  const companies = [...summer.companies, ...spring.companies];
  const knownIds = new Set();
  const knownSlugs = new Set(historicalSlugs);
  const knownNames = new Set();
  for (const company of companies) {
    knownIds.add(`company-${company.slug}`);
    knownSlugs.add(company.slug);
    knownNames.add(slugify(company.name));
    for (const founder of company.founders ?? []) {
      knownIds.add(`founder-${company.slug}-${slugify(founder.name)}-${founder.id}`);
    }
    for (const founder of overrides[company.slug]?.founders ?? []) {
      knownIds.add(`founder-${company.slug}-${slugify(founder.name)}-${founder.id}`);
    }
  }

  const isRelevant = (row) => {
    const batch = String(row.batchSlug ?? row.batch_slug ?? "").trim().toUpperCase();
    return acceptedBatches.has(batch)
      || knownIds.has(row.entityId)
      || knownSlugs.has(row.companySlug)
      || knownNames.has(slugify(row.companyName ?? ""));
  };

  await mkdir(outputRoot, { recursive: true });
  const results = [];
  for (const name of snapshotNames) {
    const sourcePath = `src/lib/social/${name}-evidence-current.json`;
    const source = name === "public"
      ? (await readPublicEvidenceArtifact(sourcePath, { rootDir: root })).snapshot
      : await readJson(sourcePath);
    // Evidence rows are already compact and several graph pipelines consume
    // forward-compatible provenance fields. Preserve each accepted row exactly;
    // the memory win comes from excluding tens of thousands of crawl failures,
    // attempts, and discovery logs at the snapshot root.
    const evidence = (source.evidence ?? []).filter(isRelevant);
    const needsReview = (source.needsReview ?? []).filter(isRelevant).map((row) => pick(row, reviewKeys));
    const output = { source: source.source, evidence, needsReview };
    const target = join(outputRoot, `${name}-evidence-current.json.gz`);
    const temporary = `${target}.${process.pid}.tmp`;
    const serialized = `${JSON.stringify(output)}\n`;
    const compressed = gzipSync(serialized, { level: 9 });
    await writeFile(temporary, compressed);
    await rename(temporary, target);
    // A prior checkout may have prepared the legacy uncompressed projection.
    // Remove it so local incremental builds cannot accidentally trace both.
    await rm(join(outputRoot, `${name}-evidence-current.json`), { force: true });
    results.push({
      name,
      evidence: evidence.length,
      needsReview: needsReview.length,
      bytes: compressed.length,
      uncompressedBytes: Buffer.byteLength(serialized)
    });
  }

  return { status: "prepared", outputRoot: "generated-runtime/graph", snapshots: results };
}

async function main() {
  const configuredRoot = argumentValue("--root") ?? process.env.SCORING_DATA_ROOT ?? process.env.SCORING_ROOT;
  const result = await prepareGraphRuntimeEvidence({
    rootDir: configuredRoot ?? process.cwd()
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function pick(row, keys) {
  return Object.fromEntries(keys.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function argumentValue(name) {
  const prefix = `${name}=`;
  const argument = process.argv.find((value) => String(value).startsWith(prefix));
  return argument ? String(argument).slice(prefix.length) : undefined;
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entryPath === import.meta.url) await main();
