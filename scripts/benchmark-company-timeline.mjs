#!/usr/bin/env node

import { performance } from "node:perf_hooks";

const DEFAULT_SLUGS = ["screenpipe", "heyclicky", "graphify-labs"];

export async function benchmarkCompanyTimelines({
  baseUrl = "http://127.0.0.1:3000",
  slugs = DEFAULT_SLUGS,
  runs = 12,
  warmups = 2,
  fetchImpl = fetch,
} = {}) {
  if (!Array.isArray(slugs) || slugs.length === 0) {
    throw new Error("At least one company slug is required.");
  }
  if (!Number.isInteger(runs) || runs < 1 || runs > 200) {
    throw new Error("runs must be an integer between 1 and 200.");
  }
  if (!Number.isInteger(warmups) || warmups < 0 || warmups > 20) {
    throw new Error("warmups must be an integer between 0 and 20.");
  }

  const origin = normalizeOrigin(baseUrl);
  const timelineSamples = [];
  const detailSamples = [];
  const payloadBytes = [];
  const detailPayloadBytes = [];
  const cacheOutcomes = new Map();
  let firstEventId = null;

  for (let index = 0; index < warmups; index += 1) {
    const slug = slugs[index % slugs.length];
    await timedFetch(fetchImpl, `${origin}/api/companies/${encodeURIComponent(slug)}/timeline?limit=50`);
  }

  for (let index = 0; index < runs; index += 1) {
    const slug = slugs[index % slugs.length];
    const sample = await timedFetch(
      fetchImpl,
      `${origin}/api/companies/${encodeURIComponent(slug)}/timeline?limit=50`,
    );
    timelineSamples.push(sample.elapsedMs);
    payloadBytes.push(sample.byteSize);
    increment(cacheOutcomes, sample.headers.get("x-timeline-cache") || "unspecified");

    const body = parseJson(sample.body, `timeline response for ${slug}`);
    const eventId = Array.isArray(body.events) ? body.events[0]?.id : null;
    if (typeof eventId === "string" && eventId) firstEventId ??= eventId;
  }

  if (firstEventId) {
    for (let index = 0; index < Math.min(runs, 20); index += 1) {
      const sample = await timedFetch(
        fetchImpl,
        `${origin}/api/timeline/events/${encodeURIComponent(firstEventId)}`,
      );
      detailSamples.push(sample.elapsedMs);
      detailPayloadBytes.push(sample.byteSize);
      increment(cacheOutcomes, sample.headers.get("x-timeline-cache") || "unspecified");
    }
  }

  return {
    measuredAt: new Date().toISOString(),
    baseUrl: origin,
    slugs,
    timelineApi: summarize(timelineSamples, payloadBytes),
    eventDetailApi: detailSamples.length ? summarize(detailSamples, detailPayloadBytes) : null,
    cacheOutcomes: Object.fromEntries([...cacheOutcomes.entries()].sort()),
  };
}

async function timedFetch(fetchImpl, url) {
  const startedAt = performance.now();
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    redirect: "error",
  });
  const body = await response.text();
  const elapsedMs = performance.now() - startedAt;
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${body.slice(0, 240)}`);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(`${url} returned unexpected content type ${contentType || "missing"}.`);
  }
  return {
    elapsedMs,
    byteSize: Buffer.byteLength(body),
    body,
    headers: response.headers,
  };
}

function summarize(samples, sizes) {
  return {
    samples: samples.length,
    p50Ms: round(percentile(samples, 0.5)),
    p95Ms: round(percentile(samples, 0.95)),
    minMs: round(Math.min(...samples)),
    maxMs: round(Math.max(...samples)),
    medianPayloadBytes: Math.round(percentile(sizes, 0.5)),
    maxPayloadBytes: Math.max(...sizes),
  };
}

function percentile(values, quantile) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index];
}

function parseJson(body, label) {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Could not parse ${label} as JSON.`);
  }
}

function normalizeOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("base URL must use http or https.");
  }
  return url.origin;
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function parseArgs(rawArgs) {
  const options = {};
  for (const argument of rawArgs) {
    if (argument === "--help" || argument === "-h") return { help: true };
    const [flag, value] = argument.split("=", 2);
    if (!value) throw new Error(`Expected --name=value, received ${argument}.`);
    if (flag === "--base-url") options.baseUrl = value;
    else if (flag === "--slugs") options.slugs = value.split(",").map((item) => item.trim()).filter(Boolean);
    else if (flag === "--runs") options.runs = Number(value);
    else if (flag === "--warmups") options.warmups = Number(value);
    else throw new Error(`Unknown argument ${flag}.`);
  }
  return options;
}

function usage() {
  return [
    "Usage: node scripts/benchmark-company-timeline.mjs [options]",
    "",
    "  --base-url=http://127.0.0.1:3000",
    "  --slugs=screenpipe,heyclicky,graphify-labs",
    "  --runs=12",
    "  --warmups=2",
  ].join("\n");
}

const isDirectExecution = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isDirectExecution) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
  } else {
    benchmarkCompanyTimelines(options)
      .then((result) => console.log(JSON.stringify(result, null, 2)))
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
