import { timingSafeEqual } from "node:crypto";
import {
  INGESTION_ACCEPTANCE_MARKER_PATH,
  INGESTION_GRAPH_MANIFEST_PATH,
  INGESTION_PUBLICATION_RECEIPT_PATH,
  inspectIngestionAcceptanceMarker
} from "../../../scripts/lib/ingestion-acceptance-marker.mjs";

const CENTRAL_TIME_ZONE = "America/Chicago";
const CENTRAL_SLOT_HOURS = new Set(["06", "18"]);
const STRICT_UTC_RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
const FULL_SHA256 = /^[a-f0-9]{64}$/;
const DEPLOY_HOOK_PATH = /^\/v1\/integrations\/deploy\/(prj_[A-Za-z0-9]+)\/[A-Za-z0-9_-]+$/;
const REQUIRED_GRAPH_ARTIFACTS = Object.freeze([
  "s2026.json",
  "s2026-yc-partners.json",
  "s2026-insiders.json",
  "s26.json",
  "s26-yc-partners.json",
  "s26-insiders.json",
  "a16zsr006.json",
  "a16zsr006-yc-partners.json",
  "a16zsr006-insiders.json"
]);
const REQUIRED_BENCHMARK_ARTIFACTS = Object.freeze([
  "s2026-score-benchmarks.json",
  "s26-score-benchmarks.json",
  "a16zsr006-score-benchmarks.json"
]);

export const INGESTION_WAKE_MANIFEST_URL =
  `https://raw.githubusercontent.com/allenbuild/returner-fund/main/${INGESTION_GRAPH_MANIFEST_PATH}`;
export const INGESTION_WAKE_ACCEPTANCE_URL =
  `https://raw.githubusercontent.com/allenbuild/returner-fund/main/${INGESTION_ACCEPTANCE_MARKER_PATH}`;
export const INGESTION_WAKE_RECEIPT_URL =
  `https://raw.githubusercontent.com/allenbuild/returner-fund/main/${INGESTION_PUBLICATION_RECEIPT_PATH}`;
export const INGESTION_WAKE_USER_AGENT = "vercel-cron/1.0";
export const INGESTION_WAKE_MAX_MANIFEST_BYTES = 256 * 1024;

export interface CloudWakeupEnvironment {
  CRON_SECRET?: string;
  VERCEL_INGESTION_DEPLOY_HOOK_URL?: string;
  VERCEL_PROJECT_ID?: string;
}

export interface CloudWakeupResult {
  body: {
    status:
      | "current"
      | "wake-requested"
      | "unauthorized"
      | "configuration-error"
      | "state-unavailable"
      | "wake-failed";
    reason?: string;
    slotKey?: string;
  };
  status: number;
}

interface WakeupDependencies {
  env?: CloudWakeupEnvironment;
  fetchImpl?: typeof fetch;
  manifestUrl?: string;
  acceptanceUrl?: string;
  receiptUrl?: string;
  now?: Date;
}

interface ManifestDecision {
  reason: string;
  shouldWake: boolean;
  slotKey: string;
}

interface PublicationBundleDecision extends ManifestDecision {
  scheduledAt: Date;
}

type PublicationResource =
  | { status: "available"; text: string }
  | { status: "missing"; text: null };

interface ArtifactEntry {
  byteSize: number;
  filename: string;
  generatedAt: Date;
  sha256: string;
}

const CENTRAL_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: CENTRAL_TIME_ZONE,
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

export async function handleCloudIngestionWakeup(
  request: Request,
  dependencies: WakeupDependencies = {}
): Promise<CloudWakeupResult> {
  const env = dependencies.env ?? process.env;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const now = dependencies.now ?? new Date();
  const cronSecret = clean(env.CRON_SECRET);

  if (!cronSecret || cronSecret.length < 16) {
    return response(503, "configuration-error");
  }
  if (
    request.headers.get("user-agent") !== INGESTION_WAKE_USER_AGENT ||
    !bearerMatches(request.headers.get("authorization"), cronSecret)
  ) {
    return response(401, "unauthorized");
  }

  const projectId = clean(env.VERCEL_PROJECT_ID);
  const deployHook = validateDeployHookUrl(env.VERCEL_INGESTION_DEPLOY_HOOK_URL, projectId);
  if (!deployHook) {
    return response(503, "configuration-error");
  }

  let decision: PublicationBundleDecision;
  try {
    const [manifest, acceptance, receipt] = await Promise.all([
      fetchPublicationResource(
        fetchImpl,
        dependencies.manifestUrl ?? INGESTION_WAKE_MANIFEST_URL
      ),
      fetchPublicationResource(
        fetchImpl,
        dependencies.acceptanceUrl ?? INGESTION_WAKE_ACCEPTANCE_URL
      ),
      fetchPublicationResource(
        fetchImpl,
        dependencies.receiptUrl ?? INGESTION_WAKE_RECEIPT_URL
      )
    ]);
    decision = publicationBundleWakeDecision({
      manifestText: manifest.text,
      markerText: acceptance.text,
      receiptText: receipt.text,
      now
    });
  } catch {
    // A transport failure is not evidence that publication debt exists. Avoid
    // creating an unbounded deployment loop during a GitHub/raw edge outage;
    // the next independent Vercel cron will retry this read.
    return response(503, "state-unavailable");
  }

  if (!decision.shouldWake) {
    return {
      body: { status: "current", reason: decision.reason, slotKey: decision.slotKey },
      status: 200
    };
  }

  try {
    const hookResponse = await fetchWithDeadline(fetchImpl, deployHook, {
      method: "POST",
      redirect: "error",
      cache: "no-store"
    });
    if (!hookResponse.ok) return response(502, "wake-failed");
  } catch {
    return response(502, "wake-failed");
  }

  return {
    body: { status: "wake-requested", reason: decision.reason, slotKey: decision.slotKey },
    status: 202
  };
}

export function publicationBundleWakeDecision({
  manifestText,
  markerText,
  receiptText,
  now = new Date()
}: {
  manifestText: string | null;
  markerText: string | null;
  receiptText: string | null;
  now?: Date;
}): PublicationBundleDecision {
  const latest = latestCentralSlot(now);
  if (manifestText === null) {
    return { ...latest, reason: "publication-manifest-missing", shouldWake: true };
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return { ...latest, reason: "publication-manifest-invalid", shouldWake: true };
  }
  const manifestDecision = publicationManifestWakeDecision(manifest, now);
  if (manifestDecision.shouldWake) return { ...latest, ...manifestDecision };

  if (markerText === null || receiptText === null) {
    return { ...latest, reason: "publication-acceptance-missing", shouldWake: true };
  }
  const acceptance = inspectIngestionAcceptanceMarker({
    markerText,
    receiptText,
    manifestText,
    now
  });
  if (acceptance.status !== "valid" || !acceptance.marker) {
    return { ...latest, reason: "publication-acceptance-invalid", shouldWake: true };
  }
  if (
    acceptance.marker.slotKey !== latest.slotKey ||
    acceptance.marker.scheduledAt !== latest.scheduledAt.toISOString()
  ) {
    return { ...latest, reason: "publication-acceptance-behind", shouldWake: true };
  }

  return { ...latest, reason: "publication-acceptance-current", shouldWake: false };
}

export function publicationManifestWakeDecision(value: unknown, now = new Date()): PublicationBundleDecision {
  const latest = latestCentralSlot(now);
  try {
    const manifest = record(value);
    if (manifest.schemaVersion !== 2) throw new Error("schema");
    if (clean(manifest.ingestionRunId) === "") throw new Error("run");
    if (!FULL_SHA256.test(clean(manifest.contentHash))) throw new Error("hash");
    if (manifest.evidenceCollectedAtKind !== "accepted-full-collection") throw new Error("provenance");

    const publishedAt = strictUtcDate(manifest.publishedAt, now);
    const evidenceCollectedAt = strictUtcDate(manifest.evidenceCollectedAt, now);
    if (evidenceCollectedAt.getTime() > publishedAt.getTime()) throw new Error("ordering");

    const graphs = artifactMap(manifest.graphArtifacts, now, publishedAt);
    const benchmarks = artifactMap(manifest.benchmarkArtifacts, now, publishedAt);
    for (const filename of REQUIRED_GRAPH_ARTIFACTS) requireArtifact(graphs, filename);
    const completeness = [evidenceCollectedAt];
    for (const filename of REQUIRED_BENCHMARK_ARTIFACTS) {
      completeness.push(requireArtifact(benchmarks, filename).generatedAt);
    }
    const watermarkMs = Math.min(...completeness.map((instant) => instant.getTime()));
    return {
      ...latest,
      reason: watermarkMs >= latest.scheduledAt.getTime()
        ? "publication-watermark-current"
        : "publication-watermark-stale",
      shouldWake: watermarkMs < latest.scheduledAt.getTime()
    };
  } catch {
    return { ...latest, reason: "publication-manifest-invalid", shouldWake: true };
  }
}

export function validateDeployHookUrl(value: unknown, expectedProjectId: unknown): URL | null {
  const projectId = clean(expectedProjectId);
  if (!/^prj_[A-Za-z0-9]+$/.test(projectId)) return null;
  try {
    const url = new URL(clean(value));
    const match = DEPLOY_HOOK_PATH.exec(url.pathname);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "api.vercel.com" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      match?.[1] !== projectId
    ) return null;
    return url;
  } catch {
    return null;
  }
}

export function bearerMatches(header: string | null, expected: string): boolean {
  const prefix = "Bearer ";
  const supplied = header?.startsWith(prefix) ? header.slice(prefix.length) : "";
  const suppliedDigest = Buffer.from(supplied);
  const expectedDigest = Buffer.from(expected);
  return suppliedDigest.length === expectedDigest.length && timingSafeEqual(suppliedDigest, expectedDigest);
}

function latestCentralSlot(now: Date) {
  if (!Number.isFinite(now.getTime())) throw new Error("invalid_now");
  const candidate = new Date(now);
  candidate.setUTCSeconds(0, 0);
  for (let offsetMinutes = 0; offsetMinutes <= 26 * 60; offsetMinutes += 1) {
    const parts = Object.fromEntries(
      CENTRAL_FORMATTER.formatToParts(candidate)
        .filter(({ type }) => type !== "literal")
        .map(({ type, value }) => [type, value])
    );
    if (parts.minute === "00" && parts.second === "00" && CENTRAL_SLOT_HOURS.has(parts.hour)) {
      return {
        scheduledAt: new Date(candidate),
        slotKey: `central-${parts.year}-${parts.month}-${parts.day}-${parts.hour}00`
      };
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() - 1);
  }
  throw new Error("slot_not_found");
}

function artifactMap(value: unknown, now: Date, publishedAt: Date): Map<string, ArtifactEntry> {
  if (!Array.isArray(value)) throw new Error("artifacts");
  const entries = new Map<string, ArtifactEntry>();
  for (const candidate of value) {
    const entry = record(candidate);
    const filename = clean(entry.filename);
    const generatedAt = strictUtcDate(entry.generatedAt, now);
    const byteSize = entry.byteSize;
    const sha256 = clean(entry.sha256);
    if (
      !filename ||
      entries.has(filename) ||
      !Number.isSafeInteger(byteSize) ||
      Number(byteSize) <= 0 ||
      !FULL_SHA256.test(sha256) ||
      generatedAt.getTime() > publishedAt.getTime()
    ) throw new Error("artifact");
    entries.set(filename, { byteSize: Number(byteSize), filename, generatedAt, sha256 });
  }
  return entries;
}

function requireArtifact(entries: Map<string, ArtifactEntry>, filename: string): ArtifactEntry {
  const entry = entries.get(filename);
  if (!entry) throw new Error("missing_artifact");
  return entry;
}

function strictUtcDate(value: unknown, now: Date): Date {
  const source = clean(value);
  const match = STRICT_UTC_RFC3339.exec(source);
  if (!match) throw new Error("timestamp");
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const instant = new Date(0);
  instant.setUTCFullYear(year, month - 1, day);
  instant.setUTCHours(hour, minute, second, 0);
  if (
    instant.getUTCFullYear() !== year ||
    instant.getUTCMonth() !== month - 1 ||
    instant.getUTCDate() !== day ||
    instant.getUTCHours() !== hour ||
    instant.getUTCMinutes() !== minute ||
    instant.getUTCSeconds() !== second ||
    instant.getTime() > now.getTime()
  ) throw new Error("timestamp");
  return instant;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("record");
  return value as Record<string, unknown>;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function fetchWithDeadline(fetchImpl: typeof fetch, input: string | URL, init: RequestInit) {
  return fetchImpl(input, { ...init, signal: AbortSignal.timeout(10_000) });
}

async function fetchPublicationResource(
  fetchImpl: typeof fetch,
  url: string
): Promise<PublicationResource> {
  const resource = await fetchWithDeadline(fetchImpl, url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "returner-fund-ingestion-wakeup/1.0"
    },
    cache: "no-store",
    redirect: "error"
  });
  if (resource.status === 404) return { status: "missing", text: null };
  if (!resource.ok) throw new Error("publication_state_http_failure");

  const declaredBytes = Number(resource.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > INGESTION_WAKE_MAX_MANIFEST_BYTES) {
    return { status: "available", text: "" };
  }
  const text = await resource.text();
  if (Buffer.byteLength(text, "utf8") > INGESTION_WAKE_MAX_MANIFEST_BYTES) {
    return { status: "available", text: "" };
  }
  return { status: "available", text };
}

function response(status: number, bodyStatus: CloudWakeupResult["body"]["status"]): CloudWakeupResult {
  return { body: { status: bodyStatus }, status };
}
