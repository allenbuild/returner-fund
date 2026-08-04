#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(process.cwd());
const outputRoot = join(root, "generated-runtime", "graph");
const snapshotNames = ["public", "logged-in", "targeted", "volume"];
const acceptedBatches = new Set(["S26", "S2026", "P26", "A16ZSR006"]);
const historicalSlugs = new Set(["blueprints", "bylaw", "litmus-build", "perceptron-ml"]);
const reviewKeys = [
  "id", "batchSlug", "batch_slug", "entityType", "entityId", "entityName",
  "platform", "candidateUrl", "review_state", "matchReason",
];

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

await mkdir(outputRoot, { recursive: true });
const results = [];
for (const name of snapshotNames) {
  const sourcePath = `src/lib/social/${name}-evidence-current.json`;
  const source = await readJson(sourcePath);
  // Evidence rows are already compact and several graph pipelines consume
  // forward-compatible provenance fields. Preserve each accepted row exactly;
  // the memory win comes from excluding tens of thousands of crawl failures,
  // attempts, and discovery logs at the snapshot root.
  const evidence = (source.evidence ?? []).filter(isRelevant);
  const needsReview = (source.needsReview ?? []).filter(isRelevant).map((row) => pick(row, reviewKeys));
  const output = { source: source.source, evidence, needsReview };
  const target = join(outputRoot, `${name}-evidence-current.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  const serialized = `${JSON.stringify(output)}\n`;
  await writeFile(temporary, serialized, "utf8");
  await rename(temporary, target);
  results.push({ name, evidence: evidence.length, needsReview: needsReview.length, bytes: Buffer.byteLength(serialized) });
}

process.stdout.write(`${JSON.stringify({ status: "prepared", outputRoot: "generated-runtime/graph", snapshots: results })}\n`);

function isRelevant(row) {
  const batch = String(row.batchSlug ?? row.batch_slug ?? "").trim().toUpperCase();
  return acceptedBatches.has(batch)
    || knownIds.has(row.entityId)
    || knownSlugs.has(row.companySlug)
    || knownNames.has(slugify(row.companyName ?? ""));
}

function pick(row, keys) {
  return Object.fromEntries(keys.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(join(root, relativePath), "utf8"));
}
