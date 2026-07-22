#!/usr/bin/env node
/** Evaluates human-reviewed topic examples without exposing or needing raw DB data. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { classifyPostTopics } from "../src/lib/graph/post-topics.ts";

const input = process.argv.find((value) => value.startsWith("--input="))?.slice(8) ?? "work/post-topic-review-set.json";
const dataset = JSON.parse(await readFile(path.resolve(process.cwd(), input), "utf8"));
const reviewed = (dataset.examples ?? []).filter((row) => typeof row.expectedPrimaryTopic === "string" && row.expectedPrimaryTopic.trim());
if (!reviewed.length) throw new Error("No reviewed examples. Fill expectedPrimaryTopic values before evaluating.");
const labels = [...new Set(reviewed.flatMap((row) => [row.expectedPrimaryTopic, ...(row.allowedAlternatives ?? [])]))].sort();
const matrix = new Map(); const metrics = new Map();
const failures = [];
for (const row of reviewed) {
  const prediction = classifyPostTopics({ title: row.title, text: row.text, platform: row.platform, mediaType: row.mediaType, authorType: row.authorType });
  const accepted = new Set([row.expectedPrimaryTopic, ...(row.allowedAlternatives ?? [])]);
  const correct = accepted.has(prediction.primaryTopic);
  const key = `${row.expectedPrimaryTopic}→${prediction.primaryTopic}`; matrix.set(key, (matrix.get(key) ?? 0) + 1);
  for (const label of labels) {
    const current = metrics.get(label) ?? { tp: 0, fp: 0, fn: 0 };
    if (prediction.primaryTopic === label && accepted.has(label)) current.tp += 1;
    else if (prediction.primaryTopic === label) current.fp += 1;
    else if (accepted.has(label)) current.fn += 1;
    metrics.set(label, current);
  }
  if (!correct) failures.push({ key: row.key, platform: row.platform, authorType: row.authorType, expected: row.expectedPrimaryTopic, predicted: prediction.primaryTopic, confidence: prediction.confidence, sourceUrl: row.sourceUrl });
}
const perTopic = Object.fromEntries(labels.map((label) => { const { tp, fp, fn } = metrics.get(label); const precision = ratio(tp, tp + fp); const recall = ratio(tp, tp + fn); return [label, { precision, recall, f1: ratio(2 * precision * recall, precision + recall), support: tp + fn }]; }));
const summary = { reviewed: reviewed.length, accuracy: ratio(reviewed.length - failures.length, reviewed.length), macroF1: ratio(Object.values(perTopic).reduce((sum, item) => sum + item.f1, 0), labels.length), unclassifiedRate: ratio(reviewed.filter((row) => classifyPostTopics({ title: row.title, text: row.text, platform: row.platform, mediaType: row.mediaType, authorType: row.authorType }).primaryTopic === "unclassified").length, reviewed.length), reviewQueueRate: ratio(reviewed.filter((row) => classifyPostTopics({ title: row.title, text: row.text, platform: row.platform, mediaType: row.mediaType, authorType: row.authorType }).needsReview).length, reviewed.length), perTopic, confusionMatrix: Object.fromEntries([...matrix].sort()), failures: failures.slice(0, 50) };
console.log(JSON.stringify(summary, null, 2));
function ratio(numerator, denominator) { return denominator ? Number((numerator / denominator).toFixed(4)) : 0; }
