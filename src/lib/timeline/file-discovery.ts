import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { TimelineSourceCoverageState, TimelineSourceType } from "./contracts";
import type { TimelineClassificationSource } from "./domain";
import {
  dispatchTimelineSourceClass,
  type TimelineDiscoveryHandlerResult,
  type TimelineIngestionCompany,
} from "./ingestion-runner";
import type { TimelineSourceClass } from "./coordinator";
import { canonicalizeSourceUrl, sanitizeEvidenceExcerpt } from "./source-document";
import { createConfiguredTimelineSearchProviders, type TimelineSearchProvider } from "./search";

export const TIMELINE_PUBLIC_DISCOVERY_SCHEMA_VERSION = "company-timeline-public-discovery.v1" as const;
export const TIMELINE_PUBLIC_DISCOVERY_RUNNER_VERSION = "timeline-public-discovery-runner-2026-08-02.v1" as const;
export const DEFAULT_TIMELINE_PUBLIC_DISCOVERY_PATH =
  "artifacts/company-timeline/public-discovery-current.json" as const;

/**
 * File-backed discovery intentionally excludes canonical graph evidence and
 * reconciliation. Those classes already have authoritative file-backed
 * inputs. This lane only unlocks public pages that do not require a social
 * login or a production database.
 */
export const TIMELINE_PUBLIC_DISCOVERY_SOURCE_CLASSES = [
  "timeline_official_site",
  "timeline_institutional_sources",
  "timeline_historical_archive",
  "timeline_public_web",
  "timeline_gap_followup",
] as const satisfies readonly TimelineSourceClass[];

type TimelinePublicDiscoverySourceClass = (typeof TIMELINE_PUBLIC_DISCOVERY_SOURCE_CLASSES)[number];

export interface TimelinePublicDiscoveryCompanyRecord {
  companyId: string;
  companyName: string;
  scannedAt: string;
  coverage: Partial<Record<TimelinePublicDiscoverySourceClass, TimelineSourceCoverageState>>;
  sources: TimelineClassificationSource[];
}

export interface TimelinePublicDiscoverySnapshot {
  schemaVersion: typeof TIMELINE_PUBLIC_DISCOVERY_SCHEMA_VERSION;
  runnerVersion: typeof TIMELINE_PUBLIC_DISCOVERY_RUNNER_VERSION;
  generatedAt: string;
  inventorySha256: string;
  companies: TimelinePublicDiscoveryCompanyRecord[];
}

export interface TimelinePublicDiscoveryLoadResult {
  snapshot: TimelinePublicDiscoverySnapshot;
  sha256: string;
  path: string | null;
}

export interface RunTimelinePublicDiscoveryInput {
  companies: readonly TimelineIngestionCompany[];
  inventorySha256: string;
  outputPath?: string;
  env?: NodeJS.ProcessEnv;
  providers?: readonly TimelineSearchProvider[];
  budgetMs?: number;
  concurrency?: number;
  maxCompanies?: number;
  perFetchTimeoutMs?: number;
  rescanAfterMs?: number;
  now?: () => Date;
  discover?: (
    sourceClass: TimelineSourceClass,
    company: TimelineIngestionCompany,
    context: {
      networkAllowed: boolean;
      perFetchTimeoutMs: number;
      providers: readonly TimelineSearchProvider[];
      deadlineAt?: number;
    },
  ) => Promise<TimelineDiscoveryHandlerResult>;
  logger?: (message: string, data?: Record<string, unknown>) => void;
}

export interface TimelinePublicDiscoveryReceipt {
  status: "completed" | "budget_exhausted";
  version: typeof TIMELINE_PUBLIC_DISCOVERY_RUNNER_VERSION;
  inventoryCompanies: number;
  selectedCompanies: number;
  scannedCompanies: number;
  sourceDocuments: number;
  outputPath: string;
  durationMs: number;
}

const SOURCE_TYPES = new Set<TimelineSourceType>([
  "company_page", "company_blog", "press_release", "changelog", "news_article",
  "accelerator_profile", "investor_page", "customer_page", "partner_page",
  "founder_post", "company_post", "product_hunt", "github_repository", "github_release",
  "research_publication", "patent", "regulatory_filing", "archived_page", "video",
  "podcast", "other",
]);
const COVERAGE_STATES = new Set<TimelineSourceCoverageState>([
  "pending", "running", "completed", "failed", "retry_pending",
  "rate_limited", "blocked", "authentication_required", "no_applicable_source", "no_results",
]);

/**
 * Run a small, resumable public-web shard without Supabase. A later invocation
 * selects never-scanned companies first, then the stalest records. Every page
 * still passes through the SSRF-safe fetcher and deterministic identity gate
 * in the normal discovery dispatcher.
 */
export async function runFileBackedTimelinePublicDiscovery(
  input: RunTimelinePublicDiscoveryInput,
): Promise<TimelinePublicDiscoveryReceipt> {
  const startedAt = (input.now ?? (() => new Date()))();
  const now = input.now ?? (() => new Date());
  const budgetMs = clamp(input.budgetMs ?? 3 * 60_000, 10_000, 10 * 60_000);
  const deadline = startedAt.getTime() + budgetMs;
  const concurrency = clamp(input.concurrency ?? 2, 1, 4);
  const maxCompanies = clamp(input.maxCompanies ?? 12, 1, 50);
  const perFetchTimeoutMs = clamp(input.perFetchTimeoutMs ?? 6_000, 1_000, 12_000);
  const rescanAfterMs = clamp(input.rescanAfterMs ?? 7 * 86_400_000, 60_000, 90 * 86_400_000);
  const outputPath = resolve(input.outputPath ?? DEFAULT_TIMELINE_PUBLIC_DISCOVERY_PATH);
  const previous = await loadTimelinePublicDiscoverySnapshot(outputPath);
  const previousSnapshot = previous?.snapshot.inventorySha256 === input.inventorySha256
    ? previous.snapshot
    : emptySnapshot(input.inventorySha256, startedAt.toISOString());
  const records = new Map(previousSnapshot.companies.map((record) => [record.companyId, record]));
  const inventory = normalizeInventory(input.companies);
  const eligible = inventory.filter((company) => {
    const prior = records.get(company.id);
    const incomplete = prior
      ? TIMELINE_PUBLIC_DISCOVERY_SOURCE_CLASSES.some((sourceClass) => !prior.coverage[sourceClass])
      : true;
    return !prior || incomplete || startedAt.getTime() - Date.parse(prior.scannedAt) >= rescanAfterMs;
  }).sort((left, right) => {
    const leftAt = Date.parse(records.get(left.id)?.scannedAt ?? "1970-01-01T00:00:00.000Z");
    const rightAt = Date.parse(records.get(right.id)?.scannedAt ?? "1970-01-01T00:00:00.000Z");
    return leftAt - rightAt || left.id.localeCompare(right.id);
  }).slice(0, maxCompanies);
  const providers = [...(input.providers ?? createConfiguredTimelineSearchProviders(input.env ?? process.env))];
  const discover = input.discover ?? dispatchTimelineSourceClass;
  const log = input.logger ?? (() => undefined);
  let cursor = 0;
  let scannedCompanies = 0;
  let sourceDocuments = 0;
  let snapshotWrite: Promise<void> = Promise.resolve();

  const persistSnapshot = (generatedAt: string): Promise<void> => {
    const write = snapshotWrite.then(() => atomicWriteJson(
      outputPath,
      snapshotFromRecords(input.inventorySha256, generatedAt, records, inventory),
    ));
    // Keep the queue usable after surfacing a write failure to its caller.
    snapshotWrite = write.catch(() => undefined);
    return write;
  };

  const workers = Array.from({ length: Math.min(concurrency, eligible.length) }, async () => {
    while (cursor < eligible.length) {
      if (now().getTime() >= deadline) return;
      const company = eligible[cursor++];
      if (!company) return;
      const coverage: TimelinePublicDiscoveryCompanyRecord["coverage"] = {};
      const sources: TimelineClassificationSource[] = [];
      for (const sourceClass of TIMELINE_PUBLIC_DISCOVERY_SOURCE_CLASSES) {
        if (now().getTime() >= deadline) break;
        try {
          const result = await discover(sourceClass, company, {
            networkAllowed: true,
            perFetchTimeoutMs,
            providers,
            deadlineAt: deadline,
          });
          coverage[sourceClass] = terminalCoverage(result.status);
          sources.push(...result.sources.map(sanitizeSnapshotSource));
        } catch (error) {
          coverage[sourceClass] = "failed";
          log("file-backed timeline public discovery source failed", {
            companyId: company.id,
            sourceClass,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const scannedAt = now().toISOString();
      const prior = records.get(company.id);
      const completedAllClasses = TIMELINE_PUBLIC_DISCOVERY_SOURCE_CLASSES.every((sourceClass) => coverage[sourceClass]);
      records.set(company.id, {
        companyId: company.id,
        companyName: company.name,
        scannedAt,
        coverage: completedAllClasses ? coverage : { ...(prior?.coverage ?? {}), ...coverage },
        // Discovery is additive. A temporary 404, provider outage, archive
        // throttle, or zero-result scan is not evidence that a previously
        // verified direct source ceased to exist, so it cannot erase the
        // last-good event input. Explicit source retirement belongs in the
        // reviewed durable workflow.
        sources: dedupeSources([...(prior?.sources ?? []), ...sources]),
      });
      scannedCompanies += 1;
      sourceDocuments += sources.length;
      await persistSnapshot(scannedAt);
      log("file-backed timeline public discovery company completed", {
        companyId: company.id,
        sourceDocuments: sources.length,
        completedSourceClasses: Object.keys(coverage).length,
      });
    }
  });
  await Promise.all(workers);

  if (!scannedCompanies && !previous) {
    await atomicWriteJson(outputPath, emptySnapshot(input.inventorySha256, startedAt.toISOString()));
  }
  return {
    status: cursor < eligible.length || now().getTime() >= deadline ? "budget_exhausted" : "completed",
    version: TIMELINE_PUBLIC_DISCOVERY_RUNNER_VERSION,
    inventoryCompanies: inventory.length,
    selectedCompanies: eligible.length,
    scannedCompanies,
    sourceDocuments,
    outputPath,
    durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
  };
}

export async function loadTimelinePublicDiscoverySnapshot(
  path: string,
): Promise<TimelinePublicDiscoveryLoadResult | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = validateSnapshot(JSON.parse(bytes.toString("utf8")));
  return { snapshot: parsed, sha256: sha256(bytes), path };
}

export function timelinePublicDiscoverySnapshotFromValue(value: unknown): TimelinePublicDiscoveryLoadResult {
  const snapshot = validateSnapshot(value);
  const bytes = Buffer.from(stableStringify(snapshot));
  return { snapshot, sha256: sha256(bytes), path: null };
}

function snapshotFromRecords(
  inventorySha256: string,
  generatedAt: string,
  records: ReadonlyMap<string, TimelinePublicDiscoveryCompanyRecord>,
  inventory: readonly TimelineIngestionCompany[],
): TimelinePublicDiscoverySnapshot {
  const known = new Set(inventory.map((company) => company.id));
  return {
    schemaVersion: TIMELINE_PUBLIC_DISCOVERY_SCHEMA_VERSION,
    runnerVersion: TIMELINE_PUBLIC_DISCOVERY_RUNNER_VERSION,
    generatedAt,
    inventorySha256,
    companies: [...records.values()].filter((record) => known.has(record.companyId))
      .sort((left, right) => left.companyId.localeCompare(right.companyId)),
  };
}

function emptySnapshot(inventorySha256: string, generatedAt: string): TimelinePublicDiscoverySnapshot {
  return {
    schemaVersion: TIMELINE_PUBLIC_DISCOVERY_SCHEMA_VERSION,
    runnerVersion: TIMELINE_PUBLIC_DISCOVERY_RUNNER_VERSION,
    generatedAt,
    inventorySha256,
    companies: [],
  };
}

function validateSnapshot(value: unknown): TimelinePublicDiscoverySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Timeline public discovery snapshot must be an object.");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== TIMELINE_PUBLIC_DISCOVERY_SCHEMA_VERSION
      || raw.runnerVersion !== TIMELINE_PUBLIC_DISCOVERY_RUNNER_VERSION) {
    throw new TypeError("Timeline public discovery snapshot has an unsupported version.");
  }
  const generatedAt = exactTimestamp(raw.generatedAt, "generatedAt");
  const inventorySha256 = text(raw.inventorySha256, 64, "inventorySha256");
  if (!/^[0-9a-f]{64}$/i.test(inventorySha256)) throw new TypeError("Timeline public discovery inventory hash is invalid.");
  if (!Array.isArray(raw.companies) || raw.companies.length > 10_000) throw new TypeError("Timeline public discovery companies must be a bounded array.");
  const seen = new Set<string>();
  const companies = raw.companies.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new TypeError("Timeline public discovery company record is invalid.");
    const row = item as Record<string, unknown>;
    const companyId = text(row.companyId, 180, "companyId");
    if (seen.has(companyId)) throw new TypeError(`Duplicate Timeline public discovery company ${companyId}.`);
    seen.add(companyId);
    const rawCoverage = row.coverage;
    if (!rawCoverage || typeof rawCoverage !== "object" || Array.isArray(rawCoverage)) throw new TypeError("Timeline public discovery coverage is invalid.");
    const coverage: TimelinePublicDiscoveryCompanyRecord["coverage"] = {};
    for (const [sourceClass, status] of Object.entries(rawCoverage)) {
      if (!(TIMELINE_PUBLIC_DISCOVERY_SOURCE_CLASSES as readonly string[]).includes(sourceClass)
          || typeof status !== "string" || !COVERAGE_STATES.has(status as TimelineSourceCoverageState)) {
        throw new TypeError(`Timeline public discovery coverage entry ${sourceClass} is invalid.`);
      }
      coverage[sourceClass as TimelinePublicDiscoverySourceClass] = status as TimelineSourceCoverageState;
    }
    if (!Array.isArray(row.sources) || row.sources.length > 500) throw new TypeError("Timeline public discovery sources must be a bounded array.");
    return {
      companyId,
      companyName: text(row.companyName, 240, "companyName"),
      scannedAt: exactTimestamp(row.scannedAt, "scannedAt"),
      coverage,
      sources: dedupeSources(row.sources.map(validateSource)),
    };
  });
  return {
    schemaVersion: TIMELINE_PUBLIC_DISCOVERY_SCHEMA_VERSION,
    runnerVersion: TIMELINE_PUBLIC_DISCOVERY_RUNNER_VERSION,
    generatedAt,
    inventorySha256: inventorySha256.toLowerCase(),
    companies: companies.sort((left, right) => left.companyId.localeCompare(right.companyId)),
  };
}

function validateSource(value: unknown): TimelineClassificationSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Timeline public discovery source is invalid.");
  const raw = value as Record<string, unknown>;
  const sourceType = text(raw.sourceType, 80, "sourceType") as TimelineSourceType;
  if (!SOURCE_TYPES.has(sourceType)) throw new TypeError(`Timeline public discovery source type ${sourceType} is invalid.`);
  const tier = Number(raw.sourceQualityTier);
  if (![1, 2, 3].includes(tier)) throw new TypeError("Timeline public discovery source quality tier is invalid.");
  const precision = text(raw.publicationDatePrecision, 20, "publicationDatePrecision") as TimelineClassificationSource["publicationDatePrecision"];
  if (!["exact", "day", "unknown"].includes(precision)) throw new TypeError("Timeline public discovery date precision is invalid.");
  const attribution = text(raw.attributionStatus, 20, "attributionStatus") as TimelineClassificationSource["attributionStatus"];
  if (!["verified", "needs_review", "rejected"].includes(attribution)) throw new TypeError("Timeline public discovery attribution is invalid.");
  const relationship = text(raw.authorRelationship, 20, "authorRelationship") as TimelineClassificationSource["authorRelationship"];
  if (!["company", "founder", "third_party", "unknown"].includes(relationship)) throw new TypeError("Timeline public discovery author relationship is invalid.");
  const linkStatus = raw.linkStatus === null ? null : text(raw.linkStatus, 20, "linkStatus") as TimelineClassificationSource["linkStatus"];
  if (linkStatus !== null && !["verified", "unchecked", "blocked", "invalid"].includes(linkStatus)) throw new TypeError("Timeline public discovery link status is invalid.");
  return sanitizeSnapshotSource({
    id: text(raw.id, 180, "id"),
    url: canonicalizeSourceUrl(text(raw.url, 2_000, "url")),
    originalUrl: optionalUrl(raw.originalUrl),
    canonicalUrl: optionalUrl(raw.canonicalUrl),
    title: optionalText(raw.title, 300),
    publisher: optionalText(raw.publisher, 200),
    author: optionalText(raw.author, 200),
    sourceType,
    platform: optionalText(raw.platform, 80),
    publicationTimestamp: optionalTimestamp(raw.publicationTimestamp),
    updatedTimestamp: optionalTimestamp(raw.updatedTimestamp),
    publicationDatePrecision: precision,
    text: text(raw.text, 20_000, "text"),
    evidenceExcerpt: text(raw.evidenceExcerpt, 1_000, "evidenceExcerpt"),
    sourceQualityTier: tier as 1 | 2 | 3,
    attributionStatus: attribution,
    linkStatus,
    topic: optionalText(raw.topic, 160),
    authorRelationship: relationship,
    httpStatus: raw.httpStatus === null || raw.httpStatus === undefined ? null : Number(raw.httpStatus),
  });
}

function sanitizeSnapshotSource(source: TimelineClassificationSource): TimelineClassificationSource {
  const publicationTimestamp = optionalTimestamp(source.publicationTimestamp);
  const updatedTimestamp = optionalTimestamp(source.updatedTimestamp);
  return {
    id: text(source.id, 180, "id"),
    url: canonicalizeSourceUrl(source.url),
    originalUrl: source.originalUrl ? canonicalizeSourceUrl(source.originalUrl) : undefined,
    canonicalUrl: source.canonicalUrl ? canonicalizeSourceUrl(source.canonicalUrl) : null,
    title: optionalText(source.title, 300),
    publisher: optionalText(source.publisher, 200),
    author: optionalText(source.author, 200),
    sourceType: source.sourceType,
    platform: optionalText(source.platform, 80),
    publicationTimestamp,
    updatedTimestamp,
    publicationDatePrecision: publicationTimestamp ? source.publicationDatePrecision : "unknown",
    text: sanitizeEvidenceExcerpt(source.text, 20_000),
    evidenceExcerpt: sanitizeEvidenceExcerpt(source.evidenceExcerpt, 1_000),
    sourceQualityTier: source.sourceQualityTier,
    attributionStatus: source.attributionStatus,
    linkStatus: source.linkStatus,
    topic: optionalText(source.topic, 160),
    authorRelationship: source.authorRelationship,
    httpStatus: Number.isInteger(source.httpStatus) && Number(source.httpStatus) >= 100 && Number(source.httpStatus) <= 599
      ? Number(source.httpStatus) : null,
    // Deliberately omit page metadata from this portable cache. The evidence
    // fields above are sufficient for deterministic publication and cannot
    // carry an accidentally reflected credential or oversized JSON-LD blob.
  };
}

function normalizeInventory(companies: readonly TimelineIngestionCompany[]): TimelineIngestionCompany[] {
  const byId = new Map<string, TimelineIngestionCompany>();
  for (const company of companies) {
    if (!byId.has(company.id)) byId.set(company.id, company);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function dedupeSources(sources: readonly TimelineClassificationSource[]): TimelineClassificationSource[] {
  const byUrl = new Map<string, TimelineClassificationSource>();
  for (const source of sources) {
    const sanitized = sanitizeSnapshotSource(source);
    const url = canonicalizeSourceUrl(sanitized.canonicalUrl ?? sanitized.url);
    const prior = byUrl.get(url);
    if (!prior || sanitized.sourceQualityTier < prior.sourceQualityTier) byUrl.set(url, sanitized);
  }
  return [...byUrl.values()].sort((left, right) =>
    left.sourceQualityTier - right.sourceQualityTier || left.id.localeCompare(right.id)
  );
}

function terminalCoverage(status: TimelineDiscoveryHandlerResult["status"]): TimelineSourceCoverageState {
  return status === "rate_limited" ? "blocked" : status;
}

function optionalUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return canonicalizeSourceUrl(text(value, 2_000, "url"));
}

function optionalTimestamp(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return exactTimestamp(value, "timestamp");
}

function exactTimestamp(value: unknown, field: string): string {
  const normalized = text(value, 80, field);
  const date = new Date(normalized);
  if (Number.isNaN(date.valueOf())) throw new TypeError(`Timeline public discovery ${field} is invalid.`);
  return date.toISOString();
}

function optionalText(value: unknown, maximum: number): string | null {
  if (value === undefined || value === null) return null;
  const normalized = String(value).replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function text(value: unknown, maximum: number, field: string): string {
  if (typeof value !== "string") throw new TypeError(`Timeline public discovery ${field} must be text.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new TypeError(`Timeline public discovery ${field} is invalid.`);
  return normalized;
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${stableStringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)));
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(Math.floor(value), minimum), maximum);
}
