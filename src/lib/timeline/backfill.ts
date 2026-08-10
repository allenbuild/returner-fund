import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PLATFORM_VALUES, type EvidenceItem, type GraphNode, type GraphResponse } from "@/lib/graph/types";
import { getCatalog } from "@/lib/seo/catalog";
import {
  TIMELINE_ARTIFACT_SCHEMA_VERSION,
  TIMELINE_CATEGORIES,
  TIMELINE_COVERAGE_SCHEMA_VERSION,
  TIMELINE_EVENT_DATE_TYPES,
  TIMELINE_EVENT_DETAIL_SCHEMA_VERSION,
  TIMELINE_PUBLIC_INDEX_SCHEMA_VERSION,
  type CompanyTimelineArtifact,
  type CompanyTimelineEventDetailArtifact,
  type PublishedTimelineEvent,
  type TimelineCoverageManifest,
  type TimelineCoverageManifestCompany,
  type TimelineEvidenceDetail,
  type TimelineMonthGroup,
  type TimelinePostEvidence,
  type TimelinePublicIndex,
  type TimelineSourceCoverageState,
} from "./contracts";
import {
  classifySourceDeterministically,
  timelineClassificationSourceFromGraphEvidence,
} from "./classification";
import { isoDateFromExactTimestamp } from "./validation";
import { clusterTimelineEvents, shouldMergeTimelineEvents } from "./dedupe";
import type {
  TimelineCandidateProposal,
  TimelineClassificationInput,
  TimelineClassificationSource,
} from "./domain";
import { canonicalizeSourceUrl, sanitizeEvidenceExcerpt } from "./source-document";
import {
  loadPublishedTimelineDatabaseSnapshot,
  type TimelineDatabaseCompanySnapshot,
  type TimelineDatabaseEventBundle,
  type TimelineDatabaseSnapshot,
} from "./database-backfill";
import {
  DEFAULT_TIMELINE_PUBLIC_DISCOVERY_PATH,
  loadTimelinePublicDiscoverySnapshot,
  timelinePublicDiscoverySnapshotFromValue,
  type TimelinePublicDiscoveryCompanyRecord,
  type TimelinePublicDiscoverySnapshot,
} from "./file-discovery";
import type { TimelineIngestionCompany } from "./ingestion-runner";

const SOURCE_ARTIFACT_PREFIX = "public/graph";
const DEFAULT_VOLUME_EVIDENCE_PATH = "src/lib/social/volume-evidence-current.json";
const CANONICAL_DIRECT_EVIDENCE_PATHS = [
  "src/lib/social/public-evidence-current.json",
  "src/lib/social/logged-in-evidence-current.json",
  "src/lib/social/targeted-evidence-current.json",
  "src/lib/social/volume-evidence-current.json",
] as const;
const CANONICAL_GRAPH_RUNTIME_EVIDENCE_PATHS = [
  "generated-runtime/graph/public-evidence-current.json",
  "generated-runtime/graph/logged-in-evidence-current.json",
  "generated-runtime/graph/targeted-evidence-current.json",
  "generated-runtime/graph/volume-evidence-current.json",
] as const;
const DEFAULT_CHECKPOINT = "work/timeline-backfill-checkpoint.json";
const INTERNAL_COVERAGE_PATH = "artifacts/company-timeline/coverage.json";
const PUBLIC_INDEX_PATH = "public/timelines/coverage.json";
const TIMELINE_BACKFILL_CHECKPOINT_SCHEMA_VERSION = "company-timeline-backfill-checkpoint.v2" as const;
const TIMELINE_BACKFILL_BUILD_ENTRY = "src/lib/timeline/backfill.ts";
const TIMELINE_BACKFILL_SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const LOCAL_MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx", ".json"] as const;
const MANAGED_DETAIL_FILENAME = /^tle-[a-f0-9]{24}\.json$/;
const MANAGED_DATABASE_DETAIL_FILENAME = /^tldb-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i;
const TIMELINE_SOURCE_TYPE_VALUES = new Set([
  "company_page", "company_blog", "press_release", "changelog", "news_article",
  "accelerator_profile", "investor_page", "customer_page", "partner_page",
  "founder_post", "company_post", "product_hunt", "github_repository",
  "github_release", "research_publication", "patent", "regulatory_filing",
  "archived_page", "video", "podcast", "other",
]);
const TIMELINE_EVIDENCE_ROLE_VALUES = new Set(["primary", "supporting", "conflicting"]);

export interface TimelineBackfillOptions {
  rootDir?: string;
  dryRun?: boolean;
  resume?: boolean;
  force?: boolean;
  checkpointPath?: string;
  maxCompanies?: number;
  env?: NodeJS.ProcessEnv;
  databaseSnapshot?: TimelineDatabaseSnapshot;
  publicDiscoveryPath?: string;
  publicDiscoverySnapshot?: TimelinePublicDiscoverySnapshot;
  volumeEvidencePath?: string | null;
  canonicalEvidenceSnapshot?: TimelineCanonicalEvidenceSnapshot;
  logger?: (message: string, data?: Record<string, unknown>) => void;
}

export interface TimelineCanonicalEvidenceSnapshot {
  evidence: readonly EvidenceItem[];
  sourceArtifacts?: ReadonlyArray<{ path: string; sha256: string }>;
}

export interface TimelineBackfillResult {
  dryRun: boolean;
  generatedAt: string;
  inventoryRecords: number;
  uniqueCompanies: number;
  processedCompanies: number;
  resumedCompanies: number;
  publishedEvents: number;
  candidateEvents: number;
  unresolvedDates: number;
  coveragePath: string | null;
  inventorySha256: string;
}

export interface TimelinePublicDiscoveryInventory {
  inventorySha256: string;
  sourceArtifacts: Array<{ path: string; sha256: string }>;
  companies: TimelineIngestionCompany[];
}

interface CanonicalCompanyInventory {
  id: string;
  slug: string;
  name: string;
  nodes: GraphNode[];
  graphs: GraphResponse[];
  evidence: EvidenceItem[];
}

interface BackfillCheckpoint {
  schemaVersion: typeof TIMELINE_BACKFILL_CHECKPOINT_SCHEMA_VERSION;
  buildVersion: string;
  inventorySha256: string;
  sourceArtifacts: Array<{ path: string; sha256: string }>;
  databaseSha256: string;
  publicDiscoverySha256: string;
  completedCompanyIds: string[];
  detailArtifacts: Record<string, Array<{ path: string; sha256: string }>>;
  updatedAt: string;
}

interface ClassifiedEvent {
  proposal: TimelineCandidateProposal;
  source: TimelineClassificationSource;
  evidence: EvidenceItem | null;
}

interface CompanyBuildResult {
  artifact: CompanyTimelineArtifact;
  details: CompanyTimelineEventDetailArtifact[];
  manifest: TimelineCoverageManifestCompany;
}

export async function runCompanyTimelineBackfill(
  options: TimelineBackfillOptions = {},
): Promise<TimelineBackfillResult> {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const dryRun = options.dryRun ?? false;
  const resume = options.resume ?? false;
  const force = options.force ?? false;
  const maxCompanies = options.maxCompanies;
  if (maxCompanies !== undefined && (!Number.isInteger(maxCompanies) || maxCompanies < 1)) {
    throw new TypeError("maxCompanies must be a positive integer.");
  }
  if (maxCompanies !== undefined && !dryRun) {
    throw new TypeError("--max-companies is restricted to --dry-run so publication cannot omit companies.");
  }
  const log = options.logger ?? ((message, data) => console.log(JSON.stringify({ at: new Date().toISOString(), message, ...data })));
  const database = options.databaseSnapshot ?? await loadPublishedTimelineDatabaseSnapshot(options.env ?? process.env);
  if (database.status === "migration_unavailable") {
    throw new Error(
      "Company Timeline database projections are unavailable; refusing to replace last-good artifacts with a graph-only rebuild.",
    );
  }
  if ((options.env ?? process.env).TIMELINE_REQUIRE_DATABASE === "true" && database.status !== "loaded") {
    throw new Error(
      "TIMELINE_REQUIRE_DATABASE is enabled but the Company Timeline database snapshot is not configured.",
    );
  }
  const loaded = await loadCanonicalInventory(
    rootDir,
    options.volumeEvidencePath,
    options.canonicalEvidenceSnapshot,
  );
  const publicDiscovery = options.publicDiscoverySnapshot
    ? timelinePublicDiscoverySnapshotFromValue(options.publicDiscoverySnapshot)
    : await loadTimelinePublicDiscoverySnapshot(resolveWithinRoot(
      rootDir,
      options.publicDiscoveryPath ?? DEFAULT_TIMELINE_PUBLIC_DISCOVERY_PATH,
    ));
  const inventorySha256 = loaded.inventorySha256;
  // A stale discovery cache may describe a prior graph inventory. Ignore it
  // entirely rather than attaching a recycled company name or source to the
  // current canonical entity set.
  const usablePublicDiscovery = publicDiscovery?.snapshot.inventorySha256 === inventorySha256
    ? publicDiscovery
    : null;
  const publicDiscoveryByCompany = new Map(
    (usablePublicDiscovery?.snapshot.companies ?? []).map((record) => [record.companyId, record]),
  );
  const generatedAt = [loaded.generatedAt, database.generatedAt, usablePublicDiscovery?.snapshot.generatedAt]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1)!;
  // Derive compatibility from the complete local module graph that produces
  // Timeline artifacts. A classifier, dedupe, URL canonicalization, copy, or
  // database-projection edit therefore invalidates resume automatically; no
  // maintainer-controlled version bump is required.
  const TIMELINE_BACKFILL_BUILD_VERSION = await computeTimelineBackfillBuildFingerprint(TIMELINE_BACKFILL_SOURCE_ROOT);
  const checkpointAbsolutePath = resolveWithinRoot(rootDir, options.checkpointPath ?? DEFAULT_CHECKPOINT);
  const previousCheckpoint = resume && !force
    ? await readJsonIfPresent<BackfillCheckpoint>(checkpointAbsolutePath)
    : null;
  const checkpointCompatible = previousCheckpoint?.schemaVersion === TIMELINE_BACKFILL_CHECKPOINT_SCHEMA_VERSION
    && previousCheckpoint.buildVersion === TIMELINE_BACKFILL_BUILD_VERSION
    && previousCheckpoint.inventorySha256 === inventorySha256
    && JSON.stringify(previousCheckpoint.sourceArtifacts) === JSON.stringify(loaded.sourceArtifacts)
    && previousCheckpoint.databaseSha256 === database.sha256
    && previousCheckpoint.publicDiscoverySha256 === (usablePublicDiscovery?.sha256 ?? "not-configured")
    && Array.isArray(previousCheckpoint.completedCompanyIds)
    && previousCheckpoint.completedCompanyIds.every((companyId) => typeof companyId === "string" && companyId.length > 0)
    && isCheckpointDetailArtifactMap(previousCheckpoint.detailArtifacts);
  const completed = new Set(checkpointCompatible ? previousCheckpoint.completedCompanyIds : []);
  const checkpointDetails: BackfillCheckpoint["detailArtifacts"] = checkpointCompatible
    ? structuredClone(previousCheckpoint.detailArtifacts)
    : {};
  const previousManifest = checkpointCompatible
    ? await readJsonIfPresent<TimelineCoverageManifest>(join(rootDir, INTERNAL_COVERAGE_PATH))
    : null;
  const previousByCompany = new Map(
    (Array.isArray(previousManifest?.companies) ? previousManifest.companies : [])
      .map((item) => [item.company.id, item]),
  );

  const companies = maxCompanies ? loaded.companies.slice(0, maxCompanies) : loaded.companies;
  const manifestCompanies: TimelineCoverageManifestCompany[] = [];
  const desiredDetailFiles = new Set<string>();
  const pendingCompanyArtifacts = new Map<string, CompanyTimelineArtifact>();
  const pendingDetailArtifacts = new Map<string, CompanyTimelineEventDetailArtifact>();
  let processedCompanies = 0;
  let resumedCompanies = 0;

  for (const [index, company] of companies.entries()) {
    const prior = previousByCompany.get(company.id);
    if (!dryRun && resume && completed.has(company.id) && prior) {
      const priorArtifact = await readVerifiedCheckpointArtifacts({
        rootDir,
        company,
        manifest: prior,
        detailArtifacts: checkpointDetails[company.id],
      });
      if (priorArtifact) {
        manifestCompanies.push(prior);
        for (const event of priorArtifact.events) desiredDetailFiles.add(`${event.id}.json`);
        resumedCompanies += 1;
        continue;
      }
    }

    const built = buildCompanyTimeline(
      company,
      generatedAt,
      options.env ?? process.env,
      database.byCompanySourceKey.get(company.id),
      publicDiscoveryByCompany.get(company.id),
    );
    manifestCompanies.push(built.manifest);
    for (const detail of built.details) desiredDetailFiles.add(`${detail.event.id}.json`);
    processedCompanies += 1;

    if (!dryRun) {
      // Keep newly generated files off the published tree until the complete
      // manifest and every company/detail artifact can be published together.
      // Hash the exact bytes that will be staged, not a partially published
      // file in the live tree.
      built.manifest.artifactSha256 = sha256(serializeJson(built.artifact));
      pendingCompanyArtifacts.set(built.manifest.artifactPath, built.artifact);
      for (const detail of built.details) {
        pendingDetailArtifacts.set(`public/timelines/events/${detail.event.id}.json`, detail);
      }
      checkpointDetails[company.id] = built.details.map((detail) => {
        const path = `public/timelines/events/${detail.event.id}.json`;
        return { path, sha256: sha256(serializeJson(detail)) };
      });
      completed.add(company.id);
    }
    log("timeline company processed", {
      companyId: company.id,
      companyIndex: index + 1,
      companyCount: companies.length,
      publishedEvents: built.artifact.events.length,
      status: built.manifest.status,
      databaseStatus: database.status,
    });
  }

  // A real publication always contains the full authoritative inventory.
  const manifest = buildTimelineCoverageManifest({
    generatedAt,
    inventorySha256,
    sourceArtifacts: loaded.sourceArtifacts,
    inventoryRecords: loaded.inventoryRecords,
    uniqueCompanies: loaded.companies.length,
    manifestCompanies,
  });
  const {
    publishedEvents,
    candidates: candidateEvents,
    unresolvedDates,
  } = manifest.totals;

  if (!dryRun) {
    const publicIndex: TimelinePublicIndex = {
      schemaVersion: TIMELINE_PUBLIC_INDEX_SCHEMA_VERSION,
      generatedAt,
      companyCount: manifest.totals.uniqueCompanies,
      publishedEventCount: manifest.totals.publishedEvents,
    };
    await publishTimelineArtifacts({
      rootDir,
      manifest,
      publicIndex,
      pendingCompanyArtifacts,
      pendingDetailArtifacts,
      desiredDetailFiles,
    });
    await atomicWriteJson(checkpointAbsolutePath, {
      schemaVersion: TIMELINE_BACKFILL_CHECKPOINT_SCHEMA_VERSION,
      buildVersion: TIMELINE_BACKFILL_BUILD_VERSION,
      inventorySha256,
      sourceArtifacts: loaded.sourceArtifacts,
      databaseSha256: database.sha256,
      publicDiscoverySha256: usablePublicDiscovery?.sha256 ?? "not-configured",
      completedCompanyIds: [...completed].sort(),
      detailArtifacts: checkpointDetails,
      updatedAt: generatedAt,
    } satisfies BackfillCheckpoint);
  }

  return {
    dryRun,
    generatedAt,
    inventoryRecords: loaded.inventoryRecords,
    uniqueCompanies: loaded.companies.length,
    processedCompanies,
    resumedCompanies,
    publishedEvents,
    candidateEvents,
    unresolvedDates,
    coveragePath: dryRun ? null : INTERNAL_COVERAGE_PATH,
    inventorySha256,
  };
}

function buildTimelineCoverageManifest({
  generatedAt,
  inventorySha256,
  sourceArtifacts,
  inventoryRecords,
  uniqueCompanies,
  manifestCompanies,
}: {
  generatedAt: string;
  inventorySha256: string;
  sourceArtifacts: Array<{ path: string; sha256: string }>;
  inventoryRecords: number;
  uniqueCompanies: number;
  manifestCompanies: TimelineCoverageManifestCompany[];
}): TimelineCoverageManifest {
  const publishedEvents = manifestCompanies.reduce((sum, item) => sum + item.publishedEventCount, 0);
  const candidateEvents = manifestCompanies.reduce((sum, item) => sum + item.candidateEventCount, 0);
  const unresolvedDates = manifestCompanies.reduce((sum, item) => sum + item.unresolvedDateCount, 0);
  return {
    schemaVersion: TIMELINE_COVERAGE_SCHEMA_VERSION,
    generatedAt,
    inventorySha256,
    sourceArtifacts,
    totals: {
      inventoryRecords,
      uniqueCompanies,
      terminalUniqueCompanies: manifestCompanies.length,
      completeCompanies: manifestCompanies.filter((item) => item.status === "complete").length,
      partialCompanies: manifestCompanies.filter((item) => item.status === "partial").length,
      failedCompanies: manifestCompanies.filter((item) => item.status === "failed").length,
      publishedEvents,
      candidates: candidateEvents,
      unresolvedConflicts: manifestCompanies.reduce((sum, item) => sum + item.unresolvedConflictCount, 0),
      unresolvedDates,
    },
    companies: manifestCompanies.sort((left, right) => left.company.id.localeCompare(right.company.id)),
  };
}

async function publishTimelineArtifacts({
  rootDir,
  manifest,
  publicIndex,
  pendingCompanyArtifacts,
  pendingDetailArtifacts,
  desiredDetailFiles,
}: {
  rootDir: string;
  manifest: TimelineCoverageManifest;
  publicIndex: TimelinePublicIndex;
  pendingCompanyArtifacts: ReadonlyMap<string, CompanyTimelineArtifact>;
  pendingDetailArtifacts: ReadonlyMap<string, CompanyTimelineEventDetailArtifact>;
  desiredDetailFiles: ReadonlySet<string>;
}): Promise<void> {
  const timelineRoot = join(rootDir, "public", "timelines");
  const coveragePath = join(rootDir, INTERNAL_COVERAGE_PATH);
  await assertTimelineCompanyFilesAreRegular(timelineRoot);
  await mkdir(join(rootDir, "work"), { recursive: true });
  const stagingRoot = await mkdtemp(join(rootDir, "work", "timeline-publication-"));
  const stagedTimelineRoot = join(stagingRoot, "timelines");
  const stagedCoveragePath = join(stagingRoot, "coverage.json");

  try {
    const stagedCompaniesRoot = join(stagedTimelineRoot, "companies");
    const stagedEventsRoot = join(stagedTimelineRoot, "events");
    await mkdir(stagedCompaniesRoot, { recursive: true });
    await mkdir(stagedEventsRoot, { recursive: true });

    for (const entry of manifest.companies) {
      const relativePath = entry.artifactPath.slice("public/timelines/".length);
      const stagedPath = join(stagedTimelineRoot, relativePath);
      const generated = pendingCompanyArtifacts.get(entry.artifactPath);
      if (generated) {
        await atomicWriteJson(stagedPath, generated);
      } else {
        await copyFile(join(rootDir, entry.artifactPath), stagedPath);
      }
    }
    for (const filename of desiredDetailFiles) {
      if (!MANAGED_DETAIL_FILENAME.test(filename) && !MANAGED_DATABASE_DETAIL_FILENAME.test(filename)) {
        throw new Error(`Unexpected Company Timeline detail artifact: ${filename}`);
      }
      const relativePath = `public/timelines/events/${filename}`;
      const stagedPath = join(stagedTimelineRoot, "events", filename);
      const generated = pendingDetailArtifacts.get(relativePath);
      if (generated) {
        await atomicWriteJson(stagedPath, generated);
      } else {
        await copyFile(join(rootDir, relativePath), stagedPath);
      }
    }
    await atomicWriteJson(join(stagedTimelineRoot, "coverage.json"), publicIndex);
    await atomicWriteJson(stagedCoveragePath, manifest);
    await swapTimelinePublication({ timelineRoot, coveragePath, stagedTimelineRoot, stagedCoveragePath, stagingRoot });
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function assertTimelineCompanyFilesAreRegular(timelineRoot: string): Promise<void> {
  const companyRoot = join(timelineRoot, "companies");
  let entries;
  try {
    entries = await readdir(companyRoot, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.endsWith(".json") && !entry.isFile()) {
      throw new Error(`Company Timeline artifact path is not a regular file: ${entry.name}`);
    }
  }
}

async function swapTimelinePublication({
  timelineRoot,
  coveragePath,
  stagedTimelineRoot,
  stagedCoveragePath,
  stagingRoot,
}: {
  timelineRoot: string;
  coveragePath: string;
  stagedTimelineRoot: string;
  stagedCoveragePath: string;
  stagingRoot: string;
}): Promise<void> {
  const previousTimelineRoot = join(stagingRoot, "previous-timelines");
  const previousCoveragePath = join(stagingRoot, "previous-coverage.json");
  let previousTimelineMoved = false;
  let previousCoverageMoved = false;
  let stagedTimelineMoved = false;
  let stagedCoverageMoved = false;

  try {
    if (await pathExists(timelineRoot)) {
      await rename(timelineRoot, previousTimelineRoot);
      previousTimelineMoved = true;
    }
    if (await pathExists(coveragePath)) {
      await rename(coveragePath, previousCoveragePath);
      previousCoverageMoved = true;
    }
    await mkdir(dirname(timelineRoot), { recursive: true });
    await mkdir(dirname(coveragePath), { recursive: true });
    await rename(stagedTimelineRoot, timelineRoot);
    stagedTimelineMoved = true;
    await rename(stagedCoveragePath, coveragePath);
    stagedCoverageMoved = true;
    await rm(previousTimelineRoot, { recursive: true, force: true });
    await rm(previousCoveragePath, { force: true });
  } catch (error) {
    if (stagedCoverageMoved) await rename(coveragePath, stagedCoveragePath).catch(() => undefined);
    if (previousCoverageMoved) await rename(previousCoveragePath, coveragePath).catch(() => undefined);
    if (stagedTimelineMoved) await rename(timelineRoot, stagedTimelineRoot).catch(() => undefined);
    if (previousTimelineMoved) await rename(previousTimelineRoot, timelineRoot).catch(() => undefined);
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fingerprint every repository-local module reachable from the Timeline
 * artifact builder. This follows both relative imports and the project's `@/`
 * alias, so changes in transitive classification, dedupe, canonicalization,
 * copy, or database projection code make an existing checkpoint incompatible.
 */
export async function computeTimelineBackfillBuildFingerprint(
  rootDir: string,
  entryPaths: readonly string[] = [TIMELINE_BACKFILL_BUILD_ENTRY],
): Promise<string> {
  const root = resolve(rootDir);
  const sources = new Map<string, Buffer>();
  const pending = [...new Set(entryPaths.map(normalizeRepositoryPath))].sort().reverse();

  while (pending.length) {
    const repositoryPath = pending.pop()!;
    if (sources.has(repositoryPath)) continue;
    const absolutePath = resolveWithinRoot(root, repositoryPath);
    let bytes: Buffer;
    try {
      bytes = await readFile(absolutePath);
    } catch (error) {
      throw new Error(
        `Timeline build fingerprint could not read ${repositoryPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    sources.set(repositoryPath, bytes);

    const importerDirectory = dirname(absolutePath);
    for (const specifier of localModuleSpecifiers(bytes.toString("utf8"))) {
      const dependency = await resolveLocalModuleSpecifier(root, importerDirectory, specifier);
      if (!dependency || sources.has(dependency)) continue;
      pending.push(dependency);
      pending.sort((left, right) => right.localeCompare(left));
    }
  }

  const material = [
    "company-timeline-source-graph.v1",
    ...[...sources.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, bytes]) => `${path}\0${bytes.byteLength}\0${sha256(bytes)}`),
  ].join("\n");
  return `sha256:${sha256(Buffer.from(material, "utf8"))}`;
}

function localModuleSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  const staticImports = /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/g;
  const dynamicImports = /\bimport\s*\(\s*["']([^"']+)["']/g;
  for (const pattern of [staticImports, dynamicImports]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier?.startsWith(".") || specifier?.startsWith("@/")) specifiers.add(specifier);
    }
  }
  return [...specifiers].sort();
}

async function resolveLocalModuleSpecifier(
  rootDir: string,
  importerDirectory: string,
  specifier: string,
): Promise<string | null> {
  const base = specifier.startsWith("@/")
    ? resolveWithinRoot(rootDir, join("src", specifier.slice(2)))
    : resolve(importerDirectory, specifier);
  const extension = extname(base);
  const candidates = extension
    ? [base, ...LOCAL_MODULE_EXTENSIONS.map((item) => `${base.slice(0, -extension.length)}${item}`)]
    : [
      ...LOCAL_MODULE_EXTENSIONS.map((item) => `${base}${item}`),
      ...LOCAL_MODULE_EXTENSIONS.map((item) => join(base, `index${item}`)),
    ];
  for (const candidate of [...new Set(candidates)]) {
    const repositoryPath = normalizeRepositoryPath(relative(rootDir, candidate));
    if (repositoryPath.startsWith("../") || repositoryPath === "..") {
      throw new TypeError(`Timeline build dependency escapes the repository root: ${specifier}`);
    }
    try {
      await readFile(candidate);
      return repositoryPath;
    } catch {
      // Try the next source extension. Missing external packages never enter
      // this path because callers only pass relative or `@/` specifiers.
    }
  }
  throw new Error(`Timeline build fingerprint could not resolve local module ${specifier}.`);
}

function normalizeRepositoryPath(value: string): string {
  return value.split(sep).join("/").replace(/^\.\//, "");
}

async function readVerifiedCheckpointArtifacts(input: {
  rootDir: string;
  company: CanonicalCompanyInventory;
  manifest: TimelineCoverageManifestCompany;
  detailArtifacts: Array<{ path: string; sha256: string }> | undefined;
}): Promise<CompanyTimelineArtifact | null> {
  try {
    const expectedArtifactPath = `public/timelines/companies/${input.company.slug}.json`;
    if (input.manifest.artifactPath !== expectedArtifactPath) return null;
    const artifactBytes = await readFile(resolveWithinRoot(input.rootDir, input.manifest.artifactPath));
    if (sha256(artifactBytes) !== input.manifest.artifactSha256) return null;
    const artifact = JSON.parse(artifactBytes.toString("utf8")) as unknown;
    if (!isResumeCompanyArtifact(artifact, input.company, input.manifest)) return null;

    const detailArtifacts = input.detailArtifacts;
    if (!Array.isArray(detailArtifacts) || detailArtifacts.length !== artifact.events.length) return null;
    const byPath = new Map(detailArtifacts.map((item) => [item.path, item]));
    if (byPath.size !== detailArtifacts.length) return null;

    for (const event of artifact.events) {
      const detailPath = `public/timelines/events/${event.id}.json`;
      const expected = byPath.get(detailPath);
      if (!expected) return null;
      const detailBytes = await readFile(resolveWithinRoot(input.rootDir, detailPath));
      if (sha256(detailBytes) !== expected.sha256) return null;
      const detail = JSON.parse(detailBytes.toString("utf8")) as unknown;
      if (!isResumeEventDetailArtifact(detail, artifact, event)) return null;
    }
    return artifact;
  } catch {
    // A partial write, invalid JSON, path violation, or malformed structure is
    // a cache miss. The caller rebuilds the company and atomically replaces
    // the stale artifacts, which makes resume self-healing.
    return null;
  }
}

function isResumeCompanyArtifact(
  value: unknown,
  company: CanonicalCompanyInventory,
  manifest: TimelineCoverageManifestCompany,
): value is CompanyTimelineArtifact {
  if (!isRecord(value) || value.schemaVersion !== TIMELINE_ARTIFACT_SCHEMA_VERSION) return false;
  if (!sameCompanyRef(value.company, { id: company.id, slug: company.slug, name: company.name })) return false;
  if (!isIsoTimestamp(value.generatedAt) || !isIsoTimestamp(value.lastModifiedAt)) return false;
  if (!Array.isArray(value.events) || !value.events.every(isResumePublishedEvent)) return false;
  if (new Set(value.events.map((event) => event.id)).size !== value.events.length) return false;
  if (!Array.isArray(value.groups) || !value.groups.every(isResumeMonthGroup)) return false;
  if (!isRecord(value.coverage)
      || !["pending", "in_progress", "complete", "partial", "failed"].includes(String(value.coverage.status))
      || !Number.isInteger(value.coverage.publishedEventCount)
      || value.coverage.publishedEventCount !== value.events.length
      || !(value.coverage.lastSuccessfulArtifactAt === null || isIsoTimestamp(value.coverage.lastSuccessfulArtifactAt))) {
    return false;
  }
  return value.nextCursor === null
    && manifest.publishedEventCount === value.events.length
    && manifest.company.id === company.id
    && manifest.company.slug === company.slug;
}

function isResumeEventDetailArtifact(
  value: unknown,
  artifact: CompanyTimelineArtifact,
  event: PublishedTimelineEvent,
): value is CompanyTimelineEventDetailArtifact {
  if (!isRecord(value) || value.schemaVersion !== TIMELINE_EVENT_DETAIL_SCHEMA_VERSION) return false;
  if (!sameCompanyRef(value.company, artifact.company)) return false;
  if (value.generatedAt !== artifact.generatedAt || value.lastModifiedAt !== artifact.lastModifiedAt) return false;
  if (!isRecord(value.event) || !isResumePublishedEvent(value.event) || value.event.id !== event.id) return false;

  const publicEvent = {
    id: value.event.id,
    eventDate: value.event.eventDate,
    eventDateType: value.event.eventDateType,
    title: value.event.title,
    summary: value.event.summary,
    category: value.event.category,
    isMajor: value.event.isMajor,
    hasConflict: value.event.hasConflict,
    conflictSummary: value.event.conflictSummary,
    evidenceCount: value.event.evidenceCount,
    sourcePreview: value.event.sourcePreview,
  } satisfies PublishedTimelineEvent;
  if (JSON.stringify(publicEvent) !== JSON.stringify(event)) return false;
  if (!Array.isArray(value.event.evidence) || value.event.evidence.length < 1) return false;
  if (value.event.evidenceCount !== value.event.evidence.length
      || !value.event.evidence.every(isResumeEvidenceDetail)) return false;
  if (!Array.isArray(value.event.posts) || !value.event.posts.every(isResumePostEvidence)) return false;

  const expectedPreview = value.event.evidence.slice(0, 3).map(sourcePreviewFromDetail);
  return JSON.stringify(expectedPreview) === JSON.stringify(value.event.sourcePreview);
}

function isResumePublishedEvent(value: unknown): value is PublishedTimelineEvent {
  if (!isRecord(value)
      || typeof value.id !== "string"
      || !/^[A-Za-z0-9._~:-]{1,180}$/.test(value.id)
      || !isExactIsoDateValue(value.eventDate)
      || !(TIMELINE_EVENT_DATE_TYPES as readonly unknown[]).includes(value.eventDateType)
      || typeof value.title !== "string" || value.title.trim().length < 3 || value.title.length > 180
      || typeof value.summary !== "string" || value.summary.trim().length < 8 || value.summary.length > 500
      || !(TIMELINE_CATEGORIES as readonly unknown[]).includes(value.category)
      || typeof value.isMajor !== "boolean"
      || typeof value.hasConflict !== "boolean"
      || !(value.conflictSummary === null || (typeof value.conflictSummary === "string" && value.conflictSummary.length <= 500))
      || !Number.isInteger(value.evidenceCount) || Number(value.evidenceCount) < 1
      || !Array.isArray(value.sourcePreview) || value.sourcePreview.length > 3
      || !value.sourcePreview.every(isResumeSourcePreview)) {
    return false;
  }
  return value.hasConflict ? typeof value.conflictSummary === "string" : value.conflictSummary === null;
}

function isResumeSourcePreview(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === "string" && value.id.length > 0
    && typeof value.title === "string" && value.title.trim().length > 0 && value.title.length <= 240
    && (value.publisher === null || (typeof value.publisher === "string" && value.publisher.length <= 160))
    && typeof value.domain === "string" && value.domain.length > 0
    && typeof value.sourceType === "string" && TIMELINE_SOURCE_TYPE_VALUES.has(value.sourceType)
    && (value.publishedAt === null || isExactDateOrTimestamp(value.publishedAt))
    && typeof value.evidenceRole === "string" && TIMELINE_EVIDENCE_ROLE_VALUES.has(value.evidenceRole)
    && isCanonicalSourceUrl(value.url, value.domain);
}

function isResumeEvidenceDetail(value: unknown): boolean {
  return isResumeSourcePreview(value)
    && isRecord(value)
    && (value.publicationDate === null || isExactDateOrTimestamp(value.publicationDate))
    && (value.excerpt === null || (typeof value.excerpt === "string" && value.excerpt.length <= 500))
    && (value.sourceEventDate === null || isExactIsoDateValue(value.sourceEventDate))
    && typeof value.isConflicting === "boolean"
    && (value.conflictDescription === null
      || (typeof value.conflictDescription === "string" && value.conflictDescription.length <= 500))
    && (value.isConflicting ? value.evidenceRole === "conflicting" : value.conflictDescription === null);
}

function isResumePostEvidence(value: unknown): boolean {
  if (!isRecord(value)
      || typeof value.id !== "string" || value.id.length < 1
      || typeof value.platform !== "string" || value.platform.length < 1 || value.platform.length > 64
      || !(value.account === null || (typeof value.account === "string" && value.account.length <= 160))
      || !isExactIsoDateValue(value.postDate)
      || !(value.excerpt === null || (typeof value.excerpt === "string" && value.excerpt.length <= 500))
      || !isCanonicalSourceUrl(value.url)
      || typeof value.evidenceRole !== "string" || !TIMELINE_EVIDENCE_ROLE_VALUES.has(value.evidenceRole)
      || !isRecord(value.metrics)) return false;
  return Object.entries(value.metrics).every(([key, metric]) =>
    /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)
      && (metric === null || (typeof metric === "number" && Number.isFinite(metric)))
  );
}

function isResumeMonthGroup(value: unknown): boolean {
  return isRecord(value)
    && Number.isInteger(value.year)
    && Number(value.year) >= 1900 && Number(value.year) <= 2200
    && Array.isArray(value.months)
    && value.months.every((month) => isRecord(month)
      && typeof month.month === "string" && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(month.month)
      && Number.isInteger(month.count) && Number(month.count) > 0);
}

function isCanonicalSourceUrl(value: unknown, expectedDomain?: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const canonical = canonicalizeSourceUrl(value);
    return canonical === value
      && (expectedDomain === undefined
        || new URL(canonical).hostname.replace(/^www\./, "").toLowerCase() === expectedDomain);
  } catch {
    return false;
  }
}

function sameCompanyRef(value: unknown, expected: { id: string; slug: string; name: string }): boolean {
  return isRecord(value)
    && value.id === expected.id
    && value.slug === expected.slug
    && value.name === expected.name;
}

function isCheckpointDetailArtifactMap(value: unknown): value is BackfillCheckpoint["detailArtifacts"] {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([companyId, artifacts]) =>
    companyId.length > 0
      && Array.isArray(artifacts)
      && artifacts.every((artifact) => isRecord(artifact)
        && typeof artifact.path === "string"
        && /^public\/timelines\/events\/[A-Za-z0-9._~:-]{1,180}\.json$/.test(artifact.path)
        && typeof artifact.sha256 === "string"
        && /^[a-f0-9]{64}$/.test(artifact.sha256))
  );
}

function isExactIsoDateValue(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(value)) return false;
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(new Date(value).valueOf());
}

function isExactDateOrTimestamp(value: unknown): value is string {
  return isExactIsoDateValue(value) || isIsoTimestamp(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadCanonicalInventory(
  rootDir: string,
  volumeEvidencePath?: string | null,
  canonicalEvidenceSnapshot?: TimelineCanonicalEvidenceSnapshot,
) {
  const graphEntries: Array<{ graph: GraphResponse; path: string; sha256: string }> = [];
  let inventoryRecords = 0;
  const inventoryForHash = new Map<string, { name: string; batches: string[] }>();
  const graphDirectory = join(rootDir, SOURCE_ARTIFACT_PREFIX);
  const baseGraphFilenames = (await readdir(graphDirectory))
    .filter(isTimelineBaseGraphFilename)
    .sort();
  if (!baseGraphFilenames.length) {
    throw new Error(`No canonical company graph artifacts were found in ${SOURCE_ARTIFACT_PREFIX}.`);
  }
  for (const filename of baseGraphFilenames) {
    const path = `${SOURCE_ARTIFACT_PREFIX}/${filename}`;
    const absolutePath = join(rootDir, path);
    const bytes = await readFile(absolutePath);
    const graph = JSON.parse(bytes.toString("utf8")) as GraphResponse;
    graphEntries.push({ graph, path, sha256: sha256(bytes) });
    for (const node of graph.nodes) {
      if (node.entityType !== "company") continue;
      inventoryRecords += 1;
      const existing = inventoryForHash.get(node.entityId) ?? { name: node.label, batches: [] };
      existing.batches.push(node.batchSlug);
      inventoryForHash.set(node.entityId, existing);
    }
  }
  const inventorySha256 = sha256(Buffer.from(JSON.stringify(
    [...inventoryForHash.entries()].sort(([left], [right]) => left.localeCompare(right)),
  )));
  const catalogSlugById = new Map<string, string>();
  for (const company of getCatalog().companies) {
    if (!catalogSlugById.has(company.node.entityId)) catalogSlugById.set(company.node.entityId, company.slug);
  }
  const companyIdBySlug = new Map(
    [...catalogSlugById.entries()].map(([companyId, slug]) => [slug, companyId]),
  );
  const byCompany = new Map<string, CanonicalCompanyInventory>();
  for (const entry of graphEntries) {
    const evidenceByEntity = groupEvidenceByCompany(entry.graph.evidence);
    for (const node of entry.graph.nodes) {
      if (node.entityType !== "company") continue;
      const existing = byCompany.get(node.entityId) ?? {
        id: node.entityId,
        slug: catalogSlugById.get(node.entityId) ?? slugify(node.label),
        name: node.label,
        nodes: [],
        graphs: [],
        evidence: [],
      };
      existing.nodes.push(node);
      existing.graphs.push(entry.graph);
      existing.evidence.push(...(evidenceByEntity.get(node.entityId) ?? []));
      byCompany.set(node.entityId, existing);
    }
  }
  for (const company of byCompany.values()) {
    companyIdBySlug.set(catalogSlugById.get(company.id) ?? slugify(company.name), company.id);
  }
  const founderCompanyIdById = new Map<string, string>();
  const companyIdByBatchAndSlug = new Map<string, string>();
  const companyIdsByUnqualifiedSlug = new Map<string, Set<string>>();
  for (const company of byCompany.values()) {
    for (const node of company.nodes) {
      const slugs = new Set([
        catalogSlugById.get(company.id),
        slugify(node.label),
        slugify(company.name),
      ].filter((value): value is string => Boolean(value)));
      for (const slug of slugs) {
        companyIdByBatchAndSlug.set(`${node.batchSlug.toUpperCase()}|${slug}`, company.id);
        const companyIds = companyIdsByUnqualifiedSlug.get(slug) ?? new Set<string>();
        companyIds.add(company.id);
        companyIdsByUnqualifiedSlug.set(slug, companyIds);
      }
      for (const founder of node.founders) founderCompanyIdById.set(founder.id, company.id);
    }
  }
  const canonicalEvidence = canonicalEvidenceSnapshot
    ?? await loadCanonicalCohortEvidenceSnapshot(rootDir);
  for (const evidence of canonicalEvidence?.evidence ?? []) {
    const companyId = resolveCanonicalEvidenceCompanyId(evidence, {
      byCompany,
      founderCompanyIdById,
      companyIdByBatchAndSlug,
      companyIdsByUnqualifiedSlug,
    });
    const company = companyId ? byCompany.get(companyId) : undefined;
    if (company) company.evidence.push(evidence);
  }
  // The full graph dataset already contains the accepted volume projection.
  // Keep the source hash in Timeline provenance without parsing and appending
  // the raw ledger a second time. Fixture/fallback mode still normalizes the
  // standalone volume artifact because no full graph projection is available.
  const volumeEvidence = canonicalEvidence
    ? null
    : await loadVolumeEvidence(rootDir, volumeEvidencePath);
  for (const evidence of volumeEvidence?.evidence ?? []) {
    const companyId = evidence.entityType === "company"
      ? evidence.entityId
      : evidence.attachedCompanyId ?? companyIdBySlug.get(evidence.companySlug ?? "");
    const company = companyId ? byCompany.get(companyId) : undefined;
    if (company) company.evidence.push(evidence);
  }
  const companies = [...byCompany.values()].map((company) => ({
    ...company,
    evidence: dedupeCompanyEvidence(company.evidence),
  })).sort((left, right) => left.id.localeCompare(right.id));
  const generatedAt = [
    ...graphEntries.map((entry) => entry.graph.generatedAt),
    ...(volumeEvidence?.generatedAt ? [volumeEvidence.generatedAt] : []),
  ].sort().at(-1) ?? new Date(0).toISOString();
  return {
    companies,
    inventoryRecords,
    inventorySha256,
    sourceArtifacts: mergeSourceArtifactDigests([
      ...graphEntries.map(({ path, sha256: digest }) => ({ path, sha256: digest })),
      ...(canonicalEvidence?.sourceArtifacts ?? []),
      ...(volumeEvidence ? [{ path: volumeEvidence.path, sha256: volumeEvidence.sha256 }] : []),
    ]),
    generatedAt,
  };
}

async function loadCanonicalCohortEvidenceSnapshot(
  rootDir: string,
): Promise<TimelineCanonicalEvidenceSnapshot | null> {
  const directSourcePresence = await Promise.all(
    CANONICAL_DIRECT_EVIDENCE_PATHS.map((path) => fileExists(resolveWithinRoot(rootDir, path))),
  );
  const primarySourcePresence = directSourcePresence.slice(0, 3);
  if (primarySourcePresence.every((present) => !present)) return null;
  if (directSourcePresence.some((present) => !present)) {
    throw new Error(
      "Canonical cohort evidence is incomplete: public, logged-in, targeted, and volume artifacts must be present together.",
    );
  }
  if (resolve(rootDir) !== resolve(process.cwd())) {
    throw new Error(
      "Canonical cohort evidence must be loaded with the repository root as the current working directory.",
    );
  }

  const missingRuntimePaths: string[] = [];
  for (const path of CANONICAL_GRAPH_RUNTIME_EVIDENCE_PATHS) {
    if (!await fileExists(resolveWithinRoot(rootDir, path))) missingRuntimePaths.push(path);
  }
  if (missingRuntimePaths.length) {
    throw new Error(
      `Canonical graph evidence projections are missing (${missingRuntimePaths.join(", ")}). Run npm run prepare:graph-runtime before Timeline backfill.`,
    );
  }

  // The graph dataset is the canonical normalization boundary for the direct
  // public, logged-in, targeted, volume, GitHub, and curated cohort sources.
  // Reading its full evidence projection keeps Timeline input in exact parity
  // with cohort graph construction instead of reinterpreting raw receipts or
  // relying on the bounded public graph previews.
  const { yc2026GraphDataset } = await import("@/lib/graph/yc-spring-2026-dataset");
  const sourceArtifacts: Array<{ path: string; sha256: string }> = [];
  for (const path of CANONICAL_DIRECT_EVIDENCE_PATHS) {
    const artifact = await loadEvidenceArtifactDigest(rootDir, path);
    if (!artifact) throw new Error(`Canonical cohort evidence artifact disappeared while loading: ${path}`);
    sourceArtifacts.push(artifact);
  }
  return { evidence: yc2026GraphDataset.evidence, sourceArtifacts };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function mergeSourceArtifactDigests(
  artifacts: ReadonlyArray<{ path: string; sha256: string }>,
): Array<{ path: string; sha256: string }> {
  const byPath = new Map<string, { path: string; sha256: string }>();
  for (const artifact of artifacts) {
    const path = normalizeRepositoryPath(artifact.path);
    const prior = byPath.get(path);
    if (prior && prior.sha256 !== artifact.sha256) {
      throw new Error(`Conflicting Timeline source artifact digests for ${path}.`);
    }
    byPath.set(path, { path, sha256: artifact.sha256 });
  }
  return [...byPath.values()];
}

function resolveCanonicalEvidenceCompanyId(
  evidence: EvidenceItem,
  inventory: {
    byCompany: ReadonlyMap<string, CanonicalCompanyInventory>;
    founderCompanyIdById: ReadonlyMap<string, string>;
    companyIdByBatchAndSlug: ReadonlyMap<string, string>;
    companyIdsByUnqualifiedSlug: ReadonlyMap<string, ReadonlySet<string>>;
  },
): string | null {
  if (evidence.attachedCompanyId && inventory.byCompany.has(evidence.attachedCompanyId)) {
    return evidence.attachedCompanyId;
  }
  if (evidence.entityType === "company" && inventory.byCompany.has(evidence.entityId)) {
    return evidence.entityId;
  }
  const founderCompanyId = inventory.founderCompanyIdById.get(evidence.entityId);
  if (founderCompanyId) return founderCompanyId;

  const evidenceWithCompanySlug = evidence as EvidenceItem & { companySlug?: string };
  const companySlug = typeof evidenceWithCompanySlug.companySlug === "string"
    ? slugify(evidenceWithCompanySlug.companySlug)
    : null;
  const batchSlug = typeof evidence.batchSlug === "string" ? evidence.batchSlug.trim().toUpperCase() : null;
  if (companySlug && batchSlug) {
    const batchCompanyId = inventory.companyIdByBatchAndSlug.get(`${batchSlug}|${companySlug}`);
    if (batchCompanyId) return batchCompanyId;
  }
  if (companySlug) {
    const companyIds = inventory.companyIdsByUnqualifiedSlug.get(companySlug);
    if (companyIds?.size === 1) return [...companyIds][0] ?? null;
  }
  return null;
}

interface TimelineVolumeEvidence extends EvidenceItem {
  companySlug?: string;
}

interface LoadedVolumeEvidence {
  path: string;
  sha256: string;
  generatedAt: string | null;
  evidence: TimelineVolumeEvidence[];
}

async function loadEvidenceArtifactDigest(
  rootDir: string,
  configuredPath?: string | null,
): Promise<Pick<LoadedVolumeEvidence, "path" | "sha256"> | null> {
  const relativePath = configuredPath === undefined ? DEFAULT_VOLUME_EVIDENCE_PATH : configuredPath;
  if (!relativePath) return null;
  const normalizedPath = normalizeRepositoryPath(relativePath);
  try {
    const bytes = await readFile(resolveWithinRoot(rootDir, normalizedPath));
    return { path: normalizedPath, sha256: sha256(bytes) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

async function loadVolumeEvidence(rootDir: string, configuredPath?: string | null): Promise<LoadedVolumeEvidence | null> {
  const relativePath = configuredPath === undefined ? DEFAULT_VOLUME_EVIDENCE_PATH : configuredPath;
  if (!relativePath) return null;
  const normalizedPath = normalizeRepositoryPath(relativePath);
  const absolutePath = resolveWithinRoot(rootDir, normalizedPath);
  let bytes: Buffer;
  try {
    bytes = await readFile(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
  const payload = JSON.parse(bytes.toString("utf8")) as unknown;
  const rawEvidence = isRecord(payload) && Array.isArray(payload.evidence) ? payload.evidence : null;
  if (!rawEvidence) throw new Error(`${normalizedPath} must contain an evidence array.`);
  const evidence = rawEvidence.map((value, index) => normalizeVolumeEvidence(value, normalizedPath, index));
  const fetchedAt = isRecord(payload) && isRecord(payload.source) && typeof payload.source.fetchedAt === "string"
    ? payload.source.fetchedAt
    : null;
  return { path: normalizedPath, sha256: sha256(bytes), generatedAt: fetchedAt, evidence };
}

function normalizeVolumeEvidence(value: unknown, path: string, index: number): TimelineVolumeEvidence {
  if (!isRecord(value)) throw new TypeError(`${path}.evidence[${index}] must be an object.`);
  const entityType = value.entityType === "founder" ? "founder" : value.entityType === "company" ? "company" : null;
  const platform = typeof value.platform === "string" && (PLATFORM_VALUES as readonly string[]).includes(value.platform)
    ? value.platform as EvidenceItem["platform"] : null;
  if (!entityType || !platform || typeof value.entityId !== "string"
      || typeof value.sourceUrl !== "string" || typeof value.id !== "string") {
    throw new TypeError(`${path}.evidence[${index}] is missing timeline identity fields.`);
  }
  const text = typeof value.text === "string" && value.text.trim()
    ? value.text
    : typeof value.title === "string" ? value.title : "";
  const postedAt = typeof value.postedAt === "string" ? value.postedAt : "";
  return {
    ...(value as unknown as TimelineVolumeEvidence),
    id: value.id,
    entityType,
    entityId: value.entityId,
    platform,
    authorName: typeof value.authorName === "string" ? value.authorName : "",
    authorHandle: typeof value.authorHandle === "string" ? value.authorHandle : null,
    postedAt,
    publishedAtPrecision: value.publishedAtPrecision === "exact" || value.publishedAtPrecision === "day"
      ? value.publishedAtPrecision : "unknown",
    title: typeof value.title === "string" ? value.title : undefined,
    text,
    mediaType: typeof value.mediaType === "string" ? value.mediaType as EvidenceItem["mediaType"] : "text",
    metrics: isRecord(value.metrics) ? value.metrics as EvidenceItem["metrics"] : {},
    contributionScore: typeof value.contributionScore === "number" ? value.contributionScore : 0,
    sourceUrl: value.sourceUrl,
    review_state: value.review_state === "needs_review" ? "needs_review" : "verified",
    linkStatus: value.linkStatus === "invalid" || value.linkStatus === "blocked" ? value.linkStatus : "verified",
    why: typeof value.why === "string" ? value.why : typeof value.matchReason === "string" ? value.matchReason : "verified volume evidence",
    companySlug: typeof value.companySlug === "string" ? value.companySlug : undefined,
  };
}

/**
 * Expose only canonical public identity fields to the database-free discovery
 * runner. `databaseId` deliberately mirrors the stable graph source key in
 * this lane; it is never written to Supabase.
 */
export async function loadCanonicalTimelinePublicDiscoveryInventory(
  rootDir: string = process.cwd(),
  canonicalEvidenceSnapshot?: TimelineCanonicalEvidenceSnapshot,
): Promise<TimelinePublicDiscoveryInventory> {
  const loaded = await loadCanonicalInventory(resolve(rootDir), undefined, canonicalEvidenceSnapshot);
  return {
    inventorySha256: loaded.inventorySha256,
    sourceArtifacts: loaded.sourceArtifacts,
    companies: loaded.companies.map((company) => {
      const websiteUrl = company.nodes.find((node) => node.websiteUrl)?.websiteUrl ?? null;
      const profileUrl = company.nodes.find((node) => node.ycProfileUrl || node.sourceUrl);
      return {
        id: company.id,
        databaseId: company.id,
        batchId: company.nodes[0]?.batchSlug ?? null,
        slug: company.slug,
        name: company.name,
        aliases: [...new Set(company.nodes.map((node) => node.label))].sort(),
        websiteUrl,
        profileUrl: profileUrl?.ycProfileUrl || profileUrl?.sourceUrl || null,
        founderNames: [...new Set(company.nodes.flatMap((node) => node.founders.map((founder) => founder.name)))].sort(),
        existingEvidenceCount: company.evidence.length,
      };
    }),
  };
}

/**
 * Base cohort graphs are published beside derivative insider/partner views.
 * Discovering the base files from the artifact directory automatically enrolls
 * a newly published cohort in Timeline backfill without a code allowlist.
 */
export function isTimelineBaseGraphFilename(filename: string): boolean {
  return filename.endsWith(".json")
    && filename !== "manifest.json"
    && !/-(?:insiders|yc-partners|partners|founders)\.json$/i.test(filename);
}

function buildCompanyTimeline(
  company: CanonicalCompanyInventory,
  generatedAt: string,
  env: NodeJS.ProcessEnv,
  database: TimelineDatabaseCompanySnapshot | undefined,
  publicDiscovery: TimelinePublicDiscoveryCompanyRecord | undefined,
): CompanyBuildResult {
  const primaryNode = company.nodes[0]!;
  const identity = {
    id: company.id,
    slug: company.slug,
    name: company.name,
    aliases: [...new Set(company.nodes.map((node) => node.label))],
    websiteUrl: company.nodes.find((node) => node.websiteUrl)?.websiteUrl ?? null,
    founderNames: [...new Set(company.nodes.flatMap((node) => node.founders.map((founder) => founder.name)))],
  };
  const companyRef = { id: company.id, slug: company.slug, name: company.name };
  const graphSources = company.evidence.map((evidence) => ({
    source: timelineClassificationSourceFromGraphEvidence(evidence),
    evidence,
  }));
  const sourceRows = dedupeClassificationSourceRows([
    ...graphSources,
    ...(publicDiscovery?.sources ?? []).map((source) => ({ source, evidence: null })),
  ]);
  const sources = sourceRows.map((row) => row.source);
  const input: TimelineClassificationInput = { company: identity, sources, existingEventKeys: [] };
  const classified: ClassifiedEvent[] = [];
  let unresolvedDateCount = 0;
  let candidateEventCount = 0;
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index]!;
    const evidence = sourceRows[index]!.evidence;
    const result = classifySourceDeterministically(input, source);
    if (result.isMeaningfulEvent) {
      classified.push({ proposal: result, source, evidence });
    } else if (result.reason === "exact_date_unsupported" && isPotentiallyMeaningful(source)) {
      // This remains private operational accounting. No unresolved payload or
      // approximate date enters a public artifact.
      unresolvedDateCount += 1;
      candidateEventCount += 1;
    }
  }

  const clusters = clusterTimelineEvents(classified.map((item) => ({
    ...item,
    id: item.proposal.mergeKey,
    companyId: company.id,
    category: item.proposal.category,
    eventDate: item.proposal.eventDate,
    title: item.proposal.title,
    sourceIds: item.proposal.sourceIds,
    sourceUrls: [item.source.canonicalUrl ?? item.source.url],
  })));
  const eventAndDetails = mergeDatabaseEventsForArtifact(
    clusters.map((cluster) => buildPublishedEvent(company, cluster)),
    database?.events ?? [],
  );
  const events = eventAndDetails.map((item) => item.event).sort(compareEvents);
  const details = eventAndDetails.map((item) => ({
    schemaVersion: TIMELINE_EVENT_DETAIL_SCHEMA_VERSION,
    company: companyRef,
    event: item.detail,
    generatedAt,
    lastModifiedAt: generatedAt,
  } satisfies CompanyTimelineEventDetailArtifact));

  const sourceCoverage = mergeTimelineSourceCoverage(
    mergeTimelineSourceCoverage(
      buildSourceCoverage(primaryNode, company.evidence, env),
      publicDiscovery?.coverage,
    ),
    database?.sourceCoverage,
  );
  const degraded = Object.values(sourceCoverage).some((status) =>
    status === "blocked" || status === "rate_limited" || status === "authentication_required" || status === "failed"
  );
  const status = degraded ? "partial" as const : "complete" as const;
  const artifact: CompanyTimelineArtifact = {
    schemaVersion: TIMELINE_ARTIFACT_SCHEMA_VERSION,
    company: companyRef,
    generatedAt,
    lastModifiedAt: generatedAt,
    events,
    groups: buildGroups(events),
    coverage: { status, publishedEventCount: events.length, lastSuccessfulArtifactAt: generatedAt },
    nextCursor: null,
  };
  const artifactBytes = serializeJson(artifact);
  if (artifactBytes.byteLength > 100_000) {
    throw new RangeError(`Initial timeline artifact for ${company.id} exceeds 100 KB (${artifactBytes.byteLength}).`);
  }
  const artifactPath = `public/timelines/companies/${company.slug}.json`;
  const manifest: TimelineCoverageManifestCompany = {
    company: companyRef,
    artifactPath,
    artifactSha256: sha256(artifactBytes),
    status,
    sourceCoverage,
    publishedEventCount: events.length,
    candidateEventCount: candidateEventCount + (database?.candidateEventCount ?? 0),
    unresolvedConflictCount: events.filter((event) => event.hasConflict).length,
    unresolvedDateCount: unresolvedDateCount + (database?.unresolvedDateCount ?? 0),
    lastSuccessfulArtifactAt: generatedAt,
    lastError: describeCoverageLimitations(sourceCoverage),
  };
  return { artifact, details, manifest };
}

function buildPublishedEvent(
  company: CanonicalCompanyInventory,
  cluster: Array<ClassifiedEvent & { companyId: string; category: TimelineCandidateProposal["category"]; eventDate: string; title: string }>,
): { event: PublishedTimelineEvent; detail: CompanyTimelineEventDetailArtifact["event"] } {
  const ordered = [...cluster].sort((left, right) =>
    eventDateTypeRank(left.proposal.eventDateType) - eventDateTypeRank(right.proposal.eventDateType)
    || left.source.sourceQualityTier - right.source.sourceQualityTier
    || left.proposal.eventDate.localeCompare(right.proposal.eventDate)
    || left.source.id.localeCompare(right.source.id)
  );
  const primary = ordered[0]!;
  const uniqueSources = dedupeClassifiedSources(ordered);
  const copyPrimary = [...uniqueSources].sort((left, right) =>
    publicCopySpecificityRank(left.proposal) - publicCopySpecificityRank(right.proposal)
      || left.source.sourceQualityTier - right.source.sourceQualityTier
      || left.source.id.localeCompare(right.source.id)
  )[0]!;
  const occurrenceDates = [...new Set(uniqueSources
    .filter((item) => item.proposal.eventDateType === "occurrence_date")
    .map((item) => item.proposal.eventDate))];
  // Different publication/announcement dates are expected when multiple
  // channels cover one event. Only incompatible claimed occurrence dates are
  // a date conflict.
  const conflictProjection = projectTimelineProposalConflicts(
    uniqueSources.map((item) => item.proposal),
    occurrenceDates.length > 1,
  );
  const hasConflict = conflictProjection.hasConflict;
  const eventId = `tle-${sha256(Buffer.from(`${company.id}|${copyPrimary.proposal.mergeKey}`)).slice(0, 24)}`;
  const sourceDetails = uniqueSources.map((item) => sourceDetail(
    item,
    primary.proposal.eventDate,
    occurrenceDates.length > 1,
    conflictProjection.descriptionsBySource,
  ));
  const sourcePreview = sourceDetails.slice(0, 3).map(sourcePreviewFromDetail);
  const title = boundedText(copyPrimary.proposal.title, 140);
  const summary = boundedOneSentence(copyPrimary.proposal.summary, company.name, title);
  const base: PublishedTimelineEvent = {
    id: eventId,
    eventDate: primary.proposal.eventDate,
    eventDateType: primary.proposal.eventDateType,
    title,
    summary,
    category: copyPrimary.proposal.category,
    isMajor: uniqueSources.some((item) => item.proposal.isMajor)
      || (primary.proposal.category === "product_launch" && sourceDetails.length >= 2),
    hasConflict,
    conflictSummary: conflictProjection.summary,
    evidenceCount: sourceDetails.length,
    sourcePreview,
  };
  const posts = uniqueSources
    .filter((item): item is ClassifiedEvent & { evidence: EvidenceItem } =>
      item.evidence !== null && isPostSource(item.source.sourceType)
    )
    .map((item) => postDetail(item, conflictProjection.descriptionsBySource));
  return { event: base, detail: { ...base, evidence: sourceDetails, posts } };
}

function publicCopySpecificityRank(proposal: TimelineCandidateProposal): number {
  if (/\b(?:launched a new product|released a product update)\b/i.test(proposal.title)) return 3;
  if (/\b(?:announced its public launch|announced a product update|published its launch video)\b/i.test(proposal.title)) return 2;
  if (/\b(?:launched on|became publicly available|was introduced)\b/i.test(proposal.title)) return 1;
  return 0;
}

export function projectTimelineProposalConflicts(
  proposals: readonly TimelineCandidateProposal[],
  occurrenceDateConflict: boolean,
): {
  hasConflict: boolean;
  summary: string | null;
  descriptionsBySource: ReadonlyMap<string, string>;
} {
  const conflicts = new Map<string, TimelineCandidateProposal["conflicts"][number]>();
  for (const proposal of proposals) {
    for (const conflict of proposal.conflicts) {
      const claimsKey = [...conflict.claims]
        .sort((left, right) => left.sourceId.localeCompare(right.sourceId) || left.value.localeCompare(right.value))
        .map((claim) => `${claim.sourceId}:${normalizeConflictValue(claim.value)}`)
        .join("|");
      conflicts.set(`${conflict.field}|${claimsKey}`, conflict);
    }
  }
  const descriptions = new Map<string, Set<string>>();
  for (const conflict of conflicts.values()) {
    const selected = normalizeConflictValue(conflict.selectedValue ?? "");
    for (const claim of conflict.claims) {
      if (selected && normalizeConflictValue(claim.value) === selected) continue;
      const current = descriptions.get(claim.sourceId) ?? new Set<string>();
      current.add(conflict.description);
      descriptions.set(claim.sourceId, current);
    }
  }
  const descriptionsBySource = new Map([...descriptions.entries()].map(([sourceId, values]) => [
    sourceId,
    [...values].sort().join(" "),
  ]));
  const summaryParts = [...new Set([
    ...(occurrenceDateConflict ? ["Sources disagree on the event occurrence date."] : []),
    ...[...conflicts.values()].map((conflict) => conflict.description),
  ])];
  return {
    hasConflict: summaryParts.length > 0,
    summary: summaryParts.length ? boundedText(summaryParts.join(" "), 500) : null,
    descriptionsBySource,
  };
}

export function mergeDatabaseEventsForArtifact(
  graphBundles: Array<{ event: PublishedTimelineEvent; detail: CompanyTimelineEventDetailArtifact["event"] }>,
  databaseBundles: readonly TimelineDatabaseEventBundle[],
): Array<{ event: PublishedTimelineEvent; detail: CompanyTimelineEventDetailArtifact["event"] }> {
  const merged = [...graphBundles];
  for (const database of databaseBundles) {
    const duplicateIndex = merged.findIndex((graph) => samePublicEvent(graph.event, database.event));
    if (duplicateIndex < 0) {
      merged.push({ event: database.event, detail: database.detail });
      continue;
    }
    const graph = merged[duplicateIndex]!;
    const occurrenceDateConflict = graph.event.eventDateType === "occurrence_date"
      && database.event.eventDateType === "occurrence_date"
      && graph.event.eventDate !== database.event.eventDate;
    const evidence = dedupePublicEvidence([...graph.detail.evidence, ...database.detail.evidence])
      .map((item): TimelineEvidenceDetail => occurrenceDateConflict
        && item.sourceEventDate !== null
        && item.sourceEventDate !== graph.event.eventDate
        ? {
          ...item,
          evidenceRole: "conflicting",
          isConflicting: true,
          conflictDescription: "This source gives a different event occurrence date.",
        }
        : item);
    // Graph evidence reaches this merge through the durable publication gate.
    // Expose the DB-backed ID and editable fields while retaining graph posts
    // and any extra supporting evidence in the expanded detail.
    const event: PublishedTimelineEvent = {
      ...database.event,
      isMajor: graph.event.isMajor || database.event.isMajor,
      hasConflict: graph.event.hasConflict || database.event.hasConflict || occurrenceDateConflict,
      conflictSummary: graph.event.conflictSummary ?? database.event.conflictSummary
        ?? (occurrenceDateConflict ? "Sources disagree on the event occurrence date." : null),
      evidenceCount: evidence.length,
      sourcePreview: evidence.slice(0, 3).map(sourcePreviewFromDetail),
    };
    merged[duplicateIndex] = { event, detail: { ...event, evidence, posts: graph.detail.posts } };
  }
  return merged.sort((left, right) => compareEvents(left.event, right.event));
}

function samePublicEvent(left: PublishedTimelineEvent, right: PublishedTimelineEvent): boolean {
  // Reuse the same deterministic safeguards as graph clustering. Independent
  // channels commonly announce one launch or round on nearby dates; requiring
  // identical dates here leaked graph/DB duplicates into public artifacts.
  return shouldMergeTimelineEvents({
    companyId: "same-artifact-company",
    category: left.category,
    eventDate: left.eventDate,
    title: left.title,
    sourceIds: left.sourcePreview.map((source) => source.id),
    sourceUrls: left.sourcePreview.map((source) => source.url),
  }, {
    companyId: "same-artifact-company",
    category: right.category,
    eventDate: right.eventDate,
    title: right.title,
    sourceIds: right.sourcePreview.map((source) => source.id),
    sourceUrls: right.sourcePreview.map((source) => source.url),
  });
}

function dedupePublicEvidence(evidence: readonly TimelineEvidenceDetail[]): TimelineEvidenceDetail[] {
  const byUrl = new Map<string, TimelineEvidenceDetail>();
  for (const item of evidence) {
    const url = canonicalizeSourceUrl(item.url);
    const prior = byUrl.get(url);
    if (!prior || publicEvidenceRank(item) < publicEvidenceRank(prior)) byUrl.set(url, item);
  }
  return [...byUrl.values()].sort((left, right) =>
    publicEvidenceRank(left) - publicEvidenceRank(right) || left.id.localeCompare(right.id)
  );
}

function publicEvidenceRank(value: TimelineEvidenceDetail): number {
  return value.evidenceRole === "primary" ? 0 : value.evidenceRole === "supporting" ? 1 : 2;
}

function sourcePreviewFromDetail(source: TimelineEvidenceDetail) {
  return {
    id: source.id,
    title: source.title,
    publisher: source.publisher,
    domain: source.domain,
    sourceType: source.sourceType,
    publishedAt: source.publishedAt,
    evidenceRole: source.evidenceRole,
    url: source.url,
  };
}

function sourceDetail(
  item: ClassifiedEvent,
  selectedDate: string,
  occurrenceDateConflict: boolean,
  materialConflictDescriptions: ReadonlyMap<string, string>,
): TimelineEvidenceDetail {
  const url = canonicalizeSourceUrl(item.source.url);
  const domain = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  const occurrenceConflict = occurrenceDateConflict
    && item.proposal.eventDateType === "occurrence_date"
    && item.proposal.eventDate !== selectedDate;
  const materialConflict = materialConflictDescriptions.get(item.source.id) ?? null;
  const isConflicting = occurrenceConflict || materialConflict !== null;
  return {
    id: sourceDocumentId(url),
    title: boundedText(item.source.title || item.source.evidenceExcerpt || "Public source", 240),
    publisher: item.source.publisher ? boundedText(item.source.publisher, 160) : null,
    domain,
    sourceType: item.source.sourceType,
    publishedAt: item.source.publicationTimestamp,
    evidenceRole: isConflicting ? "conflicting" : item.source.sourceQualityTier === 1 ? "primary" : "supporting",
    url,
    publicationDate: item.source.publicationTimestamp,
    excerpt: item.source.evidenceExcerpt ? boundedText(item.source.evidenceExcerpt, 500) : null,
    sourceEventDate: item.proposal.eventDate,
    isConflicting,
    conflictDescription: materialConflict
      ?? (occurrenceConflict ? "This source gives a different event occurrence date." : null),
  };
}

function eventDateTypeRank(value: TimelineCandidateProposal["eventDateType"]): number {
  return value === "occurrence_date" ? 0 : value === "announcement_date" ? 1 : 2;
}

function postDetail(
  item: ClassifiedEvent & { evidence: EvidenceItem },
  materialConflictDescriptions: ReadonlyMap<string, string>,
): TimelinePostEvidence {
  const url = canonicalizeSourceUrl(item.source.url);
  return {
    id: `post-${sha256(Buffer.from(`${item.evidence.platform}|${item.evidence.id}|${url}`)).slice(0, 24)}`,
    platform: item.evidence.platform,
    account: safePostAccount(item.evidence.authorHandle || item.evidence.authorName || null),
    postDate: isoDateFromExactTimestamp(item.evidence.postedAt) ?? item.proposal.eventDate,
    excerpt: item.source.evidenceExcerpt ? boundedText(item.source.evidenceExcerpt, 500) : null,
    url,
    metrics: Object.fromEntries(Object.entries(item.evidence.metrics).map(([key, value]) => [key, value ?? null])),
    evidenceRole: materialConflictDescriptions.has(item.source.id)
      ? "conflicting"
      : item.source.sourceQualityTier === 1 ? "primary" : "supporting",
  };
}

function buildSourceCoverage(
  node: GraphNode,
  evidence: readonly EvidenceItem[],
  env: NodeJS.ProcessEnv,
): Partial<Record<string, TimelineSourceCoverageState>> {
  const founderEvidence = evidence.some((item) => item.entityType === "founder");
  const searchConfigured = Boolean(env.EXA_API_KEY?.trim() || env.BRAVE_SEARCH_API_KEY?.trim() || env.SERPER_API_KEY?.trim() || env.TAVILY_API_KEY?.trim());
  return {
    timeline_existing_evidence: evidence.length ? "completed" : "no_results",
    timeline_official_site: node.websiteUrl ? "blocked" : "no_applicable_source",
    timeline_founder_sources: !node.founders.length
      ? "no_applicable_source"
      : founderEvidence ? "completed" : "no_results",
    timeline_institutional_sources: node.sourceUrl ? "blocked" : "no_applicable_source",
    // Public artifacts expose terminal coverage only. Search-enabled discovery
    // is executed by the autonomous coordinator; the static graph backfill is
    // honest about not having run it instead of publishing retry_pending.
    timeline_public_web: searchConfigured ? "blocked" : "authentication_required",
    timeline_historical_archive: "blocked",
    timeline_gap_followup: searchConfigured ? "blocked" : "authentication_required",
    timeline_reconcile_publish: "completed",
  };
}

/**
 * Coverage produced before the durable coordinator used human-facing aliases
 * such as `official_website`. Normalize those aliases before overlaying the
 * canonical coordinator source classes so a later successful scan replaces a
 * static `blocked` state instead of coexisting with it forever.
 */
export function mergeTimelineSourceCoverage(
  fallback: Partial<Record<string, TimelineSourceCoverageState>>,
  durable: Partial<Record<string, TimelineSourceCoverageState>> | undefined,
): Partial<Record<string, TimelineSourceCoverageState>> {
  const merged: Partial<Record<string, TimelineSourceCoverageState>> = {};
  for (const [sourceClass, status] of Object.entries(fallback)) {
    if (status) merged[canonicalTimelineSourceClass(sourceClass)] = status;
  }
  for (const [sourceClass, status] of Object.entries(durable ?? {})) {
    if (status) merged[canonicalTimelineSourceClass(sourceClass)] = status;
  }
  return merged;
}

function canonicalTimelineSourceClass(sourceClass: string): string {
  const aliases: Readonly<Record<string, string>> = {
    existing_evidence: "timeline_existing_evidence",
    official_website: "timeline_official_site",
    founder_sources: "timeline_founder_sources",
    official_profile: "timeline_institutional_sources",
    public_web_search: "timeline_public_web",
    historical_archive: "timeline_historical_archive",
    gap_followup: "timeline_gap_followup",
    reconcile_publish: "timeline_reconcile_publish",
  };
  return aliases[sourceClass] ?? sourceClass;
}

function describeCoverageLimitations(
  coverage: Partial<Record<string, TimelineSourceCoverageState>>,
): string | null {
  const limitations: string[] = [];
  if (coverage.timeline_official_site === "blocked") limitations.push("official website discovery was not executed by the static graph backfill");
  if (coverage.timeline_institutional_sources === "blocked") limitations.push("institutional profile discovery was not executed by the static graph backfill");
  if (coverage.timeline_public_web === "blocked") limitations.push("configured public web discovery is delegated to the autonomous ingestion coordinator");
  if (coverage.timeline_public_web === "authentication_required") limitations.push("public web discovery requires a configured search provider credential");
  if (coverage.timeline_historical_archive === "blocked") limitations.push("historical archive discovery is not configured");
  if (coverage.timeline_gap_followup === "blocked") limitations.push("historical gap follow-up is delegated to the autonomous ingestion coordinator");
  if (coverage.timeline_gap_followup === "authentication_required") limitations.push("historical gap follow-up requires a configured search provider credential");
  return limitations.length ? `${limitations.join("; ")}.` : null;
}

function groupEvidenceByCompany(evidence: readonly EvidenceItem[]): Map<string, EvidenceItem[]> {
  const grouped = new Map<string, EvidenceItem[]>();
  for (const item of evidence) {
    const companyId = item.attachedCompanyId ?? (item.entityType === "company" ? item.entityId : null);
    if (!companyId) continue;
    grouped.set(companyId, [...(grouped.get(companyId) ?? []), item]);
  }
  return grouped;
}

function dedupeCompanyEvidence(evidence: readonly EvidenceItem[]): EvidenceItem[] {
  const byKey = new Map<string, EvidenceItem>();
  for (const item of [...evidence].sort((left, right) => left.id.localeCompare(right.id))) {
    let url: string;
    try { url = canonicalizeSourceUrl(item.sourceUrl); } catch { continue; }
    const key = `${item.platform}|${item.platformObjectId ?? item.platformPostId ?? ""}|${url}`;
    const prior = byKey.get(key);
    if (!prior || evidencePreference(item, prior) < 0) byKey.set(key, item);
  }
  return [...byKey.values()].sort((left, right) =>
    left.postedAt.localeCompare(right.postedAt) || left.id.localeCompare(right.id)
  );
}

function dedupeClassificationSourceRows(
  rows: ReadonlyArray<{ source: TimelineClassificationSource; evidence: EvidenceItem | null }>,
): Array<{ source: TimelineClassificationSource; evidence: EvidenceItem | null }> {
  const byUrl = new Map<string, { source: TimelineClassificationSource; evidence: EvidenceItem | null }>();
  for (const row of rows) {
    let url: string;
    try { url = canonicalizeSourceUrl(row.source.canonicalUrl ?? row.source.url); } catch { continue; }
    const prior = byUrl.get(url);
    if (!prior
        || row.source.sourceQualityTier < prior.source.sourceQualityTier
        || (row.source.sourceQualityTier === prior.source.sourceQualityTier && row.evidence && !prior.evidence)) {
      byUrl.set(url, row);
    }
  }
  return [...byUrl.values()].sort((left, right) =>
    left.source.sourceQualityTier - right.source.sourceQualityTier
      || left.source.id.localeCompare(right.source.id)
  );
}

function dedupeClassifiedSources(items: readonly ClassifiedEvent[]): ClassifiedEvent[] {
  const byUrl = new Map<string, ClassifiedEvent>();
  for (const item of items) {
    const url = canonicalizeSourceUrl(item.source.url);
    const prior = byUrl.get(url);
    if (!prior || item.source.sourceQualityTier < prior.source.sourceQualityTier) byUrl.set(url, item);
  }
  return [...byUrl.values()].sort((left, right) =>
    left.source.sourceQualityTier - right.source.sourceQualityTier || left.source.id.localeCompare(right.source.id)
  );
}

function evidencePreference(left: EvidenceItem, right: EvidenceItem): number {
  const rank = (value: EvidenceItem) => (value.review_state === "verified" ? 0 : 10)
    + (value.linkStatus === "verified" ? 0 : value.linkStatus === "invalid" ? 20 : 2)
    + (value.publishedAtPrecision === "exact" || value.publishedAtPrecision === "day" ? 0 : 5);
  return rank(left) - rank(right) || left.id.localeCompare(right.id);
}

function normalizeConflictValue(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/,(?=\d)/g, "").replace(/[^a-z0-9$%.]+/g, " ").replace(/\s+/g, " ").trim();
}

function isPotentiallyMeaningful(source: TimelineClassificationSource): boolean {
  return /\b(?:raised|funding|launched|released|accepted into|got into|acquired|shutting down|pivoted|reached|surpassed|partnered)\b/i
    .test(`${source.title ?? ""} ${source.text}`);
}

function isPostSource(sourceType: string): boolean {
  return ["founder_post", "company_post", "product_hunt", "video"].includes(sourceType);
}

function boundedOneSentence(value: string, companyName: string, title: string): string {
  const clean = sanitizeEvidenceExcerpt(value.replace(/https?:\s*\/\/\s*\S+(?:\s*\/\S+)*/g, " "), 1_000)
    .replace(/\b(?:e\.g|i\.e)\./gi, (part) => part.replaceAll(".", ""));
  const sentence = firstSentence(clean)
    ?? (clean ? `${clean.replace(/[.!?]+$/, "")}.` : `${companyName} announced ${title.charAt(0).toLowerCase()}${title.slice(1)}.`);
  const bounded = `${boundedText(sentence, 280).replace(/[.!?]+$/, "").replace(/[,;:]+$/, "")}.`;
  return bounded.length >= 12 ? bounded : `${companyName} announced ${title.charAt(0).toLowerCase()}${title.slice(1)}.`;
}

const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });
function firstSentence(value: string): string | null {
  const segment = sentenceSegmenter.segment(value)[Symbol.iterator]().next().value?.segment?.trim();
  if (!segment) return null;
  return /[.!?][\])}"'’”]*$/.test(segment) ? segment : `${segment.replace(/[.!?]+$/, "")}.`;
}

function safePostAccount(value: string | null): string | null {
  if (!value) return null;
  const normalized = sanitizeEvidenceExcerpt(value, 160);
  if (!normalized || normalized.length > 160 || normalized.split(/\s+/).length > 12) return null;
  return normalized;
}

function boundedText(value: string, maximum: number): string {
  const clean = sanitizeEvidenceExcerpt(value, maximum).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length <= maximum) return clean;
  return clean.slice(0, maximum).replace(/\s+\S*$/, "").trim();
}

function buildGroups(events: readonly PublishedTimelineEvent[]): TimelineMonthGroup[] {
  const months = new Map<string, number>();
  for (const event of events) months.set(event.eventDate.slice(0, 7), (months.get(event.eventDate.slice(0, 7)) ?? 0) + 1);
  const byYear = new Map<number, Array<{ month: string; count: number }>>();
  for (const [month, count] of [...months.entries()].sort(([left], [right]) => right.localeCompare(left))) {
    const year = Number(month.slice(0, 4));
    byYear.set(year, [...(byYear.get(year) ?? []), { month, count }]);
  }
  return [...byYear.entries()].sort(([left], [right]) => right - left).map(([year, groupedMonths]) => ({ year, months: groupedMonths }));
}

function compareEvents(left: PublishedTimelineEvent, right: PublishedTimelineEvent): number {
  return right.eventDate.localeCompare(left.eventDate) || right.id.localeCompare(left.id);
}

function sourceDocumentId(url: string): string { return `src-${sha256(Buffer.from(url)).slice(0, 24)}`; }
function slugify(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90) || "item";
}
function serializeJson(value: unknown): Buffer { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, serializeJson(value), { mode: 0o644 });
  await rename(temporaryPath, path);
}

async function readJsonIfPresent<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return null; }
}

function resolveWithinRoot(rootDir: string, path: string): string {
  const resolved = resolve(rootDir, path);
  const relativePath = relative(rootDir, resolved);
  if (relativePath.startsWith("..") || relativePath === ".." || relativePath.includes(`${sep}..${sep}`)) {
    throw new TypeError("Timeline path must stay within the repository root.");
  }
  return resolved;
}
