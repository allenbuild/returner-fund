#!/usr/bin/env node
/**
 * Safe local/CI backfill planner for taxonomy v2.  It never changes canonical
 * evidence: default mode emits a checkpointed plan.  A database writer can
 * consume the same JSON after an operator reviews the dry-run summary.
 *
 * Run: node --experimental-strip-types scripts/reclassify-post-topics.mjs --dry-run
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { classifyPostTopics } from "../src/lib/graph/post-topics.ts";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const inputs = args.inputs.length ? args.inputs : ["public/graph/s2026.json", "public/graph/s26.json", "public/graph/a16zsr006.json"];
const checkpointPath = path.resolve(root, args.checkpoint);
const outputPath = path.resolve(root, args.output);
const previous = args.resume ? await readJson(checkpointPath, { processed: [] }) : { processed: [] };
const processed = new Set(previous.processed ?? []);
const seen = new Set();
const changes = [];
const before = new Map(); const after = new Map(); const moves = new Map();

for (const input of inputs) {
  const graph = await readJson(path.resolve(root, input), null);
  if (!graph?.evidence) throw new Error(`Missing evidence array in ${input}`);
  for (const row of graph.evidence) {
    const key = `${row.platform}|${row.platformPostId ?? row.sourceUrl}`;
    if (seen.has(key) || processed.has(key)) continue;
    seen.add(key);
    const next = classifyPostTopics({ title: row.title, text: row.text, rawVisibleText: row.rawVisibleText, mediaType: row.mediaType, platform: row.platform, authorType: row.entityType === "founder" ? "founder" : "company" });
    const old = row.topicClassification?.primaryTopic ?? row.topics?.[0] ?? null;
    increment(before, old ?? "none"); increment(after, next.primaryTopic); increment(moves, `${old ?? "none"}→${next.primaryTopic}`);
    if (old !== next.primaryTopic || row.topicClassification?.taxonomyVersion !== next.taxonomyVersion) changes.push({ key, id: row.id, sourceUrl: row.sourceUrl, platform: row.platform, oldPrimaryTopic: old, classification: next });
    processed.add(key);
    if (args.batchSize && processed.size % args.batchSize === 0) await checkpoint(checkpointPath, processed);
  }
}
await checkpoint(checkpointPath, processed);
const summary = { mode: args.dryRun ? "dry_run" : "planned", inputs, taxonomyVersion: changes[0]?.classification.taxonomyVersion ?? null, processed: processed.size, updates: changes.length, before: objectFrom(before), after: objectFrom(after), moves: objectFrom(moves), needsReview: changes.filter((item) => item.classification.needsReview).length, unclassified: changes.filter((item) => item.classification.primaryTopic === "unclassified").length, representativeChanges: changes.slice(0, 30), estimatedModelCostUsd: 0, note: "Deterministic classifier only; no external model or database writes were performed." };
if (!args.dryRun) await writeJsonAtomic(outputPath, { summary, changes });
console.log(JSON.stringify(summary, null, 2));

function parseArgs(values) { const parsed = { dryRun: true, resume: false, inputs: [], checkpoint: "work/topic-backfill-checkpoint.json", output: "work/topic-backfill-plan.json", batchSize: 250 }; for (let index = 0; index < values.length; index += 1) { const value = values[index]; if (value === "--dry-run") continue; if (value === "--resume") { parsed.resume = true; continue; } if (value === "--write-plan") { parsed.dryRun = false; continue; } const [name, inline] = value.split("=", 2); const next = inline ?? values[++index]; if (name === "--input") parsed.inputs.push(next); else if (name === "--checkpoint") parsed.checkpoint = next; else if (name === "--output") parsed.output = next; else if (name === "--batch-size") parsed.batchSize = Number(next); else throw new Error(`Unknown argument: ${value}`); } return parsed; }
async function readJson(file, fallback) { try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error?.code === "ENOENT") return fallback; throw error; } }
async function checkpoint(file, processed) { await writeJsonAtomic(file, { processed: [...processed] }); }
async function writeJsonAtomic(file, value) { await mkdir(path.dirname(file), { recursive: true }); const temporary = `${file}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`); await rename(temporary, file); }
function increment(map, key) { map.set(key, (map.get(key) ?? 0) + 1); }
function objectFrom(map) { return Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b))); }
