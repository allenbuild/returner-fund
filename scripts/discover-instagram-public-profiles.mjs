#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadAutonomousCatalogs } from "./lib/autonomous-ingestion-plan.mjs";
import {
  instagramPublicProfileRequest,
  parseInstagramPublicProfileResponse
} from "./lib/instagram-public-profile.mjs";

const VERIFIED_OVERRIDES_RELATIVE_PATH =
  "src/lib/social/verified-social-overrides.json";
const DEFAULT_DELAY_MS = 1_500;
const MINIMUM_DELAY_MS = 1_000;
const DEFAULT_WORKERS = 1;
const MAXIMUM_WORKERS = 2;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 4_000_000;
const MAX_COMPANY_CANDIDATES = 3;
const CHECKPOINT_VERSION = 1;
const RESERVED_HOST_SUFFIXES = [
  "github.io",
  "pages.dev",
  "vercel.app",
  "netlify.app",
  "webflow.io",
  "notion.site",
  "substack.com",
  "carrd.co",
  "co.uk",
  "com.au",
  "com.br",
  "com.mx",
  "com.sg",
  "co.in",
  "co.jp",
  "co.nz"
];
const TERMINAL_RESULT_STATUSES = new Set([
  "verified",
  "needs_review",
  "not_found"
]);

export function normalizeInstagramUsername(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    if (/^https?:\/\//i.test(value.trim())) {
      return instagramPublicProfileRequest({ accountUrl: value.trim() }).username;
    }
    return instagramPublicProfileRequest({ username: value.trim() }).username;
  } catch {
    return null;
  }
}

export function normalizedPublicHost(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    if (!host || host === "localhost" || /^\d+(?:\.\d+){3}$/.test(host)) return null;
    return host;
  } catch {
    return null;
  }
}

export function deriveInstagramPublicProfileTargets(catalog, {
  includeFounders = false
} = {}) {
  if (!catalog?.slug || !Array.isArray(catalog.companies)) {
    throw new TypeError("Instagram discovery requires one normalized batch catalog.");
  }

  const targets = [];
  for (const company of catalog.companies) {
    const companySlug = companySlugForCatalogEntity(company);
    const companyCandidates = candidateRecordsForCompany(company, companySlug)
      .slice(0, MAX_COMPANY_CANDIDATES);
    for (const candidate of companyCandidates) {
      targets.push(targetForCandidate({
        batchSlug: catalog.slug,
        company,
        companySlug,
        entity: company,
        candidate
      }));
    }

    if (!includeFounders) continue;
    for (const founder of company.founders ?? []) {
      for (const candidate of candidateRecordsForFounder(founder).slice(0, 3)) {
        targets.push(targetForCandidate({
          batchSlug: catalog.slug,
          company,
          companySlug,
          entity: founder,
          candidate
        }));
      }
    }
  }
  return targets.sort((left, right) => left.id.localeCompare(right.id));
}

export function assessInstagramPublicProfileOwnership({
  target,
  payload,
  parsedProfile,
  fetchedAt
}) {
  const rawUser = payload?.data?.user;
  const returnedUsername = normalizeInstagramUsername(rawUser?.username ?? "");
  const externalUrl = sanitizePublicUrl(rawUser?.external_url);
  const externalHost = normalizedPublicHost(externalUrl);

  if (!parsedProfile?.verified) {
    return {
      status: "needs_review",
      reason: parsedProfile?.reason ?? "instagram_public_profile_unverified",
      fetchedAt,
      returnedUsername,
      externalUrl,
      externalHost,
      ownershipProof: null
    };
  }
  if (!returnedUsername || returnedUsername !== target.username) {
    return {
      status: "needs_review",
      reason: "instagram_public_profile_username_mismatch",
      fetchedAt,
      returnedUsername,
      externalUrl,
      externalHost,
      ownershipProof: null
    };
  }

  const mapping = target.existingMappings?.find(
    (candidate) => candidate.username === returnedUsername
  );
  if (mapping) {
    return {
      status: "verified",
      reason: "exact_username_and_existing_snapshot_mapping",
      fetchedAt,
      returnedUsername,
      externalUrl,
      externalHost,
      ownershipProof: {
        kind: "existing_snapshot_mapping",
        sourceUrl: mapping.sourceUrl ?? mapping.accountUrl
      }
    };
  }

  if (externalHost && target.officialHosts?.includes(externalHost)) {
    return {
      status: "verified",
      reason: "exact_username_and_official_external_url_host",
      fetchedAt,
      returnedUsername,
      externalUrl,
      externalHost,
      ownershipProof: {
        kind: "official_external_url_host",
        sourceUrl: target.officialWebsiteUrl,
        host: externalHost
      }
    };
  }

  return {
    status: "needs_review",
    reason: "exact_username_without_official_ownership_proof",
    fetchedAt,
    returnedUsername,
    externalUrl,
    externalHost,
    ownershipProof: null
  };
}

export function instagramGlobalCircuitReason({ status, payload, bodyText } = {}) {
  const numericStatus = Number(status);
  if ([401, 403, 429].includes(numericStatus)) return `http_${numericStatus}`;

  const topLevelCircuit =
    payload?.challenge != null ||
    payload?.challenge_context != null ||
    payload?.checkpoint_url != null ||
    payload?.checkpointUrl != null ||
    payload?.login_required === true ||
    payload?.require_login === true ||
    payload?.rate_limited === true ||
    payload?.feedback_required === true;
  if (topLevelCircuit) return "instagram_challenge_or_restriction";

  const boundedText = [
    typeof bodyText === "string" ? bodyText.slice(0, 200_000) : "",
    safeJsonString(payload).slice(0, 200_000)
  ].join("\n");
  if (
    /challenge_required|checkpoint_url|checkpoint required|login_required|feedback_required|rate_limited|too many requests|please wait a few minutes|temporarily restricted|suspicious login/i
      .test(boundedText)
  ) {
    return "instagram_challenge_or_restriction";
  }
  return null;
}

export function mergeVerifiedInstagramOverrides(overrides, results) {
  if (!isPlainObject(overrides)) {
    throw new TypeError("Verified social overrides must be a JSON object.");
  }
  const next = JSON.parse(JSON.stringify(overrides));
  const { promotions, skipped } = chooseUnambiguousPromotions(results);
  const promoted = [];

  for (const result of promotions) {
    const { target } = result;
    const companyEntry = { ...(next[target.companySlug] ?? {}) };
    const validation = instagramValidationForResult(result);
    if (target.entityType === "company") {
      companyEntry.companySocialLinks = {
        ...(companyEntry.companySocialLinks ?? companyEntry.company ?? {}),
        instagram: result.profile.accountUrl
      };
      companyEntry.instagramValidation = validation;
      companyEntry.matchReason ??=
        "Exact public Instagram profile identity and official ownership were verified without an authenticated session.";
      next[target.companySlug] = companyEntry;
      promoted.push({
        entityType: target.entityType,
        entitySourceKey: target.entitySourceKey,
        username: target.username,
        companySlug: target.companySlug
      });
      continue;
    }

    const founders = [...(companyEntry.founders ?? [])];
    const founderMatches = founders
      .map((founder, index) => ({ founder, index }))
      .filter(({ founder }) => founderOverrideMatchesTarget(founder, target));
    if (founderMatches.length > 1) {
      skipped.push({
        entitySourceKey: target.entitySourceKey,
        username: target.username,
        reason: "ambiguous_founder_override_identity"
      });
      continue;
    }
    const founderIndex = founderMatches[0]?.index ?? founders.length;
    const founderOverride = founderMatches[0]?.founder ?? {
      id: target.entitySourceKey,
      name: target.entityName
    };
    founders[founderIndex] = {
      ...founderOverride,
      sourceUrl: result.ownership.ownershipProof.sourceUrl,
      socialLinks: {
        ...(founderOverride.socialLinks ?? {}),
        instagram: result.profile.accountUrl
      },
      instagramValidation: validation,
      matchReason: founderOverride.matchReason ??
        "Exact public Instagram profile identity and explicit founder ownership were verified without an authenticated session."
    };
    companyEntry.founders = founders;
    next[target.companySlug] = companyEntry;
    promoted.push({
      entityType: target.entityType,
      entitySourceKey: target.entitySourceKey,
      username: target.username,
      companySlug: target.companySlug
    });
  }

  return {
    overrides: Object.fromEntries(
      Object.entries(next).sort(([left], [right]) => left.localeCompare(right))
    ),
    promoted,
    skipped
  };
}

export async function writeVerifiedInstagramOverrides({
  overridesPath,
  expectedHash,
  results
}) {
  const originalBytes = await readFile(overridesPath);
  const observedHash = sha256(originalBytes);
  if (!expectedHash || observedHash !== expectedHash) {
    throw new Error(
      "Verified social overrides changed during Instagram discovery; refusing to overwrite concurrent work."
    );
  }
  const current = JSON.parse(originalBytes.toString("utf8"));
  const merged = mergeVerifiedInstagramOverrides(current, results);
  if (merged.promoted.length === 0) {
    return {
      ...merged,
      written: false,
      hashBefore: observedHash,
      hashAfter: observedHash
    };
  }

  const temporaryPath = `${overridesPath}.instagram-${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(merged.overrides, null, 2)}\n`,
      { flag: "wx" }
    );
    if (sha256(await readFile(overridesPath)) !== expectedHash) {
      throw new Error(
        "Verified social overrides changed before atomic Instagram publication; write aborted."
      );
    }
    await rename(temporaryPath, overridesPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return {
    ...merged,
    written: true,
    hashBefore: observedHash,
    hashAfter: sha256(await readFile(overridesPath))
  };
}

export async function main(rawArgs = process.argv.slice(2), dependencies = {}) {
  const options = parseCliArgs(rawArgs);
  if (options.help) {
    console.log(helpText());
    return { status: "help" };
  }
  const root = resolve(dependencies.root ?? process.cwd());
  const overridesPath = resolve(root, VERIFIED_OVERRIDES_RELATIVE_PATH);
  const initialOverrideBytes = await readFile(overridesPath);
  const initialOverrideHash = sha256(initialOverrideBytes);
  const catalogs = await loadAutonomousCatalogs(root);
  if (sha256(await readFile(overridesPath)) !== initialOverrideHash) {
    throw new Error("Verified social overrides changed while the Instagram plan was loading.");
  }
  const catalog = catalogs.find((candidate) => candidate.slug === options.batch);
  if (!catalog) throw new Error(`Unknown normalized batch ${options.batch}.`);
  const targets = deriveInstagramPublicProfileTargets(catalog, {
    includeFounders: options.includeFounders
  });
  const planHash = sha256(JSON.stringify(targets));
  const outputPath = resolve(root, options.output ??
    `outputs/instagram-public-profiles-${options.batch.toLowerCase()}.json`);
  const checkpointPath = resolve(root, options.checkpoint ??
    `work/instagram-public-profiles-${options.batch.toLowerCase()}.checkpoint.json`);
  assertSafePaths({ overridesPath, outputPath, checkpointPath });

  const plan = {
    schemaVersion: 1,
    mode: "plan",
    batchSlug: catalog.slug,
    companyCount: catalog.companies.length,
    includeFounders: options.includeFounders,
    workers: options.workers,
    delayMs: options.delayMs,
    targetCount: targets.length,
    planHash,
    targets
  };
  if (options.plan) {
    if (options.outputExplicit) await atomicWriteJson(outputPath, plan);
    console.log(JSON.stringify(plan, null, 2));
    return plan;
  }

  const checkpoint = await loadOrCreateCheckpoint({
    checkpointPath,
    batchSlug: catalog.slug,
    planHash
  });
  const circuit = createGlobalCircuit();
  const gate = createGlobalStartGate(options.delayMs);
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("Global fetch is unavailable.");
  let nextTargetIndex = 0;
  let checkpointWrite = Promise.resolve();
  const saveCheckpoint = async () => {
    checkpoint.updatedAt = new Date().toISOString();
    checkpointWrite = checkpointWrite.then(() => atomicWriteJson(checkpointPath, checkpoint));
    await checkpointWrite;
  };

  const worker = async () => {
    while (!circuit.isOpen()) {
      const target = targets[nextTargetIndex];
      nextTargetIndex += 1;
      if (!target) return;
      if (TERMINAL_RESULT_STATUSES.has(checkpoint.results[target.id]?.status)) continue;
      const result = await inspectInstagramTarget({
        target,
        fetchImpl,
        gate,
        circuit,
        timeoutMs: options.timeoutMs
      });
      checkpoint.results[target.id] = result;
      if (circuit.isOpen()) checkpoint.circuit = circuit.details();
      await saveCheckpoint();
    }
  };
  await Promise.all(Array.from({ length: options.workers }, () => worker()));

  const results = targets
    .map((target) => checkpoint.results[target.id])
    .filter(Boolean);
  const counts = resultCounts(results, targets.length);
  let publication = null;
  if (options.write) {
    publication = await writeVerifiedInstagramOverrides({
      overridesPath,
      expectedHash: initialOverrideHash,
      results
    });
  }
  const report = {
    schemaVersion: 1,
    mode: options.write ? "scan_and_write" : "scan",
    batchSlug: catalog.slug,
    generatedAt: new Date().toISOString(),
    planHash,
    targetCount: targets.length,
    counts,
    circuit: circuit.details(),
    publication: publication && {
      written: publication.written,
      promoted: publication.promoted,
      skipped: publication.skipped,
      hashBefore: publication.hashBefore,
      hashAfter: publication.hashAfter
    },
    results
  };
  await atomicWriteJson(outputPath, report);
  console.log(JSON.stringify({
    status: circuit.isOpen() ? "circuit_open" : "complete",
    batchSlug: catalog.slug,
    outputPath,
    checkpointPath,
    ...counts,
    promoted: publication?.promoted.length ?? 0
  }, null, 2));
  return report;
}

function candidateRecordsForCompany(company, companySlug) {
  const records = new Map();
  addExistingMappings(records, company.accounts);
  addCandidate(records, domainUsername(company.websiteUrl), {
    kind: "official_website_host",
    sourceUrl: sanitizePublicUrl(company.websiteUrl)
  });
  addCandidate(records, compactUsername(companySlug), { kind: "company_slug" });
  addCandidate(records, compactUsername(company.name), { kind: "company_name" });
  return sortedCandidateRecords(records);
}

function candidateRecordsForFounder(founder) {
  const records = new Map();
  addExistingMappings(records, founder.accounts);
  addCandidate(records, domainUsername(founder.websiteUrl), {
    kind: "personal_website_host",
    sourceUrl: sanitizePublicUrl(founder.websiteUrl)
  });
  return sortedCandidateRecords(records);
}

function addExistingMappings(records, accounts = []) {
  for (const account of accounts) {
    if (String(account?.platform).toLowerCase() !== "instagram") continue;
    const username = normalizeInstagramUsername(account.url ?? account.handle ?? "");
    if (!username) continue;
    const accountUrl = `https://www.instagram.com/${username}/`;
    addCandidate(records, username, {
      kind: "existing_instagram_mapping",
      accountUrl,
      sourceUrl: sanitizePublicUrl(account.discoveredFromUrl) ?? accountUrl,
      reviewState: account.reviewState ?? null
    });
  }
}

function addCandidate(records, rawUsername, source) {
  const username = normalizeInstagramUsername(rawUsername ?? "");
  if (!username) return;
  const existing = records.get(username) ?? { username, sources: [] };
  if (!existing.sources.some((candidate) => safeJsonString(candidate) === safeJsonString(source))) {
    existing.sources.push(source);
  }
  records.set(username, existing);
}

function sortedCandidateRecords(records) {
  const priority = {
    existing_instagram_mapping: 0,
    official_website_host: 1,
    personal_website_host: 1,
    company_slug: 2,
    company_name: 3
  };
  return [...records.values()].sort((left, right) => {
    const leftPriority = Math.min(...left.sources.map((source) => priority[source.kind] ?? 99));
    const rightPriority = Math.min(...right.sources.map((source) => priority[source.kind] ?? 99));
    return leftPriority - rightPriority || left.username.localeCompare(right.username);
  });
}

function targetForCandidate({ batchSlug, company, companySlug, entity, candidate }) {
  const officialWebsiteUrl = sanitizePublicUrl(entity.websiteUrl);
  const officialHost = normalizedPublicHost(officialWebsiteUrl);
  const existingMappings = candidate.sources
    .filter((source) => source.kind === "existing_instagram_mapping")
    .map((source) => ({
      username: candidate.username,
      accountUrl: source.accountUrl,
      sourceUrl: source.sourceUrl,
      reviewState: source.reviewState
    }));
  const entityType = entity.entityType === "founder" ? "founder" : "company";
  return {
    id: [batchSlug, entityType, entity.sourceKey, candidate.username].join(":"),
    batchSlug,
    companySlug,
    companySourceKey: company.sourceKey,
    companyName: company.name,
    entityType,
    entitySourceKey: entity.sourceKey,
    entityName: entity.name,
    username: candidate.username,
    accountUrl: `https://www.instagram.com/${candidate.username}/`,
    candidateSources: candidate.sources,
    officialWebsiteUrl,
    officialHosts: officialHost ? [officialHost] : [],
    existingMappings
  };
}

function companySlugForCatalogEntity(company) {
  try {
    const parts = new URL(company.profileUrl).pathname.split("/").filter(Boolean);
    const index = parts.indexOf("companies");
    if (index >= 0 && parts[index + 1]) return parts[index + 1];
  } catch {
    // Fall through to the stable catalog identity.
  }
  return String(company.sourceKey ?? "")
    .replace(/^company-/, "")
    .replace(/^a16z-speedrun-006-/, "");
}

function compactUsername(value) {
  if (typeof value !== "string") return null;
  const candidate = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 30);
  return normalizeInstagramUsername(candidate);
}

function domainUsername(websiteUrl) {
  const host = normalizedPublicHost(websiteUrl);
  if (!host) return null;
  const labels = host.split(".");
  if (labels.length < 2) return null;
  const matchedSuffix = RESERVED_HOST_SUFFIXES.find(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`)
  );
  const suffixLabelCount = matchedSuffix?.split(".").length ?? 1;
  const registrableIndex = labels.length - suffixLabelCount - 1;
  if (registrableIndex < 0) return null;
  return compactUsername(labels[registrableIndex]);
}

async function inspectInstagramTarget({
  target,
  fetchImpl,
  gate,
  circuit,
  timeoutMs
}) {
  if (circuit.isOpen()) return skippedCircuitResult(target, circuit.details());
  await gate();
  if (circuit.isOpen()) return skippedCircuitResult(target, circuit.details());
  const fetchedAt = new Date().toISOString();
  const request = instagramPublicProfileRequest({
    accountUrl: target.accountUrl,
    username: target.username
  });
  const controller = new AbortController();
  const unregister = circuit.register(controller);
  const timeout = setTimeout(() => controller.abort("instagram_public_profile_timeout"), timeoutMs);
  try {
    const response = await fetchImpl(request.url, {
      ...request.options,
      signal: controller.signal
    });
    const bodyText = await readBoundedResponseText(response, MAX_RESPONSE_BYTES);
    let payload = null;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      // The shared parser will fail closed on malformed JSON.
    }
    const circuitReason = instagramGlobalCircuitReason({
      status: response.status,
      payload,
      bodyText
    });
    if (circuitReason) {
      circuit.trip({ reason: circuitReason, status: response.status, targetId: target.id, fetchedAt });
      return {
        target,
        status: "circuit_open",
        reason: circuitReason,
        fetchedAt,
        httpStatus: response.status
      };
    }
    if (response.status === 404) {
      return {
        target,
        status: "not_found",
        reason: "instagram_public_profile_not_found",
        fetchedAt,
        httpStatus: response.status
      };
    }
    if (!response.ok) {
      return {
        target,
        status: "failed",
        reason: `instagram_public_profile_http_${response.status}`,
        fetchedAt,
        httpStatus: response.status
      };
    }
    const parsedProfile = parseInstagramPublicProfileResponse({
      payload: bodyText,
      requestedUsername: target.username,
      fetchedAt
    });
    const ownership = assessInstagramPublicProfileOwnership({
      target,
      payload,
      parsedProfile,
      fetchedAt
    });
    return {
      target,
      status: ownership.status,
      reason: ownership.reason,
      fetchedAt,
      httpStatus: response.status,
      ownership,
      profile: parsedProfile
    };
  } catch (error) {
    if (circuit.isOpen()) return skippedCircuitResult(target, circuit.details(), fetchedAt);
    return {
      target,
      status: "failed",
      reason: controller.signal.aborted
        ? "instagram_public_profile_timeout"
        : "instagram_public_profile_fetch_failed",
      fetchedAt,
      error: boundedErrorMessage(error)
    };
  } finally {
    clearTimeout(timeout);
    unregister();
  }
}

function createGlobalCircuit() {
  let opened = null;
  const controllers = new Set();
  return {
    isOpen: () => opened !== null,
    details: () => opened,
    register(controller) {
      controllers.add(controller);
      return () => controllers.delete(controller);
    },
    trip(details) {
      if (opened) return;
      opened = { ...details };
      for (const controller of controllers) controller.abort("instagram_global_circuit_open");
    }
  };
}

function createGlobalStartGate(delayMs) {
  let tail = Promise.resolve();
  let nextStartAt = 0;
  return async () => {
    let release;
    const previous = tail;
    tail = new Promise((resolveTail) => {
      release = resolveTail;
    });
    await previous;
    try {
      const waitMs = Math.max(0, nextStartAt - Date.now());
      if (waitMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
      nextStartAt = Date.now() + delayMs;
    } finally {
      release();
    }
  };
}

function chooseUnambiguousPromotions(results = []) {
  const grouped = new Map();
  for (const result of results) {
    if (
      result?.status !== "verified" ||
      !result?.profile?.verified ||
      !result?.ownership?.ownershipProof ||
      result.profile.username !== result.target?.username
    ) continue;
    const key = `${result.target.entityType}:${result.target.entitySourceKey}`;
    const group = grouped.get(key) ?? [];
    group.push(result);
    grouped.set(key, group);
  }

  const promotions = [];
  const skipped = [];
  for (const group of grouped.values()) {
    const mapped = group.filter(
      (result) => result.ownership.ownershipProof.kind === "existing_snapshot_mapping"
    );
    const eligible = mapped.length > 0 ? mapped : group;
    if (eligible.length !== 1) {
      skipped.push({
        entitySourceKey: group[0].target.entitySourceKey,
        usernames: eligible.map((result) => result.target.username).sort(),
        reason: "multiple_verified_instagram_profiles"
      });
      continue;
    }
    promotions.push(eligible[0]);
  }
  return { promotions, skipped };
}

function instagramValidationForResult(result) {
  const proof = result.ownership.ownershipProof;
  return {
    review_state: "verified",
    method: proof.kind === "existing_snapshot_mapping"
      ? "public_web_profile_info_exact_existing_mapping"
      : "public_web_profile_info_exact_official_host",
    username: result.target.username,
    accountUrl: result.profile.accountUrl,
    sourceUrl: proof.sourceUrl,
    profileExternalUrl: result.ownership.externalUrl ?? null,
    checkedAt: result.fetchedAt
  };
}

function founderOverrideMatchesTarget(founder, target) {
  if (!founder || !target) return false;
  if (founder.id === target.entitySourceKey) return true;
  if (founder.id && target.entitySourceKey.endsWith(`-${founder.id}`)) return true;
  return normalizedName(founder.name) === normalizedName(target.entityName);
}

function normalizedName(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseCliArgs(values) {
  const parsed = {};
  const booleanNames = new Set(["help", "plan", "write", "include-founders"]);
  const valueNames = new Set([
    "batch",
    "workers",
    "delay-ms",
    "timeout-ms",
    "output",
    "checkpoint"
  ]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) throw new Error(`Unexpected argument: ${value}`);
    const [rawName, inlineValue] = value.slice(2).split(/=(.*)/s, 2);
    if (Object.hasOwn(parsed, rawName)) {
      throw new Error(`Option --${rawName} may be supplied only once.`);
    }
    if (booleanNames.has(rawName)) {
      if (inlineValue != null) throw new Error(`--${rawName} does not accept a value.`);
      parsed[rawName] = true;
      continue;
    }
    if (!valueNames.has(rawName)) throw new Error(`Unknown option --${rawName}.`);
    const nextValue = inlineValue ?? values[index + 1];
    if (!nextValue || (inlineValue == null && nextValue.startsWith("--"))) {
      throw new Error(`Missing value for --${rawName}.`);
    }
    parsed[rawName] = nextValue;
    if (inlineValue == null) index += 1;
  }
  if (parsed.help) return { help: true };
  const batch = normalizeBatch(parsed.batch);
  if (!batch) {
    throw new Error("Exactly one --batch=S26, --batch=S2026, or --batch=A16ZSR006 is required.");
  }
  if (parsed.plan && parsed.write) throw new Error("--plan and --write cannot be combined.");
  const workers = integerOption(parsed.workers ?? DEFAULT_WORKERS, "workers");
  if (workers < 1 || workers > MAXIMUM_WORKERS) {
    throw new Error(`--workers must be between 1 and ${MAXIMUM_WORKERS}.`);
  }
  const delayMs = integerOption(parsed["delay-ms"] ?? DEFAULT_DELAY_MS, "delay-ms");
  if (delayMs < MINIMUM_DELAY_MS) {
    throw new Error(`--delay-ms must be at least ${MINIMUM_DELAY_MS}.`);
  }
  const timeoutMs = integerOption(parsed["timeout-ms"] ?? DEFAULT_TIMEOUT_MS, "timeout-ms");
  if (timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new Error("--timeout-ms must be between 1000 and 60000.");
  }
  return {
    batch,
    plan: parsed.plan === true,
    write: parsed.write === true,
    includeFounders: parsed["include-founders"] === true,
    workers,
    delayMs,
    timeoutMs,
    output: parsed.output,
    outputExplicit: Boolean(parsed.output),
    checkpoint: parsed.checkpoint
  };
}

function normalizeBatch(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (["S2026", "P26", "SPRING2026"].includes(normalized)) return "S2026";
  if (["S26", "SUMMER2026"].includes(normalized)) return "S26";
  if (["A16ZSR006", "A16Z-SR006", "SR006"].includes(normalized)) return "A16ZSR006";
  return null;
}

function integerOption(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`--${name} must be an integer.`);
  return number;
}

async function loadOrCreateCheckpoint({ checkpointPath, batchSlug, planHash }) {
  try {
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    if (
      checkpoint?.schemaVersion !== CHECKPOINT_VERSION ||
      checkpoint?.batchSlug !== batchSlug ||
      checkpoint?.planHash !== planHash ||
      !isPlainObject(checkpoint.results)
    ) {
      throw new Error(
        "Existing Instagram checkpoint does not match this exact batch plan; move it aside before restarting."
      );
    }
    return checkpoint;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {
      schemaVersion: CHECKPOINT_VERSION,
      batchSlug,
      planHash,
      createdAt: new Date().toISOString(),
      updatedAt: null,
      circuit: null,
      results: {}
    };
  }
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function readBoundedResponseText(response, maximumBytes) {
  const declaredLength = Number(response.headers?.get?.("content-length") ?? NaN);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error("Instagram public profile response exceeded the size limit.");
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maximumBytes) {
      throw new Error("Instagram public profile response exceeded the size limit.");
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error("Instagram public profile response exceeded the size limit.");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function sanitizePublicUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function skippedCircuitResult(target, details, fetchedAt = new Date().toISOString()) {
  return {
    target,
    status: "circuit_open",
    reason: details?.reason ?? "instagram_global_circuit_open",
    fetchedAt
  };
}

function resultCounts(results, total) {
  const counts = {
    verified: 0,
    needsReview: 0,
    notFound: 0,
    failed: 0,
    circuitOpen: 0,
    pending: Math.max(0, total - results.length)
  };
  for (const result of results) {
    if (result.status === "verified") counts.verified += 1;
    else if (result.status === "needs_review") counts.needsReview += 1;
    else if (result.status === "not_found") counts.notFound += 1;
    else if (result.status === "circuit_open") counts.circuitOpen += 1;
    else counts.failed += 1;
  }
  return counts;
}

function assertSafePaths({ overridesPath, outputPath, checkpointPath }) {
  if (outputPath === overridesPath || checkpointPath === overridesPath) {
    throw new Error("Output and checkpoint paths cannot replace verified social overrides.");
  }
  if (outputPath === checkpointPath) {
    throw new Error("Output and checkpoint paths must be different.");
  }
}

function boundedErrorMessage(error) {
  const message = String(error?.message ?? error ?? "unknown error");
  return message.slice(0, 500).replace(/[\r\n]+/g, " ");
}

function safeJsonString(value) {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function helpText() {
  return [
    "Usage: node scripts/discover-instagram-public-profiles.mjs --batch=S26 [options]",
    "",
    "Required:",
    "  --batch=S26|S2026|A16ZSR006   Scan exactly one batch.",
    "",
    "Safe modes:",
    "  --plan                         Derive exact candidates; make no requests.",
    "  --write                        Hash-guard verified override promotion.",
    "  --include-founders             Include only explicitly mapped/domain-backed founders.",
    "",
    "Limits:",
    "  --workers=1                    1 by default; hard maximum 2.",
    "  --delay-ms=1500                Global request-start delay; minimum 1000ms.",
    "  --timeout-ms=20000             Per-request timeout (1000-60000ms).",
    "  --output=PATH                  Scan report path.",
    "  --checkpoint=PATH              Resumable checkpoint path."
  ].join("\n");
}

const isDirectExecution = process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectExecution) {
  main().catch((error) => {
    console.error(boundedErrorMessage(error));
    process.exitCode = 1;
  });
}
