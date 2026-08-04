import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { normalizeAutonomousIngestionCatalogs } from
  "./ingestion-coverage-adapter.mjs";
import { INGESTION_COVERAGE_CAMPAIGN_VERSION } from
  "./ingestion-coverage-campaign.mjs";

export const PUBLIC_INGESTION_PROOF_ARTIFACT_VERSION =
  "public-ingestion-proof-journals.v1";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_CAMPAIGN_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_ARTIFACT_BYTES = 128 * 1024 * 1024;
const RECENT_PROOF_KEYS = new Set([
  "schemaVersion",
  "status",
  "coverageScope",
  "coveredFrom",
  "coveredThrough",
  "checkedAt",
  "sourceExhausted",
  "nextCursor",
  "truncated",
  "limitReached",
  "pageLimit",
  "pagesAttempted",
  "pagesFetched",
  "blockers",
  "requestJournal"
]);
const JOURNAL_DESCRIPTOR_KEYS = new Set(["path", "sha256", "observedAt"]);
const PAGE_RECEIPT_KEYS = new Set([
  "schemaVersion",
  "sequence",
  "attemptKey",
  "pairKey",
  "requestedAt",
  "completedAt",
  "requestUrl",
  "status",
  "cursorIn",
  "cursorOut",
  "sourceExhausted",
  "responseSha256",
  "coverageFrom",
  "coverageThrough"
]);
const CORE_PLATFORMS = new Set([
  "github",
  "x",
  "instagram",
  "linkedin",
  "youtube",
  "product_hunt",
  "reddit",
  "hacker_news",
  "rss",
  "web"
]);
const SENSITIVE_QUERY_KEYS = /^(?:access[_-]?token|api[_-]?key|auth|authorization|bearer|cookie|credential|key|password|secret|session(?:id)?|sig(?:nature)?|token|x-api-key)$/i;
const HIGH_CONFIDENCE_SECRET = /(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16}|\bBearer\s+[A-Za-z0-9._~-]{12,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/i;

/**
 * Build a public-safe, hash-bound projection of one prepared campaign.
 *
 * The source campaign is fully hash-verified, but none of its collector bodies,
 * evidence, review rows, stored-unpublished scopes, headers, or request bodies
 * are copied. The uploadable directory contains only a canonical identity
 * matrix, two run timestamps, allowlisted attempt status/proof fields, and
 * allowlisted recent-window page receipts.
 */
export async function packagePublicIngestionProofArtifact({
  preparedCampaignDir,
  outputDir,
  idempotencyKey,
  artifactName,
  repository,
  workflowRunId,
  workflowRunAttempt,
  sourceRevision,
  generatedAt,
  maxSourceArtifactBytes = MAX_SOURCE_ARTIFACT_BYTES
} = {}) {
  const expectedIdempotencyKey = boundedPublicText(
    idempotencyKey,
    "idempotencyKey",
    256
  );
  const normalizedArtifactName = validateArtifactName(artifactName);
  const normalizedRepository = validateRepository(repository);
  const normalizedWorkflowRunId = digits(workflowRunId, "workflowRunId");
  const normalizedWorkflowRunAttempt = digits(
    workflowRunAttempt,
    "workflowRunAttempt"
  );
  const normalizedRevision = requiredText(sourceRevision, "sourceRevision");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(normalizedRevision)) {
    throw new TypeError("sourceRevision must be a lowercase Git commit digest.");
  }
  const normalizedGeneratedAt = canonicalTimestamp(generatedAt, "generatedAt");
  const byteLimit = positiveInteger(maxSourceArtifactBytes, "maxSourceArtifactBytes");
  if (byteLimit > MAX_SOURCE_ARTIFACT_BYTES) {
    throw new RangeError(
      `maxSourceArtifactBytes cannot exceed ${MAX_SOURCE_ARTIFACT_BYTES}.`
    );
  }

  const sourceRoot = await realpath(resolve(
    requiredText(preparedCampaignDir, "preparedCampaignDir")
  ));
  if (!(await stat(sourceRoot)).isDirectory()) {
    throw new TypeError("preparedCampaignDir must be a directory.");
  }
  const destinationRoot = resolve(requiredText(outputDir, "outputDir"));
  await assertMissing(destinationRoot, "outputDir");

  const sourceCampaignPath = await resolveDeclaredFile(sourceRoot, "campaign.json");
  const sourceCampaignBytes = await readBoundedFile(
    sourceCampaignPath,
    MAX_CAMPAIGN_MANIFEST_BYTES,
    "source campaign manifest"
  );
  const sourceCampaign = parseJson(sourceCampaignBytes, "source campaign manifest");
  assertObject(sourceCampaign, "source campaign manifest");
  if (sourceCampaign.schemaVersion !== INGESTION_COVERAGE_CAMPAIGN_VERSION) {
    throw new Error(
      `source campaign schemaVersion must be ${INGESTION_COVERAGE_CAMPAIGN_VERSION}.`
    );
  }
  const sourceRunId = boundedPublicText(sourceCampaign.runId, "sourceCampaign.runId", 256);
  const sourceIdempotencyKey = boundedPublicText(
    sourceCampaign.idempotencyKey,
    "sourceCampaign.idempotencyKey",
    256
  );
  const sourceCampaignKey = boundedPublicText(
    sourceCampaign.campaignKey,
    "sourceCampaign.campaignKey",
    256
  );
  if (
    sourceIdempotencyKey !== expectedIdempotencyKey ||
    sourceRunId !== expectedIdempotencyKey
  ) {
    throw new Error("Source campaign identity does not match the idempotency key.");
  }
  const campaignGeneratedAt = canonicalTimestamp(
    sourceCampaign.generatedAt,
    "sourceCampaign.generatedAt"
  );
  const coverageGeneratedAt = canonicalTimestamp(
    sourceCampaign.coverageGeneratedAt,
    "sourceCampaign.coverageGeneratedAt"
  );
  const recentCoverageCutoff = canonicalTimestamp(
    sourceCampaign.recentCoverageCutoff,
    "sourceCampaign.recentCoverageCutoff"
  );
  if (normalizedGeneratedAt < campaignGeneratedAt) {
    throw new Error("Proof artifact generatedAt cannot predate the source campaign.");
  }

  const declared = collectArtifactDescriptors(sourceCampaign.artifacts);
  if (declared.length === 0) {
    throw new Error("Source campaign declares no artifact descriptors.");
  }
  const verified = [];
  const sourceDescriptorByPath = new Map();
  for (const entry of declared) {
    const descriptor = normalizeDescriptor(entry.value, entry.pointer);
    if (sourceDescriptorByPath.has(descriptor.path)) {
      throw new Error(`Source campaign declares duplicate artifact path ${descriptor.path}.`);
    }
    const path = await resolveDeclaredFile(sourceRoot, descriptor.path);
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > byteLimit) {
      throw new Error(
        `${descriptor.path} must be a regular file no larger than ${byteLimit} bytes.`
      );
    }
    if (descriptor.bytes !== null && metadata.size !== descriptor.bytes) {
      throw new Error(
        `${descriptor.path} byte count mismatch: expected ${descriptor.bytes}, ` +
        `received ${metadata.size}.`
      );
    }
    const actualSha256 = await sha256File(path);
    if (actualSha256 !== descriptor.sha256) {
      throw new Error(
        `${descriptor.path} SHA-256 mismatch: expected ${descriptor.sha256}, ` +
        `received ${actualSha256}.`
      );
    }
    const row = {
      path: descriptor.path,
      sha256: descriptor.sha256,
      bytes: metadata.size,
      format: descriptor.format,
      observedAt: descriptor.observedAt
    };
    verified.push(row);
    sourceDescriptorByPath.set(descriptor.path, { ...descriptor, bytes: metadata.size, path });
  }
  verified.sort(compareDescriptorPath);

  const temporaryRoot = `${destinationRoot}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(dirname(destinationRoot), { recursive: true });
  await mkdir(temporaryRoot, { recursive: false, mode: 0o700 });
  try {
    const catalogsDescriptor = normalizeDescriptor(
      sourceCampaign.artifacts?.catalogs,
      "artifacts.catalogs"
    );
    const rawCatalogs = parseJson(
      await readFile(sourceDescriptorByPath.get(catalogsDescriptor.path).path),
      "source catalogs"
    );
    const safeCatalogs = publicSafeCatalogMatrix(rawCatalogs);
    const safeCatalogsDescriptor = await writeArtifact({
      root: temporaryRoot,
      path: "generated/canonical-core-matrix.json",
      body: `${stableJson(safeCatalogs)}\n`,
      observedAt: catalogsDescriptor.observedAt,
      format: "json"
    });

    const runnerDescriptor = normalizeDescriptor(
      sourceCampaign.artifacts?.runnerLog,
      "artifacts.runnerLog"
    );
    const safeRunnerRows = publicSafeRunnerLog(
      await readFile(sourceDescriptorByPath.get(runnerDescriptor.path).path),
      coverageGeneratedAt
    );
    const safeRunnerDescriptor = await writeArtifact({
      root: temporaryRoot,
      path: "generated/run-window.ndjson",
      body: `${safeRunnerRows.map(stableJson).join("\n")}\n`,
      observedAt: coverageGeneratedAt,
      format: "ndjson"
    });

    const collectorDescriptors = sourceCampaign.artifacts?.collectors;
    if (!Array.isArray(collectorDescriptors) || collectorDescriptors.length === 0) {
      throw new Error("Source campaign must declare collector artifacts.");
    }
    const safeCollectors = [];
    const journalBindings = new Map();
    for (let index = 0; index < collectorDescriptors.length; index += 1) {
      const sourceDescriptor = normalizeDescriptor(
        collectorDescriptors[index],
        `artifacts.collectors[${index}]`
      );
      const sourceEntry = sourceDescriptorByPath.get(sourceDescriptor.path);
      if (!sourceEntry) {
        throw new Error(`Collector descriptor ${sourceDescriptor.path} is not source-bound.`);
      }
      const collector = parseJson(
        await readFile(sourceEntry.path),
        `collector ${sourceDescriptor.path}`
      );
      const projection = projectCollector(collector, sourceDescriptor.path, journalBindings);
      safeCollectors.push({
        ...await writeArtifact({
          root: temporaryRoot,
          path: `collectors/collector-${String(index).padStart(2, "0")}.json`,
          body: `${stableJson(projection)}\n`,
          observedAt: sourceDescriptor.observedAt,
          format: "json"
        })
      });
    }

    const safeJournals = [];
    for (const journal of [...journalBindings.values()].sort(compareDescriptorPath)) {
      const declaredJournal = sourceDescriptorByPath.get(journal.path);
      if (!declaredJournal) {
        throw new Error(`Recent-window journal ${journal.path} is not campaign-declared.`);
      }
      if (
        declaredJournal.sha256 !== journal.sha256 ||
        declaredJournal.observedAt !== journal.observedAt
      ) {
        throw new Error(`Recent-window journal ${journal.path} binding is inconsistent.`);
      }
      const bytes = await readFile(declaredJournal.path);
      validatePublicJournal(bytes, journal.path);
      safeJournals.push({
        kind: "recent_window_request_journal",
        ...await writeArtifact({
          root: temporaryRoot,
          path: journal.path,
          body: bytes,
          observedAt: journal.observedAt,
          format: "ndjson"
        })
      });
    }

    const sourceCampaignDescriptor = {
      path: "campaign.json",
      sha256: sha256(sourceCampaignBytes),
      bytes: sourceCampaignBytes.length,
      format: "json",
      observedAt: campaignGeneratedAt
    };
    const sourceContentManifestSha256 = sha256(stableJson({
      campaign: sourceCampaignDescriptor,
      declaredArtifacts: verified
    }));
    const usageDescriptor = await writeArtifact({
      root: temporaryRoot,
      path: "USAGE.md",
      body: usageDocument(),
      observedAt: normalizedGeneratedAt,
      format: "markdown"
    });
    const manifest = {
      schemaVersion: PUBLIC_INGESTION_PROOF_ARTIFACT_VERSION,
      generatedAt: normalizedGeneratedAt,
      coverageGeneratedAt,
      recentCoverageCutoff,
      runBinding: {
        runIdSha256: sha256(sourceRunId),
        idempotencyKeySha256: sha256(sourceIdempotencyKey),
        campaignKeySha256: sha256(sourceCampaignKey)
      },
      distribution: {
        classification: "public_safe_github_actions_artifact",
        repositoryVisibility: "public",
        containsRawCollectorBodies: false,
        containsRawEvidence: false,
        containsStoredUnpublishedRows: false,
        containsCredentialsOrAuthHeaders: false,
        containsRequestOrResponseBodies: false,
        containsAllowlistedRequestUrls: true,
        containsResponseDigests: true
      },
      source: {
        repository: normalizedRepository,
        workflowRunId: normalizedWorkflowRunId,
        workflowRunAttempt: normalizedWorkflowRunAttempt,
        sourceRevision: normalizedRevision,
        artifactName: normalizedArtifactName
      },
      sourceCampaign: {
        descriptor: sourceCampaignDescriptor,
        declaredArtifacts: verified.length,
        declaredArtifactBytes: verified.reduce((sum, row) => sum + row.bytes, 0),
        contentManifestSha256: sourceContentManifestSha256
      },
      artifacts: {
        catalogs: safeCatalogsDescriptor,
        runnerLog: safeRunnerDescriptor,
        collectors: safeCollectors,
        supporting: safeJournals,
        documentation: usageDescriptor
      }
    };
    const manifestBody = `${stableJson(manifest)}\n`;
    const manifestPath = join(temporaryRoot, "campaign.json");
    assertUploadBodySafe(manifestBody, "campaign.json");
    await writeFile(manifestPath, manifestBody, { flag: "wx", mode: 0o600 });
    const manifestSha256 = sha256(manifestBody);
    await rename(temporaryRoot, destinationRoot);
    return {
      schemaVersion: PUBLIC_INGESTION_PROOF_ARTIFACT_VERSION,
      artifactPath: destinationRoot,
      manifestPath: join(destinationRoot, "campaign.json"),
      manifestSha256,
      manifestBytes: Buffer.byteLength(manifestBody),
      sourceContentManifestSha256,
      recentWindowJournals: safeJournals.length,
      safeCollectors: safeCollectors.length
    };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

export function safeIngestionArtifactSegment(value) {
  const source = requiredText(value, "idempotencyKey");
  const prefix = source
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "run";
  return `${prefix}-${sha256(source).slice(0, 16)}`;
}

export async function appendGithubOutputs(path, values) {
  const outputPath = String(path ?? "").trim();
  if (!outputPath) return;
  const lines = [];
  for (const [key, rawValue] of Object.entries(values ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new TypeError(`Invalid GitHub output name ${key}.`);
    }
    const value = String(rawValue ?? "");
    if (/[\r\n]/.test(value)) {
      throw new Error(`GitHub output ${key} must be a single line.`);
    }
    lines.push(`${key}=${value}`);
  }
  await appendFile(outputPath, `${lines.join("\n")}\n`, "utf8");
}

export function validatePublicProofRequestUrl(value, label = "requestUrl") {
  const rawUrl = boundedPublicText(value, label, 4_096);
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new TypeError(`${label} must be a valid HTTPS URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new TypeError(`${label} must be a credential-free HTTPS URL without a fragment.`);
  }
  for (const key of new Set(url.searchParams.keys())) {
    if (SENSITIVE_QUERY_KEYS.test(key) || url.searchParams.getAll(key).length !== 1) {
      throw new Error(`${label} contains a forbidden or duplicate query parameter.`);
    }
    for (const value of url.searchParams.getAll(key)) {
      assertNoHighConfidenceSecret(value, `${label} query parameter ${key}`);
    }
  }
  const host = url.hostname.toLowerCase();
  if (["instagram.com", "www.instagram.com"].includes(host)) {
    if (
      url.pathname !== "/api/v1/users/web_profile_info/" ||
      [...url.searchParams.keys()].some((key) => key !== "username") ||
      !/^[A-Za-z0-9._]{1,30}$/.test(url.searchParams.get("username") ?? "")
    ) {
      throw new Error(`${label} is not an allowlisted Instagram profile request.`);
    }
  } else if (host === "hn.algolia.com") {
    const allowed = new Set([
      "query",
      "tags",
      "hitsPerPage",
      "page",
      "numericFilters"
    ]);
    if (
      url.pathname !== "/api/v1/search_by_date" ||
      [...url.searchParams.keys()].some((key) => !allowed.has(key))
    ) {
      throw new Error(`${label} is not an allowlisted Hacker News search request.`);
    }
  } else {
    throw new Error(`${label} host is not allowlisted for public proof journals.`);
  }
  assertNoHighConfidenceSecret(url.toString(), label);
  return url.toString();
}

function projectCollector(collector, sourcePath, journalBindings) {
  assertObject(collector, `collector ${sourcePath}`);
  assertObject(collector.attempts, `collector ${sourcePath}.attempts`);
  const attempts = {};
  for (const [objectKey, rawAttempt] of Object.entries(collector.attempts)) {
    assertObject(rawAttempt, `collector ${sourcePath}.attempts.${objectKey}`);
    const attemptKey = publicAttemptKey(
      rawAttempt.attemptKey ?? objectKey,
      `collector ${sourcePath}.attempts.${objectKey}.attemptKey`
    );
    const batchSlug = publicIdentifier(
      rawAttempt.batchSlug ?? collector.source?.batchSlug,
      `collector ${sourcePath}.attempts.${objectKey}.batchSlug`,
      80
    );
    const platform = requiredText(
      rawAttempt.platform,
      `collector ${sourcePath}.attempts.${objectKey}.platform`
    ).toLowerCase();
    if (!CORE_PLATFORMS.has(platform)) {
      throw new Error(`collector ${sourcePath}.attempts.${objectKey}.platform is unsupported.`);
    }
    const entityType = requiredText(
      rawAttempt.entityType,
      `collector ${sourcePath}.attempts.${objectKey}.entityType`
    );
    if (!["company", "founder"].includes(entityType)) {
      throw new Error(`collector ${sourcePath}.attempts.${objectKey}.entityType is invalid.`);
    }
    const projected = {
      batchSlug,
      platform,
      entityType,
      entityId: publicIdentifier(
        rawAttempt.entityId,
        `collector ${sourcePath}.attempts.${objectKey}.entityId`,
        256
      ),
      attemptKey
    };
    for (const field of ["status", "outcomeStatus"]) {
      if (rawAttempt[field] !== undefined && rawAttempt[field] !== null && rawAttempt[field] !== "") {
        projected[field] = boundedToken(
          rawAttempt[field],
          `collector ${sourcePath}.attempts.${objectKey}.${field}`
        );
      }
    }
    for (const field of ["checkedAt", "recentWindowCoverageCutoff"]) {
      if (rawAttempt[field] !== undefined && rawAttempt[field] !== null && rawAttempt[field] !== "") {
        projected[field] = canonicalTimestamp(
          rawAttempt[field],
          `collector ${sourcePath}.attempts.${objectKey}.${field}`
        );
      }
    }
    if (hasValue(rawAttempt.error)) {
      projected.error = "redacted_operational_error_present";
    }
    if (hasValue(rawAttempt.blocker)) {
      projected.blocker = "redacted_operational_blocker_present";
    }
    if (rawAttempt.recentWindowProof !== undefined && rawAttempt.recentWindowProof !== null) {
      projected.recentWindowProof = sanitizeRecentWindowProof(
        rawAttempt.recentWindowProof,
        journalBindings,
        `collector ${sourcePath}.attempts.${objectKey}.recentWindowProof`
      );
    }
    const projectedKey = `attempt-${sha256(`${sourcePath}\n${objectKey}`).slice(0, 32)}`;
    if (Object.hasOwn(attempts, projectedKey)) {
      throw new Error(`Projected attempt key collision in ${sourcePath}.`);
    }
    attempts[projectedKey] = projected;
  }
  return {
    source: { projection: PUBLIC_INGESTION_PROOF_ARTIFACT_VERSION },
    attempts
  };
}

function sanitizeRecentWindowProof(value, journalBindings, label) {
  assertObject(value, label);
  assertAllowedKeys(value, RECENT_PROOF_KEYS, label);
  if (
    value.schemaVersion !== "recent-native-window-proof.v1" ||
    value.status !== "complete" ||
    value.coverageScope !== "pair_all_native_targets" ||
    value.sourceExhausted !== true ||
    value.nextCursor !== null ||
    value.truncated !== false ||
    value.limitReached !== false ||
    !Array.isArray(value.blockers) ||
    value.blockers.length !== 0
  ) {
    throw new Error(`${label} is not a complete, body-free recent-window proof.`);
  }
  const output = {
    schemaVersion: "recent-native-window-proof.v1",
    status: "complete",
    coverageScope: "pair_all_native_targets",
    coveredFrom: canonicalTimestamp(value.coveredFrom, `${label}.coveredFrom`),
    coveredThrough: canonicalTimestamp(value.coveredThrough, `${label}.coveredThrough`),
    checkedAt: canonicalTimestamp(value.checkedAt, `${label}.checkedAt`),
    sourceExhausted: true,
    nextCursor: null,
    truncated: false,
    limitReached: false,
    pageLimit: positiveInteger(value.pageLimit, `${label}.pageLimit`),
    pagesAttempted: nonNegativeInteger(value.pagesAttempted, `${label}.pagesAttempted`),
    pagesFetched: nonNegativeInteger(value.pagesFetched, `${label}.pagesFetched`),
    blockers: []
  };
  const descriptor = value.requestJournal;
  assertObject(descriptor, `${label}.requestJournal`);
  assertAllowedKeys(descriptor, JOURNAL_DESCRIPTOR_KEYS, `${label}.requestJournal`);
  const journal = {
    path: validateRelativePath(descriptor.path, `${label}.requestJournal.path`),
    sha256: requiredSha256(descriptor.sha256, `${label}.requestJournal.sha256`),
    observedAt: canonicalTimestamp(
      descriptor.observedAt,
      `${label}.requestJournal.observedAt`
    )
  };
  if (!journal.path.startsWith("recent-window-journals/")) {
    throw new Error(`${label}.requestJournal must be under recent-window-journals/.`);
  }
  const existing = journalBindings.get(journal.path);
  if (existing && stableJson(existing) !== stableJson(journal)) {
    throw new Error(`Recent-window journal ${journal.path} is bound inconsistently.`);
  }
  journalBindings.set(journal.path, journal);
  output.requestJournal = journal;
  return output;
}

function validatePublicJournal(bytes, label) {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n")) throw new Error(`${label} must end with a newline.`);
  const lines = text.slice(0, -1).split("\n");
  if (lines.length === 0 || lines.some((line) => !line)) {
    throw new Error(`${label} must contain non-empty NDJSON rows.`);
  }
  for (let index = 0; index < lines.length; index += 1) {
    const row = parseJson(Buffer.from(lines[index]), `${label} row ${index + 1}`);
    assertObject(row, `${label} row ${index + 1}`);
    assertAllowedKeys(row, PAGE_RECEIPT_KEYS, `${label} row ${index + 1}`);
    if (row.schemaVersion !== "recent-native-page-receipt.v1") {
      throw new Error(`${label} row ${index + 1} has an incompatible schemaVersion.`);
    }
    const requestUrl = validatePublicProofRequestUrl(
      row.requestUrl,
      `${label} row ${index + 1}.requestUrl`
    );
    positiveInteger(row.sequence, `${label} row ${index + 1}.sequence`);
    publicAttemptKey(row.attemptKey, `${label} row ${index + 1}.attemptKey`);
    publicIdentifier(row.pairKey, `${label} row ${index + 1}.pairKey`, 512);
    canonicalTimestamp(row.requestedAt, `${label} row ${index + 1}.requestedAt`);
    canonicalTimestamp(row.completedAt, `${label} row ${index + 1}.completedAt`);
    canonicalTimestamp(row.coverageFrom, `${label} row ${index + 1}.coverageFrom`);
    canonicalTimestamp(row.coverageThrough, `${label} row ${index + 1}.coverageThrough`);
    if (row.status !== "success" || typeof row.sourceExhausted !== "boolean") {
      throw new Error(`${label} row ${index + 1} has an invalid terminal status.`);
    }
    const host = new URL(requestUrl).hostname.toLowerCase();
    for (const [field, cursor] of [["cursorIn", row.cursorIn], ["cursorOut", row.cursorOut]]) {
      if (cursor !== null && (
        typeof cursor !== "string" ||
        cursor.length > 32 ||
        (host === "hn.algolia.com" ? !/^\d+$/.test(cursor) : true)
      )) {
        throw new Error(`${label} row ${index + 1}.${field} is not a public-safe cursor.`);
      }
    }
    requiredSha256(row.responseSha256, `${label} row ${index + 1}.responseSha256`);
    assertNoHighConfidenceSecret(lines[index], `${label} row ${index + 1}`);
  }
}

function publicSafeCatalogMatrix(rawCatalogs) {
  const catalogs = normalizeAutonomousIngestionCatalogs(rawCatalogs);
  return catalogs.map((catalog) => ({
    batchSlug: publicIdentifier(catalog.batchSlug, "catalog.batchSlug", 80),
    sourcePath: "public-safe-proof/canonical-core-matrix",
    sourceVersion: `source-sha256:${catalog.sourceHash}`,
    companies: catalog.companies.map((company) => ({
      id: publicIdentifier(company.id, "catalog.company.id", 256),
      name: publicIdentifier(company.id, "catalog.company.id", 256),
      accounts: [],
      founders: company.founders.map((founder) => ({
        id: publicIdentifier(founder.id, "catalog.founder.id", 256),
        name: publicIdentifier(founder.id, "catalog.founder.id", 256),
        accounts: []
      }))
    }))
  }));
}

function publicSafeRunnerLog(bytes, expectedCompletedAt) {
  const rows = parseNdjson(bytes, "source runner log");
  const started = rows.filter((row) => row?.eventType === "run.started");
  const completed = rows.filter((row) => row?.eventType === "run.completed");
  if (started.length !== 1 || completed.length !== 1) {
    throw new Error("Source runner log must contain one run.started and run.completed.");
  }
  const startedAt = canonicalTimestamp(started[0].createdAt, "run.started.createdAt");
  const completedAt = canonicalTimestamp(completed[0].createdAt, "run.completed.createdAt");
  if (completedAt !== expectedCompletedAt || startedAt > completedAt) {
    throw new Error("Source runner timing does not reconcile with coverageGeneratedAt.");
  }
  return [
    { eventType: "run.started", createdAt: startedAt },
    { eventType: "run.completed", createdAt: completedAt }
  ];
}

function usageDocument() {
  return `# Public-safe recent ingestion proof journals\n\n` +
    `This artifact contains no raw collector bodies, raw evidence, stored-unpublished ` +
    `rows, credentials, auth headers, or request/response bodies.\n\n` +
    `From the extracted artifact directory, run:\n\n` +
    "```sh\n" +
    `PROOF_MANIFEST_SHA256=<digest-from-workflow-summary>\n` +
    `node scripts/generate-recent-completion-proofs.mjs ` +
    `--campaign=campaign.json --expected-sha256="$PROOF_MANIFEST_SHA256" ` +
    `--output-dir=work/recent-completion-proofs/<new-run-name>\n` +
    "```\n";
}

function collectArtifactDescriptors(value, pointer = "artifacts", output = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectArtifactDescriptors(entry, `${pointer}[${index}]`, output)
    );
    return output;
  }
  if (!isObject(value)) return output;
  if (["path", "sha256", "observedAt", "format"].every((key) =>
    Object.hasOwn(value, key)
  )) {
    output.push({ pointer, value });
    return output;
  }
  for (const key of Object.keys(value).sort()) {
    collectArtifactDescriptors(value[key], `${pointer}.${key}`, output);
  }
  return output;
}

function normalizeDescriptor(value, label) {
  assertObject(value, label);
  return {
    path: validateRelativePath(value.path, `${label}.path`),
    sha256: requiredSha256(value.sha256, `${label}.sha256`),
    bytes: value.bytes === undefined ? null : nonNegativeInteger(value.bytes, `${label}.bytes`),
    observedAt: canonicalTimestamp(value.observedAt, `${label}.observedAt`),
    format: boundedToken(value.format, `${label}.format`),
    kind: typeof value.kind === "string" && value.kind.trim() ? value.kind.trim() : null
  };
}

async function writeArtifact({ root, path, body, observedAt, format }) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  assertUploadBodySafe(bytes.toString("utf8"), path);
  const destination = resolve(root, validateRelativePath(path, "artifact path"));
  if (!sameOrInside(root, destination) || destination === root) {
    throw new Error(`Artifact path escapes output root: ${path}.`);
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  return {
    path: relative(root, destination).split(sep).join("/"),
    sha256: sha256(bytes),
    bytes: bytes.length,
    observedAt: canonicalTimestamp(observedAt, `${path}.observedAt`),
    format
  };
}

async function resolveDeclaredFile(root, relativePath) {
  const normalized = validateRelativePath(relativePath, "artifact path");
  const unresolved = resolve(root, normalized);
  if (!sameOrInside(root, unresolved) || unresolved === root) {
    throw new Error(`Artifact path escapes package root: ${normalized}.`);
  }
  const resolvedPath = await realpath(unresolved);
  if (!sameOrInside(root, resolvedPath) || resolvedPath === root) {
    throw new Error(`Artifact path escapes package root: ${normalized}.`);
  }
  return resolvedPath;
}

function validateRelativePath(value, label) {
  const path = requiredText(value, label).replace(/\\/g, "/");
  if (
    path.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path.startsWith("/") ||
    path.split("/").some((part) => part === ".." || part === "." || part === "")
  ) {
    throw new Error(`${label} must be a normalized path inside the package directory.`);
  }
  return path;
}

function compareDescriptorPath(left, right) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function sameOrInside(root, candidate) {
  const child = relative(root, candidate);
  return child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !child.startsWith(sep));
}

async function readBoundedFile(path, maximum, label) {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > maximum) {
    throw new Error(`${label} must be a regular file no larger than ${maximum} bytes.`);
  }
  const bytes = await readFile(path);
  if (bytes.length !== metadata.size) throw new Error(`${label} changed while being read.`);
  return bytes;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function assertMissing(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} already exists: ${path}.`);
}

function validateArtifactName(value) {
  const name = requiredText(value, "artifactName");
  if (name.length > 255 || /[\\/:"<>|*?\r\n]/.test(name)) {
    throw new TypeError("artifactName contains characters rejected by GitHub Actions.");
  }
  return name;
}

function validateRepository(value) {
  const repository = requiredText(value, "repository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new TypeError("repository must use the GitHub owner/name form.");
  }
  return repository;
}

function digits(value, label) {
  const text = requiredText(value, label);
  if (!/^\d{1,32}$/.test(text)) {
    throw new TypeError(`${label} must contain 1-32 digits.`);
  }
  return text;
}

function canonicalTimestamp(value, label) {
  const text = requiredText(value, label);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    throw new TypeError(`${label} must be a canonical ISO UTC timestamp.`);
  }
  return text;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function parseNdjson(bytes, label) {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n")) throw new Error(`${label} must end with a newline.`);
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0)) throw new Error(`${label} has a blank row.`);
  return lines.map((line, index) => parseJson(Buffer.from(line), `${label} row ${index + 1}`));
}

function assertAllowedKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) throw new Error(`${label} contains forbidden field ${unknown[0]}.`);
}

function assertNoHighConfidenceSecret(value, label) {
  if (HIGH_CONFIDENCE_SECRET.test(String(value))) {
    throw new Error(`${label} contains secret-shaped material.`);
  }
}

function assertUploadBodySafe(value, label) {
  if (/\u0000/.test(String(value))) {
    throw new Error(`${label} contains a NUL byte and is not safe to upload.`);
  }
  assertNoHighConfidenceSecret(value, label);
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${label} is required.`);
  return text;
}

function boundedPublicText(value, label, maximum) {
  const text = requiredText(value, label);
  if (text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new TypeError(`${label} exceeds the public-safe text contract.`);
  }
  assertNoHighConfidenceSecret(text, label);
  return text;
}

function publicIdentifier(value, label, maximum) {
  const text = boundedPublicText(value, label, maximum);
  if (!/^[A-Za-z0-9._:@/-]+$/.test(text)) {
    throw new TypeError(`${label} must be a public-safe identifier.`);
  }
  return text;
}

function publicAttemptKey(value, label) {
  const text = boundedPublicText(value, label, 4_096);
  if (!/^[A-Za-z0-9._:@/?=&%+-]+$/.test(text)) {
    throw new TypeError(`${label} must be a public-safe attempt key.`);
  }
  return text;
}

function boundedToken(value, label) {
  const text = requiredText(value, label);
  if (!/^[A-Za-z0-9._:+-]{1,80}$/.test(text)) {
    throw new TypeError(`${label} must be a bounded token.`);
  }
  return text;
}

function requiredSha256(value, label) {
  const text = requiredText(value, label);
  if (!SHA256_PATTERN.test(text)) {
    throw new TypeError(`${label} must be lowercase SHA-256.`);
  }
  return text;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function hasValue(value) {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return true;
}

function assertObject(value, label) {
  if (!isObject(value)) throw new TypeError(`${label} must be an object.`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
