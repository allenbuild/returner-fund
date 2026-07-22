#!/usr/bin/env node
/**
 * Builds a deterministic, stratified human-review set from the committed graph
 * snapshots.  It deliberately does not manufacture expected labels: a reviewer
 * fills expectedPrimaryTopic/expectedSecondarySignals before evaluation.
 *
 * node --experimental-strip-types scripts/build-post-topic-review-set.mjs --count=300
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { classifyPostTopics } from "../src/lib/graph/post-topics.ts";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const inputs = args.inputs.length ? args.inputs : ["public/graph/s2026.json", "public/graph/s26.json", "public/graph/a16zsr006.json"];
const rows = [];
const seen = new Set();
for (const input of inputs) {
  const graph = JSON.parse(await readFile(path.resolve(root, input), "utf8"));
  for (const item of graph.evidence ?? []) {
    const key = `${item.platform}|${item.platformPostId ?? item.sourceUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const classification = classifyPostTopics({
      title: item.title, text: item.text, rawVisibleText: item.rawVisibleText,
      mediaType: item.mediaType, platform: item.platform,
      authorType: item.entityType === "founder" ? "founder" : "company"
    });
    rows.push({ item, key, classification });
  }
}

const selected = []; const selectedKeys = new Set();
const take = (pool, count) => {
  for (const entry of pool.sort((a, b) => stableHash(a.key) - stableHash(b.key))) {
    if (selected.length >= args.count || selectedKeys.has(entry.key)) continue;
    selected.push(entry); selectedKeys.add(entry.key);
    if (--count === 0) break;
  }
};

// Give every current candidate topic/platform/author kind a chance to be
// reviewed before filling the remainder with a deterministic random sample.
for (const topic of [...new Set(rows.map((row) => row.classification.primaryTopic))].sort()) take(rows.filter((row) => row.classification.primaryTopic === topic), args.perStratum);
for (const platform of [...new Set(rows.map((row) => row.item.platform))].sort()) take(rows.filter((row) => row.item.platform === platform), args.perStratum);
for (const authorType of ["company", "founder"]) take(rows.filter((row) => (row.item.entityType === "founder" ? "founder" : "company") === authorType), args.perStratum);
take(rows, args.count);

const reviewSet = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceInputs: inputs,
  instruction: "Review actual source content. Set expectedPrimaryTopic, expectedSecondarySignals, allowedAlternatives, and notes. Do not use predictedPrimaryTopic as ground truth.",
  examples: selected.map(({ item, key, classification }) => ({
    key, evidenceId: item.id, sourceUrl: item.sourceUrl, platform: item.platform,
    authorType: item.entityType === "founder" ? "founder" : "company", mediaType: item.mediaType ?? "unknown",
    title: item.title ?? null, text: item.text ?? "", publishedAt: item.postedAt ?? null,
    predictedPrimaryTopic: classification.primaryTopic,
    predictedSecondarySignals: classification.secondarySignals,
    predictedConfidence: classification.confidence,
    expectedPrimaryTopic: null,
    expectedSecondarySignals: [],
    allowedAlternatives: [],
    notes: ""
  }))
};
await atomicJson(path.resolve(root, args.output), reviewSet);
console.log(JSON.stringify({ output: args.output, examples: reviewSet.examples.length, platforms: Object.fromEntries([...new Set(reviewSet.examples.map((row) => row.platform))].sort().map((key) => [key, reviewSet.examples.filter((row) => row.platform === key).length])) }, null, 2));

function parseArgs(values) { const out = { count: 300, perStratum: 12, output: "work/post-topic-review-set.json", inputs: [] }; for (let i = 0; i < values.length; i += 1) { const [flag, inline] = values[i].split("=", 2); const value = inline ?? values[++i]; if (flag === "--count") out.count = Number(value); else if (flag === "--per-stratum") out.perStratum = Number(value); else if (flag === "--output") out.output = value; else if (flag === "--input") out.inputs.push(value); else throw new Error(`Unknown argument: ${values[i]}`); } if (!Number.isInteger(out.count) || out.count < 1) throw new Error("--count must be a positive integer"); return out; }
function stableHash(value) { let hash = 2166136261; for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619); return hash >>> 0; }
async function atomicJson(file, value) { await mkdir(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp`; await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`); await rename(tmp, file); }
