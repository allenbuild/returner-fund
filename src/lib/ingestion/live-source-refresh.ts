import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EvidenceMetrics, Platform, TopVoiceAudienceId, TopVoiceMember } from "@/lib/graph/types";
import { computeEvidenceRawEngagement } from "@/lib/graph/traction-scoring";
import { resolveTopVoiceAudience } from "@/lib/social/top-voices";

export type LiveRefreshStage =
  | "task_created"
  | "request_sent"
  | "received"
  | "parsed"
  | "filtered"
  | "dropped"
  | "accepted"
  | "stored"
  | "skipped"
  | "failed";

export interface LiveRefreshStageLog {
  stage: LiveRefreshStage;
  platform: Platform | "all";
  target?: string;
  companyName?: string;
  entityId?: string;
  sourceUrl?: string;
  count?: number;
  reason?: string;
  message: string;
  at: string;
}

export interface LiveEvidenceRecord {
  id: string;
  entityType: "company" | "founder";
  entityId: string;
  companyName: string;
  platform: Platform;
  title: string;
  sourceUrl: string;
  platformPostId?: string | null;
  text: string;
  thumbnailUrl?: string | null;
  thumbnailSource?: string | null;
  mediaUrl?: string | null;
  mediaUrls?: string[];
  media_urls?: string[];
  media_posters?: string[];
  linkStatus?: "verified" | "invalid" | "unchecked" | "blocked" | null;
  linkCheckedAt?: string | null;
  linkFailureReason?: string | null;
  rawVisibleText: string;
  postedAt: string | null;
  metrics: EvidenceMetrics;
  contributionScore: number;
  review_state: "verified" | "needs_review" | "rejected";
  matchReason: string;
  first_seen_at: string;
  last_checked_at: string;
  last_updated_at: string;
}

interface EvidenceSnapshot {
  source: {
    label?: string;
    fetchedAt: string;
    notes?: string[];
  };
  evidence: LiveEvidenceRecord[];
  needsReview?: unknown[];
}

interface RawSnapshot {
  companies: RawCompany[];
}

interface RawCompany {
  id: string;
  slug: string;
  name: string;
  batch: string;
  websiteUrl?: string | null;
  socialLinks?: Partial<Record<Platform, string>>;
  founders?: RawFounder[];
}

interface RawFounder {
  id: string;
  name: string;
  socialLinks?: Partial<Record<Platform, string>>;
}

interface VerifiedSocialOverride {
  companySocialLinks?: Partial<Record<Platform, string>>;
  founders?: VerifiedFounderOverride[];
}

interface VerifiedFounderOverride {
  id: string;
  name: string;
  socialLinks?: Partial<Record<Platform, string>>;
}

interface A16zSocialAccountSnapshot {
  companies?: A16zSocialAccountCompany[];
}

interface A16zSocialAccountCompany {
  companyName: string;
  companySlug?: string;
  accounts?: A16zSocialAccountRecord[];
  founders?: A16zSocialAccountFounder[];
}

interface A16zSocialAccountFounder {
  name: string;
  founderSlug?: string;
  accounts?: A16zSocialAccountRecord[];
}

interface A16zSocialAccountRecord {
  platform: Platform;
  url: string;
  handle?: string | null;
  review_state?: "verified" | "needs_review" | "rejected";
}

interface LiveSourceRefreshOptions {
  rootDir?: string;
  batchSlug?: string;
  batchSlugs?: string[];
  platforms?: Platform[];
  maxXTargets?: number;
  maxPostsPerTarget?: number;
  fetchImpl?: typeof fetch;
  now?: Date;
  write?: boolean;
  targetedEvidencePath?: string;
  xConcurrency?: number;
  xRequestTimeoutMs?: number;
  xTargetHandles?: string[];
  xSourceUrls?: string[];
  topVoices?: TopVoiceAudienceId;
  maxTopVoiceXTargets?: number;
  stageLogPath?: string;
}

export interface LiveSourceRefreshResult {
  runId: string;
  generatedAt: string;
  acceptedEvidence: LiveEvidenceRecord[];
  storedEvidence: LiveEvidenceRecord[];
  stageLog: LiveRefreshStageLog[];
  sourceSnapshots: {
    targetedEvidencePath: string;
    targetedEvidenceBefore: number;
    targetedEvidenceAfter: number;
  };
  platformRows: Partial<Record<Platform, number>>;
  failureReasonCounts: Record<string, number>;
}

interface XTarget {
  platform: "x";
  batchSlug: string;
  entityType: "company" | "founder";
  entityId: string;
  companyName: string;
  companySlug: string;
  companyWebsiteUrl: string | null;
  entityName: string;
  accountUrl: string;
  handle: string;
}

interface TopVoiceXTarget {
  platform: "x";
  batchSlug: string;
  member: TopVoiceMember;
  handle: string;
}

interface XStatusReference {
  handle: string;
  postId: string;
  sourceUrl: string;
}

interface CompanyMatchTarget {
  batchSlug: string;
  entityId: string;
  companyName: string;
  companySlug: string;
  companyWebsiteUrl: string | null;
  terms: string[];
}

interface FxTweet {
  url?: string;
  id?: string;
  text?: string;
  created_at?: string;
  created_timestamp?: number;
  is_retweet?: boolean;
  retweeted_status?: unknown;
  retweeted_tweet?: unknown;
  retweet?: unknown;
  reposted_tweet?: unknown;
  replies?: number;
  retweets?: number;
  likes?: number;
  views?: number;
  quotes?: number;
  bookmarks?: number;
  author?: {
    screen_name?: string;
    name?: string;
    url?: string;
    avatar_url?: string;
  };
  media?: {
    all?: Array<{
      url?: string;
      thumbnail_url?: string;
      type?: string;
    }>;
  };
}

interface ParsedLiveRawVisibleText {
  source?: string;
  profile?: {
    targetHandle?: string;
    accountUrl?: string;
    batchSlug?: string;
    directSource?: boolean;
    topVoiceMemberId?: string;
    topVoiceDisplayName?: string;
  };
  post?: FxTweet;
  counts?: EvidenceMetrics;
}

interface PersistedLiveEvidenceValidationContext {
  firstPartyTargetsByEntity: Map<string, XTarget>;
  topVoiceTargetsByHandle: Map<string, TopVoiceXTarget>;
  companyMatchTargets: CompanyMatchTarget[];
}

const DEFAULT_BATCH_SLUGS = ["S26", "S2026"];
const DEFAULT_MAX_X_TARGETS = 220;
const DEFAULT_MAX_TOP_VOICE_X_TARGETS = 50;
const DEFAULT_X_CONCURRENCY = 10;
const DEFAULT_X_REQUEST_TIMEOUT_MS = 4_500;
const TOP_VOICE_X_MISS_CACHE_TTL_MS = 10 * 60 * 1000;
const TARGETED_EVIDENCE_PATH = join("src", "lib", "social", "targeted-evidence-current.json");
const A16Z_SOCIAL_ACCOUNTS_PATH = join("src", "lib", "social", "a16z-speedrun-006-social-accounts.json");
const VERIFIED_SOCIAL_OVERRIDES_PATH = join("src", "lib", "social", "verified-social-overrides.json");
const STAGE_LOG_PATH = join("outputs", "ingestion-refresh-stage-log-current.json");
const LIVE_EVIDENCE_RECORD_CACHE_LIMIT = 8;
const AMBIGUOUS_TOP_VOICE_MATCH_TERMS = new Set([
  "bloom",
  "drafted",
  "harbor",
  "hub",
  "mount",
  "pops",
  "stage"
]);
const topVoiceXMissCache = new Map<string, { expiresAt: number; reason: string; checkedAt: string }>();
const liveEvidenceRecordsCache = new Map<string, { mtimeMs: number; size: number; records: LiveEvidenceRecord[] }>();
const UNSUPPORTED_REFRESH_PLATFORMS: Platform[] = [
  "github",
  "linkedin",
  "instagram",
  "product_hunt",
  "youtube",
  "rss",
  "web",
  "reddit",
  "hacker_news",
  "bilibili"
];

export async function runLiveSourceRefresh(options: LiveSourceRefreshOptions = {}): Promise<LiveSourceRefreshResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const runId = `live-refresh-${now.getTime()}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const targetedEvidencePath = options.targetedEvidencePath ?? join(rootDir, TARGETED_EVIDENCE_PATH);
  const requestedPlatforms = normalizeRequestedPlatforms(options.platforms);
  const topVoiceAudience = options.topVoices ?? "off";
  const stageLog: LiveRefreshStageLog[] = [];
  const log = (entry: Omit<LiveRefreshStageLog, "at">) => {
    stageLog.push({ ...entry, at: new Date().toISOString() });
  };

  log({
    stage: "task_created",
    platform: "all",
    message: `Live source refresh ${runId} started for ${requestedPlatforms.length ? requestedPlatforms.join(", ") : "all supported sources"}.`
  });

  for (const platform of UNSUPPORTED_REFRESH_PLATFORMS) {
    if (!shouldRefreshPlatform(platform, requestedPlatforms)) {
      continue;
    }
    log({
      stage: "skipped",
      platform,
      reason: "adapter_not_wired",
      message: `${formatPlatform(platform)} real-time adapter is not wired in this repository yet; existing snapshots remain the source of truth for this platform.`
    });
  }

  let acceptedEvidence: LiveEvidenceRecord[] = [];
  if (shouldRefreshPlatform("x", requestedPlatforms)) {
    const batchSlugs = options.batchSlugs ?? batchSlugExpansion(options.batchSlug);
    if (topVoiceAudience === "off") {
      const targets = await loadXTargets(rootDir, batchSlugs, log);
      log({
        stage: "parsed",
        platform: "x",
        count: targets.length,
        message: `Loaded ${targets.length} first-party X targets from YC batch snapshots.`
      });
      const filteredTargets = options.xTargetHandles?.length
        ? targets.filter((target) => options.xTargetHandles?.map(normalizeHandle).includes(target.handle))
        : targets;
      acceptedEvidence = await refreshXTargets(filteredTargets.slice(0, options.maxXTargets ?? DEFAULT_MAX_X_TARGETS), {
        fetchImpl,
        now,
        maxPostsPerTarget: options.maxPostsPerTarget ?? 1,
        concurrency: options.xConcurrency ?? DEFAULT_X_CONCURRENCY,
        requestTimeoutMs: options.xRequestTimeoutMs ?? DEFAULT_X_REQUEST_TIMEOUT_MS,
        log
      });
      acceptedEvidence.push(
        ...(await refreshDirectXSourceUrls(parseXStatusReferences(options.xSourceUrls ?? [], log), targets, {
          fetchImpl,
          now,
          requestTimeoutMs: options.xRequestTimeoutMs ?? DEFAULT_X_REQUEST_TIMEOUT_MS,
          log
        }))
      );
      if (filteredTargets.length > (options.maxXTargets ?? DEFAULT_MAX_X_TARGETS)) {
        log({
          stage: "skipped",
          platform: "x",
          count: filteredTargets.length - (options.maxXTargets ?? DEFAULT_MAX_X_TARGETS),
          reason: "target_cap",
          message: `Skipped ${filteredTargets.length - (options.maxXTargets ?? DEFAULT_MAX_X_TARGETS)} X targets because this refresh is capped to keep the UI responsive.`
        });
      }
    } else {
      const matchTargets = await loadCompanyMatchTargets(rootDir, batchSlugs, log);
      const targets = loadTopVoiceXTargets(topVoiceAudience, batchSlugs);
      log({
        stage: "parsed",
        platform: "x",
        count: targets.length,
        message: `Loaded ${targets.length} ${topVoiceAudience} X top-voice target(s) and ${matchTargets.length} company match target(s).`
      });
      const filteredTargets = options.xTargetHandles?.length
        ? targets.filter((target) => options.xTargetHandles?.map(normalizeHandle).includes(target.handle))
        : targets;
      acceptedEvidence = await refreshTopVoiceXTargets(
        filteredTargets.slice(0, options.maxTopVoiceXTargets ?? DEFAULT_MAX_TOP_VOICE_X_TARGETS),
        matchTargets,
        {
          fetchImpl,
          now,
          maxPostsPerTarget: options.maxPostsPerTarget ?? 2,
          concurrency: options.xConcurrency ?? DEFAULT_X_CONCURRENCY,
          requestTimeoutMs: options.xRequestTimeoutMs ?? DEFAULT_X_REQUEST_TIMEOUT_MS,
          log
        }
      );
      acceptedEvidence.push(
        ...(await refreshDirectTopVoiceXSourceUrls(
          parseXStatusReferences(options.xSourceUrls ?? [], log),
          targets,
          matchTargets,
          {
            fetchImpl,
            now,
            requestTimeoutMs: options.xRequestTimeoutMs ?? DEFAULT_X_REQUEST_TIMEOUT_MS,
            log
          }
        ))
      );
      if (filteredTargets.length > (options.maxTopVoiceXTargets ?? DEFAULT_MAX_TOP_VOICE_X_TARGETS)) {
        log({
          stage: "skipped",
          platform: "x",
          count: filteredTargets.length - (options.maxTopVoiceXTargets ?? DEFAULT_MAX_TOP_VOICE_X_TARGETS),
          reason: "top_voice_target_cap",
          message: `Skipped ${filteredTargets.length - (options.maxTopVoiceXTargets ?? DEFAULT_MAX_TOP_VOICE_X_TARGETS)} top-voice X targets because this refresh is capped to keep the UI responsive.`
        });
      }
    }
  }

  const uniqueAcceptedEvidence = mergeEvidence([], acceptedEvidence);
  if (uniqueAcceptedEvidence.length < acceptedEvidence.length) {
    log({
      stage: "skipped",
      platform: "all",
      count: acceptedEvidence.length - uniqueAcceptedEvidence.length,
      reason: "duplicate_accepted_live_evidence",
      message: `Collapsed ${acceptedEvidence.length - uniqueAcceptedEvidence.length} duplicate accepted live evidence row(s) before writing the refresh summary.`
    });
  }

  const existingSnapshot = await readEvidenceSnapshot(targetedEvidencePath, generatedAt);
  const mergedEvidence = mergeEvidence(existingSnapshot.evidence, uniqueAcceptedEvidence);
  const storedEvidence = mergedEvidence.filter((item) =>
    uniqueAcceptedEvidence.some((accepted) => evidenceKey(accepted) === evidenceKey(item))
  );

  if (options.write ?? true) {
    await writeEvidenceSnapshot(targetedEvidencePath, {
      source: {
        ...existingSnapshot.source,
        label: existingSnapshot.source.label ?? "Targeted long-run public evidence",
        fetchedAt: generatedAt,
        notes: [
          ...(existingSnapshot.source.notes ?? []),
          "Live manual refresh can append verified first-party X posts discovered from public profile HTML and FxTwitter/VxTwitter post JSON."
        ].filter((note, index, notes) => notes.indexOf(note) === index)
      },
      evidence: mergedEvidence,
      needsReview: existingSnapshot.needsReview ?? []
    });
    log({
      stage: "stored",
      platform: "all",
      count: storedEvidence.length,
      message: `Stored ${storedEvidence.length} accepted live evidence rows in targeted evidence snapshot.`
    });
  } else {
    log({
      stage: "skipped",
      platform: "all",
      count: uniqueAcceptedEvidence.length,
      reason: "write_disabled",
      message: "Skipped writing accepted live evidence rows because write=false."
    });
  }

  await writeStageLog(options.stageLogPath ?? join(rootDir, STAGE_LOG_PATH), stageLog);

  return {
    runId,
    generatedAt,
    acceptedEvidence: uniqueAcceptedEvidence,
    storedEvidence,
    stageLog,
    sourceSnapshots: {
      targetedEvidencePath,
      targetedEvidenceBefore: existingSnapshot.evidence.length,
      targetedEvidenceAfter: mergedEvidence.length
    },
    platformRows: countRowsByPlatform(uniqueAcceptedEvidence),
    failureReasonCounts: countReasons(stageLog)
  };
}

export async function loadLiveEvidenceRecords(
  rootDir = process.cwd(),
  options: { targetedEvidencePath?: string } = {}
): Promise<LiveEvidenceRecord[]> {
  const targetedEvidencePath = options.targetedEvidencePath ?? join(rootDir, TARGETED_EVIDENCE_PATH);
  const fileStat = await stat(targetedEvidencePath).catch(() => null);
  if (fileStat) {
    const cached = liveEvidenceRecordsCache.get(targetedEvidencePath);
    if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
      return cached.records;
    }
  }

  const snapshot = await readEvidenceSnapshot(targetedEvidencePath, new Date().toISOString());
  const liveEvidence = snapshot.evidence.filter((item) => isLiveRefreshEvidence(item));
  if (!liveEvidence.length) {
    rememberLiveEvidenceRecords(targetedEvidencePath, fileStat, []);
    return [];
  }

  const noopLog = () => {};
  const batchSlugs = [...new Set(liveEvidence.map((item) => liveEvidenceBatchSlug(item)).filter((slug): slug is string => Boolean(slug)))];
  const selectedBatchSlugs = batchSlugs.length ? batchSlugs : DEFAULT_BATCH_SLUGS;
  const [firstPartyTargets, companyMatchTargets] = await Promise.all([
    loadXTargets(rootDir, selectedBatchSlugs, noopLog),
    loadCompanyMatchTargets(rootDir, selectedBatchSlugs, noopLog)
  ]);
  const firstPartyTargetsByEntity = new Map(firstPartyTargets.map((target) => [target.entityId, target]));
  const topVoiceTargetsByHandle = new Map(
    (["yc_partners", "insiders"] as const)
      .flatMap((audienceId) => loadTopVoiceXTargets(audienceId, selectedBatchSlugs))
      .map((target) => [target.handle, target])
  );

  const validatedRecords = liveEvidence.filter((item) =>
    validatePersistedLiveEvidenceRecord(item, {
      firstPartyTargetsByEntity,
      topVoiceTargetsByHandle,
      companyMatchTargets
    }).ok
  );
  rememberLiveEvidenceRecords(targetedEvidencePath, fileStat, validatedRecords);
  return validatedRecords;
}

export function isLiveRefreshEvidence(item: Pick<LiveEvidenceRecord, "rawVisibleText" | "matchReason">): boolean {
  return /"source"\s*:\s*"live_x_profile"/.test(item.rawVisibleText ?? "") || /Live manual refresh/i.test(item.matchReason ?? "");
}

function rememberLiveEvidenceRecords(
  targetedEvidencePath: string,
  fileStat: { mtimeMs: number; size: number } | null,
  records: LiveEvidenceRecord[]
): void {
  if (!fileStat) {
    liveEvidenceRecordsCache.delete(targetedEvidencePath);
    return;
  }

  liveEvidenceRecordsCache.set(targetedEvidencePath, {
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    records
  });
  if (liveEvidenceRecordsCache.size > LIVE_EVIDENCE_RECORD_CACHE_LIMIT) {
    const oldestKey = liveEvidenceRecordsCache.keys().next().value;
    if (oldestKey) {
      liveEvidenceRecordsCache.delete(oldestKey);
    }
  }
}

function validatePersistedLiveEvidenceRecord(
  record: LiveEvidenceRecord,
  context: PersistedLiveEvidenceValidationContext
): { ok: true } | { ok: false; reason: string } {
  if (record.platform !== "x") {
    return { ok: false, reason: "unsupported_live_platform" };
  }
  if (record.linkStatus !== "verified" || record.review_state !== "verified") {
    return { ok: false, reason: "unverified_live_record" };
  }
  if (!record.platformPostId || !hasVisibleMetrics(record.metrics ?? {})) {
    return { ok: false, reason: "missing_post_or_metrics" };
  }

  const sourceReference = parseNativeXStatusReference(record.sourceUrl);
  if (!sourceReference || sourceReference.postId !== record.platformPostId) {
    return { ok: false, reason: "invalid_native_x_status_url" };
  }

  const parsedRaw = parseLiveRawVisibleText(record.rawVisibleText);
  if (!parsedRaw) {
    return { ok: false, reason: "raw_live_record_unparseable" };
  }
  const post = parsedRaw?.post;
  if (!post?.id || String(post.id) !== record.platformPostId) {
    return { ok: false, reason: "raw_post_id_mismatch" };
  }
  if (isRepostLikeXTweet(post)) {
    return { ok: false, reason: "non_native_x_repost" };
  }

  const authorHandle = normalizeHandle(post.author?.screen_name);
  if (!authorHandle || authorHandle !== sourceReference.handle) {
    return { ok: false, reason: "author_handle_mismatch" };
  }

  if (parsedRaw.source === "live_x_profile") {
    const target = context.firstPartyTargetsByEntity.get(record.entityId);
    if (!target || target.entityType !== record.entityType || target.companyName !== record.companyName) {
      return { ok: false, reason: "live_target_not_current" };
    }
    if (target.handle !== authorHandle || normalizeHandle(parsedRaw.profile?.targetHandle) !== target.handle) {
      return { ok: false, reason: "author_handle_mismatch" };
    }
    const validation = validateXEvidenceRecord(record, target, {
      allowDirectFounderAttribution: parsedRaw.profile?.directSource === true
    });
    return validation.ok ? { ok: true } : { ok: false, reason: validation.reason };
  }

  if (parsedRaw.source === "live_x_top_voice_profile") {
    if (record.entityType !== "company") {
      return { ok: false, reason: "top_voice_record_not_company_attached" };
    }
    const target = context.topVoiceTargetsByHandle.get(authorHandle);
    if (!target || normalizeHandle(parsedRaw.profile?.targetHandle) !== target.handle) {
      return { ok: false, reason: "top_voice_target_not_current" };
    }
    const matches = matchTopVoiceTweetToCompanies(post, context.companyMatchTargets);
    if (!matches.some((match) => match.entityId === record.entityId && match.companyName === record.companyName)) {
      return { ok: false, reason: "top_voice_post_missing_company_mention" };
    }
    return { ok: true };
  }

  return { ok: false, reason: "unsupported_live_source" };
}

function parseLiveRawVisibleText(rawVisibleText: string): ParsedLiveRawVisibleText | null {
  try {
    return JSON.parse(rawVisibleText) as ParsedLiveRawVisibleText;
  } catch {
    return null;
  }
}

function liveEvidenceBatchSlug(record: LiveEvidenceRecord): string | null {
  return parseLiveRawVisibleText(record.rawVisibleText)?.profile?.batchSlug ?? null;
}

async function loadXTargets(
  rootDir: string,
  batchSlugs: string[],
  log: (entry: Omit<LiveRefreshStageLog, "at">) => void
): Promise<XTarget[]> {
  const targets: XTarget[] = [];
  const snapshots = await Promise.all([
    readBatchSnapshot(join(rootDir, "src", "lib", "yc", "summer-2026-companies.json"), "S26", log),
    readBatchSnapshot(join(rootDir, "src", "lib", "yc", "spring-2026-companies.json"), "S2026", log)
  ]);
  const verifiedSocialOverrides = await readVerifiedSocialOverrides(rootDir, log);
  const selectedBatchSlugs = new Set(batchSlugs);

  for (const { slug, snapshot } of snapshots) {
    if (!selectedBatchSlugs.has(slug)) {
      continue;
    }
    for (const company of snapshot.companies) {
      const companyTarget = xTargetForCompany(slug, company);
      if (companyTarget) {
        targets.push(companyTarget);
      }
      for (const founder of company.founders ?? []) {
        const founderTarget = xTargetForFounder(slug, company, founder);
        if (founderTarget) {
          targets.push(founderTarget);
        }
      }
      const override = verifiedSocialOverrides[company.slug];
      const overrideCompanyTarget = xTargetForVerifiedCompany(slug, company, override);
      if (overrideCompanyTarget) {
        targets.push(overrideCompanyTarget);
      }
      for (const founder of override?.founders ?? []) {
        const founderTarget = xTargetForVerifiedFounder(slug, company, founder);
        if (founderTarget) {
          targets.push(founderTarget);
        }
      }
    }
  }

  if (selectedBatchSlugs.has("A16ZSR006")) {
    targets.push(...await loadA16zXTargets(rootDir, log));
  }

  return prioritizeXTargets(dedupeXTargets(targets));
}

async function readVerifiedSocialOverrides(
  rootDir: string,
  log: (entry: Omit<LiveRefreshStageLog, "at">) => void
): Promise<Record<string, VerifiedSocialOverride>> {
  try {
    return JSON.parse(await readFile(join(rootDir, VERIFIED_SOCIAL_OVERRIDES_PATH), "utf8")) as Record<
      string,
      VerifiedSocialOverride
    >;
  } catch (error) {
    log({
      stage: "failed",
      platform: "all",
      reason: "verified_social_overrides_read_failed",
      message: `Could not read verified social overrides: ${error instanceof Error ? error.message : "unknown error"}.`
    });
    return {};
  }
}

async function readBatchSnapshot(
  path: string,
  slug: string,
  log: (entry: Omit<LiveRefreshStageLog, "at">) => void
): Promise<{ slug: string; snapshot: RawSnapshot }> {
  try {
    const snapshot = JSON.parse(await readFile(path, "utf8")) as RawSnapshot;
    return { slug, snapshot };
  } catch (error) {
    log({
      stage: "failed",
      platform: "all",
      reason: "batch_snapshot_read_failed",
      message: `Could not read ${slug} batch snapshot: ${error instanceof Error ? error.message : "unknown error"}.`
    });
    return { slug, snapshot: { companies: [] } };
  }
}

async function readA16zSocialAccountSnapshot(
  rootDir: string,
  log: (entry: Omit<LiveRefreshStageLog, "at">) => void
): Promise<A16zSocialAccountSnapshot> {
  const snapshotPath = join(rootDir, A16Z_SOCIAL_ACCOUNTS_PATH);
  try {
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as A16zSocialAccountSnapshot;
    return { companies: Array.isArray(snapshot.companies) ? snapshot.companies : [] };
  } catch (error) {
    log({
      stage: "failed",
      platform: "all",
      reason: "a16z_social_account_snapshot_read_failed",
      message: `Could not read A16Z social account snapshot: ${error instanceof Error ? error.message : "unknown error"}.`
    });
    return { companies: [] };
  }
}

async function loadA16zXTargets(
  rootDir: string,
  log: (entry: Omit<LiveRefreshStageLog, "at">) => void
): Promise<XTarget[]> {
  const snapshot = await readA16zSocialAccountSnapshot(rootDir, log);
  const targets: XTarget[] = [];

  for (const company of snapshot.companies ?? []) {
    const companySlug = slugify(company.companySlug ?? company.companyName);
    const companyTarget = a16zXTargetForCompany(companySlug, company);
    if (companyTarget) {
      targets.push(companyTarget);
    }
    for (const founder of company.founders ?? []) {
      const founderTarget = a16zXTargetForFounder(companySlug, company, founder);
      if (founderTarget) {
        targets.push(founderTarget);
      }
    }
  }

  return targets;
}

async function loadA16zCompanyMatchTargets(
  rootDir: string,
  log: (entry: Omit<LiveRefreshStageLog, "at">) => void
): Promise<CompanyMatchTarget[]> {
  const snapshot = await readA16zSocialAccountSnapshot(rootDir, log);
  return (snapshot.companies ?? []).map((company) => {
    const companySlug = slugify(company.companySlug ?? company.companyName);
    const terms = [
      company.companyName,
      companySlug,
      ...Object.values(company.accounts ?? []).map((account) => genericHandleFromUrl(account.url) ?? account.handle ?? null),
      ...(company.founders ?? []).map((founder) => founder.name),
      ...(company.founders ?? []).flatMap((founder) =>
        (founder.accounts ?? []).map((account) => genericHandleFromUrl(account.url) ?? account.handle ?? null)
      )
    ]
      .filter((value): value is string => Boolean(value))
      .map(normalizeSearchText)
      .filter((term) => term.length >= 4 && !isAmbiguousTopVoiceMatchTerm(term));

    return {
      batchSlug: "A16ZSR006",
      entityId: a16zCompanyIdFromSlug(companySlug),
      companyName: company.companyName,
      companySlug,
      companyWebsiteUrl: null,
      terms: [...new Set(terms)]
    };
  });
}

function a16zXTargetForCompany(companySlug: string, company: A16zSocialAccountCompany): XTarget | null {
  const account = (company.accounts ?? []).find((candidate) => candidate.platform === "x" && candidate.review_state !== "rejected");
  const handle = normalizeHandle(account?.handle ?? handleFromUrl(account?.url));
  if (!account?.url || !handle) {
    return null;
  }

  return {
    platform: "x",
    batchSlug: "A16ZSR006",
    entityType: "company",
    entityId: a16zCompanyIdFromSlug(companySlug),
    companyName: company.companyName,
    companySlug,
    companyWebsiteUrl: null,
    entityName: company.companyName,
    accountUrl: account.url,
    handle
  };
}

function a16zXTargetForFounder(
  companySlug: string,
  company: A16zSocialAccountCompany,
  founder: A16zSocialAccountFounder
): XTarget | null {
  const account = (founder.accounts ?? []).find((candidate) => candidate.platform === "x" && candidate.review_state !== "rejected");
  const handle = normalizeHandle(account?.handle ?? handleFromUrl(account?.url));
  if (!account?.url || !handle) {
    return null;
  }

  return {
    platform: "x",
    batchSlug: "A16ZSR006",
    entityType: "founder",
    entityId: a16zFounderId(companySlug, founder.name),
    companyName: company.companyName,
    companySlug,
    companyWebsiteUrl: null,
    entityName: founder.name,
    accountUrl: account.url,
    handle
  };
}

function a16zCompanyIdFromSlug(slug: string): string {
  return `a16z-speedrun-006-${slug}`;
}

function a16zFounderId(companySlug: string, name: string): string {
  return `${a16zCompanyIdFromSlug(companySlug)}-founder-${slugify(name)}`;
}

function xTargetForCompany(batchSlug: string, company: RawCompany): XTarget | null {
  const accountUrl = company.socialLinks?.x;
  const handle = handleFromUrl(accountUrl);
  if (!accountUrl || !handle) {
    return null;
  }

  return {
    platform: "x",
    batchSlug,
    entityType: "company",
    entityId: `company-${company.slug}`,
    companyName: company.name,
    companySlug: company.slug,
    companyWebsiteUrl: company.websiteUrl ?? null,
    entityName: company.name,
    accountUrl,
    handle
  };
}

function xTargetForFounder(batchSlug: string, company: RawCompany, founder: RawFounder): XTarget | null {
  const accountUrl = founder.socialLinks?.x;
  const handle = handleFromUrl(accountUrl);
  if (!accountUrl || !handle) {
    return null;
  }

  return {
    platform: "x",
    batchSlug,
    entityType: "founder",
    entityId: `founder-${company.slug}-${slugify(founder.name)}-${founder.id}`,
    companyName: company.name,
    companySlug: company.slug,
    companyWebsiteUrl: company.websiteUrl ?? null,
    entityName: founder.name,
    accountUrl,
    handle
  };
}

function xTargetForVerifiedCompany(
  batchSlug: string,
  company: RawCompany,
  override: VerifiedSocialOverride | undefined
): XTarget | null {
  const accountUrl = override?.companySocialLinks?.x;
  const handle = handleFromUrl(accountUrl);
  if (!accountUrl || !handle) {
    return null;
  }

  return {
    platform: "x",
    batchSlug,
    entityType: "company",
    entityId: `company-${company.slug}`,
    companyName: company.name,
    companySlug: company.slug,
    companyWebsiteUrl: company.websiteUrl ?? null,
    entityName: company.name,
    accountUrl,
    handle
  };
}

function xTargetForVerifiedFounder(
  batchSlug: string,
  company: RawCompany,
  founder: VerifiedFounderOverride
): XTarget | null {
  const accountUrl = founder.socialLinks?.x;
  const handle = handleFromUrl(accountUrl);
  if (!accountUrl || !handle) {
    return null;
  }

  return {
    platform: "x",
    batchSlug,
    entityType: "founder",
    entityId: `founder-${company.slug}-${slugify(founder.name)}-${founder.id}`,
    companyName: company.name,
    companySlug: company.slug,
    companyWebsiteUrl: company.websiteUrl ?? null,
    entityName: founder.name,
    accountUrl,
    handle
  };
}

function dedupeXTargets(targets: XTarget[]): XTarget[] {
  return [...new Map(targets.map((target) => [`${target.batchSlug}:${target.entityId}:${target.handle}`, target])).values()];
}

function prioritizeXTargets(targets: XTarget[]): XTarget[] {
  const companyTargets = targets.filter((target) => target.entityType === "company");
  const founderTargets = targets.filter((target) => target.entityType === "founder");
  return [...interleaveByBatch(companyTargets), ...interleaveByBatch(founderTargets)];
}

function interleaveByBatch(targets: XTarget[]): XTarget[] {
  const byBatch = new Map<string, XTarget[]>();
  for (const target of targets) {
    byBatch.set(target.batchSlug, [...(byBatch.get(target.batchSlug) ?? []), target]);
  }
  const batches = [...byBatch.keys()].sort();
  const output: XTarget[] = [];
  let index = 0;
  while (output.length < targets.length) {
    for (const batch of batches) {
      const target = byBatch.get(batch)?.[index];
      if (target) {
        output.push(target);
      }
    }
    index += 1;
  }
  return output;
}

async function loadCompanyMatchTargets(
  rootDir: string,
  batchSlugs: string[],
  log: (entry: Omit<LiveRefreshStageLog, "at">) => void
): Promise<CompanyMatchTarget[]> {
  const targets: CompanyMatchTarget[] = [];
  const snapshots = await Promise.all([
    readBatchSnapshot(join(rootDir, "src", "lib", "yc", "summer-2026-companies.json"), "S26", log),
    readBatchSnapshot(join(rootDir, "src", "lib", "yc", "spring-2026-companies.json"), "S2026", log)
  ]);
  const selectedBatchSlugs = new Set(batchSlugs);

  for (const { slug, snapshot } of snapshots) {
    if (!selectedBatchSlugs.has(slug)) {
      continue;
    }
    for (const company of snapshot.companies) {
      targets.push(companyMatchTargetFor(slug, company));
    }
  }

  if (selectedBatchSlugs.has("A16ZSR006")) {
    targets.push(...await loadA16zCompanyMatchTargets(rootDir, log));
  }

  return targets;
}

function companyMatchTargetFor(batchSlug: string, company: RawCompany): CompanyMatchTarget {
  const terms = [
    company.name,
    company.slug,
    company.websiteUrl ? domainToken(company.websiteUrl) : null,
    ...Object.values(company.socialLinks ?? {}).map(genericHandleFromUrl),
    ...(company.founders ?? []).map((founder) => founder.name),
    ...(company.founders ?? []).flatMap((founder) => Object.values(founder.socialLinks ?? {}).map(genericHandleFromUrl))
  ]
    .filter((value): value is string => Boolean(value))
    .map(normalizeSearchText)
    .filter((term) => term.length >= 4 && !isAmbiguousTopVoiceMatchTerm(term));

  return {
    batchSlug,
    entityId: `company-${company.slug}`,
    companyName: company.name,
    companySlug: company.slug,
    companyWebsiteUrl: company.websiteUrl ?? null,
    terms: [...new Set(terms)]
  };
}

function loadTopVoiceXTargets(audienceId: TopVoiceAudienceId, batchSlugs: string[]): TopVoiceXTarget[] {
  const audience = resolveTopVoiceAudience(audienceId);
  return audience.members.flatMap((member) =>
    (member.handles.x ?? []).map((handle) => ({
      platform: "x" as const,
      batchSlug: batchSlugs.join(","),
      member,
      handle: normalizeHandle(handle)
    }))
  );
}

function topVoiceXMissCacheKey(target: TopVoiceXTarget, matchTargets: CompanyMatchTarget[]): string {
  return [
    target.batchSlug,
    target.member.personId,
    target.handle,
    matchTargets.length
  ].join(":");
}

function rememberTopVoiceXMiss(key: string, reason: string, now: Date): void {
  topVoiceXMissCache.set(key, {
    expiresAt: now.getTime() + TOP_VOICE_X_MISS_CACHE_TTL_MS,
    reason,
    checkedAt: now.toISOString()
  });
}

function mostCommonReason(reasons: string[]): string | null {
  if (!reasons.length) {
    return null;
  }
  const counts = reasons.reduce<Record<string, number>>((accumulator, reason) => {
    accumulator[reason] = (accumulator[reason] ?? 0) + 1;
    return accumulator;
  }, {});
  return Object.entries(counts).sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
}

async function refreshTopVoiceXTargets(
  targets: TopVoiceXTarget[],
  matchTargets: CompanyMatchTarget[],
  options: {
    fetchImpl: typeof fetch;
    now: Date;
    maxPostsPerTarget: number;
    concurrency: number;
    requestTimeoutMs: number;
    log: (entry: Omit<LiveRefreshStageLog, "at">) => void;
  }
): Promise<LiveEvidenceRecord[]> {
  const accepted: LiveEvidenceRecord[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < targets.length) {
      const target = targets[nextIndex];
      nextIndex += 1;
      if (!target) {
        continue;
      }
      const records = await refreshSingleTopVoiceXTarget(target, matchTargets, options);
      accepted.push(...records);
    }
  }

  await Promise.all(Array.from({ length: Math.min(options.concurrency, targets.length) }, () => worker()));
  return accepted;
}

async function refreshSingleTopVoiceXTarget(
  target: TopVoiceXTarget,
  matchTargets: CompanyMatchTarget[],
  options: {
    fetchImpl: typeof fetch;
    now: Date;
    maxPostsPerTarget: number;
    requestTimeoutMs: number;
    log: (entry: Omit<LiveRefreshStageLog, "at">) => void;
  }
): Promise<LiveEvidenceRecord[]> {
  const profileUrl = `https://x.com/${target.handle}`;
  const missCacheKey = topVoiceXMissCacheKey(target, matchTargets);
  const cachedMiss = topVoiceXMissCache.get(missCacheKey);
  if (cachedMiss && cachedMiss.expiresAt > options.now.getTime()) {
    options.log({
      stage: "skipped",
      platform: "x",
      target: target.handle,
      sourceUrl: profileUrl,
      reason: "top_voice_recent_no_match",
      message: `Skipped ${target.member.displayName} (@${target.handle}) because a recent scan at ${cachedMiss.checkedAt} found no matching selected-batch company mention (${cachedMiss.reason}).`
    });
    return [];
  }
  if (cachedMiss) {
    topVoiceXMissCache.delete(missCacheKey);
  }

  options.log({
    stage: "request_sent",
    platform: "x",
    target: target.handle,
    sourceUrl: profileUrl,
    message: `Fetching public X top-voice profile HTML for ${target.member.displayName} (@${target.handle}).`
  });

  const profile = await fetchText(profileUrl, options.fetchImpl, options.requestTimeoutMs);
  if (!profile.ok) {
    options.log({
      stage: "failed",
      platform: "x",
      target: target.handle,
      sourceUrl: profileUrl,
      reason: profile.reason,
      message: `X top-voice profile fetch failed for ${target.handle}: ${profile.reason}.`
    });
    return [];
  }

  const postIds = extractStatusIds(profile.text, target.handle).slice(0, options.maxPostsPerTarget);
  options.log({
    stage: "received",
    platform: "x",
    target: target.handle,
    sourceUrl: profileUrl,
    count: postIds.length,
    message: `Public X top-voice profile for ${target.handle} exposed ${postIds.length} candidate status id(s).`
  });
  if (!postIds.length) {
    options.log({
      stage: "dropped",
      platform: "x",
      target: target.handle,
      sourceUrl: profileUrl,
      reason: "no_status_ids",
      message: `No post-level X status URLs were visible on ${target.handle}'s public top-voice profile HTML.`
    });
    rememberTopVoiceXMiss(missCacheKey, "no_status_ids", options.now);
    return [];
  }

  const accepted: LiveEvidenceRecord[] = [];
  const missReasons: string[] = [];
  for (const postId of postIds) {
    const tweetResult = await fetchFxTweet(target.handle, postId, options.fetchImpl, options.requestTimeoutMs);
    if (!tweetResult.ok) {
      options.log({
        stage: "failed",
        platform: "x",
        target: target.handle,
        sourceUrl: `https://x.com/${target.handle}/status/${postId}`,
        reason: tweetResult.reason,
        message: `Could not resolve top-voice X status ${postId} for ${target.handle}: ${tweetResult.reason}.`
      });
      missReasons.push(tweetResult.reason);
      continue;
    }

    const authorHandle = normalizeHandle(tweetResult.tweet.author?.screen_name ?? target.handle);
    if (authorHandle !== target.handle) {
      options.log({
        stage: "dropped",
        platform: "x",
        target: target.handle,
        sourceUrl: `https://x.com/${target.handle}/status/${postId}`,
        reason: "author_handle_mismatch",
        message: `Dropped top-voice X status ${postId} because @${authorHandle || "unknown"} did not match @${target.handle}.`
      });
      missReasons.push("author_handle_mismatch");
      continue;
    }

    if (isRepostLikeXTweet(tweetResult.tweet)) {
      options.log({
        stage: "dropped",
        platform: "x",
        target: target.handle,
        sourceUrl: `https://x.com/${target.handle}/status/${postId}`,
        reason: "non_native_x_repost",
        message: `Dropped top-voice X status ${postId} because it is a retweet/repost rather than a native post from ${target.member.displayName}.`
      });
      missReasons.push("non_native_x_repost");
      continue;
    }

    const metrics = xTweetMetrics(tweetResult.tweet);
    if (!hasVisibleMetrics(metrics)) {
      options.log({
        stage: "dropped",
        platform: "x",
        target: target.handle,
        sourceUrl: `https://x.com/${target.handle}/status/${postId}`,
        reason: "no_visible_metrics",
        message: `Dropped top-voice X status ${postId} because no positive public metrics were visible.`
      });
      missReasons.push("no_visible_metrics");
      continue;
    }

    const matches = matchTopVoiceTweetToCompanies(tweetResult.tweet, matchTargets);
    if (!matches.length) {
      options.log({
        stage: "dropped",
        platform: "x",
        target: target.handle,
        sourceUrl: `https://x.com/${target.handle}/status/${postId}`,
        reason: "top_voice_post_missing_company_mention",
        message: `Dropped top-voice X status ${postId} because it did not visibly mention a company, founder, handle, or domain in the selected batch.`
      });
      missReasons.push("top_voice_post_missing_company_mention");
      continue;
    }

    for (const match of matches) {
      const record = topVoiceTweetToEvidenceRecord(target, match, tweetResult.tweet, options.now);
      options.log({
        stage: "accepted",
        platform: "x",
        target: target.handle,
        companyName: match.companyName,
        entityId: match.entityId,
        sourceUrl: record.sourceUrl,
        count: computeVisibleMetricCount(record.metrics),
        message: `Accepted top-voice X post ${record.platformPostId} from ${target.member.displayName} for ${match.companyName}: ${formatMetrics(record.metrics)}.`
      });
      accepted.push(record);
    }
  }

  if (!accepted.length) {
    rememberTopVoiceXMiss(missCacheKey, mostCommonReason(missReasons) ?? "no_accepted_top_voice_posts", options.now);
  } else {
    topVoiceXMissCache.delete(missCacheKey);
  }

  return accepted;
}

async function refreshDirectXSourceUrls(
  references: XStatusReference[],
  targets: XTarget[],
  options: {
    fetchImpl: typeof fetch;
    now: Date;
    requestTimeoutMs: number;
    log: (entry: Omit<LiveRefreshStageLog, "at">) => void;
  }
): Promise<LiveEvidenceRecord[]> {
  if (!references.length) {
    return [];
  }

  const targetsByHandle = new Map(targets.map((target) => [target.handle, target]));
  const accepted: LiveEvidenceRecord[] = [];

  for (const reference of references) {
    const target = targetsByHandle.get(reference.handle);
    if (!target) {
      options.log({
        stage: "dropped",
        platform: "x",
        target: reference.handle,
        sourceUrl: reference.sourceUrl,
        reason: "direct_x_url_not_batch_target",
        message: `Dropped direct X status ${reference.sourceUrl} because @${reference.handle} is not a first-party X account in the selected batch.`
      });
      continue;
    }

    options.log({
      stage: "request_sent",
      platform: "x",
      target: target.handle,
      companyName: target.companyName,
      entityId: target.entityId,
      sourceUrl: reference.sourceUrl,
      message: `Fetching direct X status ${reference.postId} for ${target.companyName} from @${target.handle}.`
    });
    const tweetResult = await fetchFxTweet(reference.handle, reference.postId, options.fetchImpl, options.requestTimeoutMs);
    if (!tweetResult.ok) {
      options.log({
        stage: "failed",
        platform: "x",
        target: target.handle,
        companyName: target.companyName,
        entityId: target.entityId,
        sourceUrl: reference.sourceUrl,
        reason: tweetResult.reason,
        message: `Could not resolve direct X status ${reference.postId} for @${target.handle}: ${tweetResult.reason}.`
      });
      continue;
    }

    const record = xTweetToEvidenceRecord(target, tweetResult.tweet, options.now, { directSource: true });
    const validation = validateXEvidenceRecord(record, target, { allowDirectFounderAttribution: true });
    if (!validation.ok) {
      options.log({
        stage: "dropped",
        platform: "x",
        target: target.handle,
        companyName: target.companyName,
        entityId: target.entityId,
        sourceUrl: record.sourceUrl,
        reason: validation.reason,
        message: validation.message
      });
      continue;
    }

    options.log({
      stage: "accepted",
      platform: "x",
      target: target.handle,
      companyName: target.companyName,
      entityId: target.entityId,
      sourceUrl: record.sourceUrl,
      count: computeVisibleMetricCount(record.metrics),
      message: `Accepted direct X post ${record.platformPostId} for ${target.companyName}: ${formatMetrics(record.metrics)}.`
    });
    accepted.push(record);
  }

  return accepted;
}

async function refreshDirectTopVoiceXSourceUrls(
  references: XStatusReference[],
  targets: TopVoiceXTarget[],
  matchTargets: CompanyMatchTarget[],
  options: {
    fetchImpl: typeof fetch;
    now: Date;
    requestTimeoutMs: number;
    log: (entry: Omit<LiveRefreshStageLog, "at">) => void;
  }
): Promise<LiveEvidenceRecord[]> {
  if (!references.length) {
    return [];
  }

  const targetsByHandle = new Map(targets.map((target) => [target.handle, target]));
  const accepted: LiveEvidenceRecord[] = [];

  for (const reference of references) {
    const target = targetsByHandle.get(reference.handle);
    if (!target) {
      options.log({
        stage: "dropped",
        platform: "x",
        target: reference.handle,
        sourceUrl: reference.sourceUrl,
        reason: "direct_x_url_not_top_voice_target",
        message: `Dropped direct X status ${reference.sourceUrl} because @${reference.handle} is not in the selected top-voice audience.`
      });
      continue;
    }

    options.log({
      stage: "request_sent",
      platform: "x",
      target: target.handle,
      sourceUrl: reference.sourceUrl,
      message: `Fetching direct top-voice X status ${reference.postId} from ${target.member.displayName} (@${target.handle}).`
    });
    const tweetResult = await fetchFxTweet(reference.handle, reference.postId, options.fetchImpl, options.requestTimeoutMs);
    if (!tweetResult.ok) {
      options.log({
        stage: "failed",
        platform: "x",
        target: target.handle,
        sourceUrl: reference.sourceUrl,
        reason: tweetResult.reason,
        message: `Could not resolve direct top-voice X status ${reference.postId} for @${target.handle}: ${tweetResult.reason}.`
      });
      continue;
    }

    const authorHandle = normalizeHandle(tweetResult.tweet.author?.screen_name ?? target.handle);
    if (authorHandle !== target.handle) {
      options.log({
        stage: "dropped",
        platform: "x",
        target: target.handle,
        sourceUrl: reference.sourceUrl,
        reason: "author_handle_mismatch",
        message: `Dropped direct top-voice X status ${reference.postId} because @${authorHandle || "unknown"} did not match @${target.handle}.`
      });
      continue;
    }

    if (isRepostLikeXTweet(tweetResult.tweet)) {
      options.log({
        stage: "dropped",
        platform: "x",
        target: target.handle,
        sourceUrl: reference.sourceUrl,
        reason: "non_native_x_repost",
        message: `Dropped direct top-voice X status ${reference.postId} because it is a retweet/repost rather than a native post from ${target.member.displayName}.`
      });
      continue;
    }

    const metrics = xTweetMetrics(tweetResult.tweet);
    if (!hasVisibleMetrics(metrics)) {
      options.log({
        stage: "dropped",
        platform: "x",
        target: target.handle,
        sourceUrl: reference.sourceUrl,
        reason: "no_visible_metrics",
        message: `Dropped direct top-voice X status ${reference.postId} because no positive public metrics were visible.`
      });
      continue;
    }

    const matches = matchTopVoiceTweetToCompanies(tweetResult.tweet, matchTargets);
    if (!matches.length) {
      options.log({
        stage: "dropped",
        platform: "x",
        target: target.handle,
        sourceUrl: reference.sourceUrl,
        reason: "top_voice_post_missing_company_mention",
        message: `Dropped direct top-voice X status ${reference.postId} because it did not visibly mention a company, founder, handle, or domain in the selected batch.`
      });
      continue;
    }

    for (const match of matches) {
      const record = topVoiceTweetToEvidenceRecord(target, match, tweetResult.tweet, options.now);
      options.log({
        stage: "accepted",
        platform: "x",
        target: target.handle,
        companyName: match.companyName,
        entityId: match.entityId,
        sourceUrl: record.sourceUrl,
        count: computeVisibleMetricCount(record.metrics),
        message: `Accepted direct top-voice X post ${record.platformPostId} from ${target.member.displayName} for ${match.companyName}: ${formatMetrics(record.metrics)}.`
      });
      accepted.push(record);
    }
  }

  return accepted;
}

async function refreshXTargets(
  targets: XTarget[],
  options: {
    fetchImpl: typeof fetch;
    now: Date;
    maxPostsPerTarget: number;
    concurrency: number;
    requestTimeoutMs: number;
    log: (entry: Omit<LiveRefreshStageLog, "at">) => void;
  }
): Promise<LiveEvidenceRecord[]> {
  const accepted: LiveEvidenceRecord[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < targets.length) {
      const target = targets[nextIndex];
      nextIndex += 1;
      if (!target) {
        continue;
      }
      const records = await refreshSingleXTarget(target, options);
      accepted.push(...records);
    }
  }

  await Promise.all(Array.from({ length: Math.min(options.concurrency, targets.length) }, () => worker()));
  return accepted;
}

async function refreshSingleXTarget(
  target: XTarget,
  options: {
    fetchImpl: typeof fetch;
    now: Date;
    maxPostsPerTarget: number;
    requestTimeoutMs: number;
    log: (entry: Omit<LiveRefreshStageLog, "at">) => void;
  }
): Promise<LiveEvidenceRecord[]> {
  const profileUrl = `https://x.com/${target.handle}`;
  options.log({
    stage: "request_sent",
    platform: "x",
    target: target.handle,
    companyName: target.companyName,
    entityId: target.entityId,
    sourceUrl: profileUrl,
    message: `Fetching public X profile HTML for ${target.handle}.`
  });

  const profile = await fetchText(profileUrl, options.fetchImpl, options.requestTimeoutMs);
  if (!profile.ok) {
    options.log({
      stage: "failed",
      platform: "x",
      target: target.handle,
      companyName: target.companyName,
      entityId: target.entityId,
      sourceUrl: profileUrl,
      reason: profile.reason,
      message: `X profile fetch failed for ${target.handle}: ${profile.reason}.`
    });
    return [];
  }

  const postIds = extractStatusIds(profile.text, target.handle).slice(0, options.maxPostsPerTarget);
  options.log({
    stage: "received",
    platform: "x",
    target: target.handle,
    companyName: target.companyName,
    entityId: target.entityId,
    sourceUrl: profileUrl,
    count: postIds.length,
    message: `Public X profile for ${target.handle} exposed ${postIds.length} candidate status id(s).`
  });
  if (!postIds.length) {
    options.log({
      stage: "dropped",
      platform: "x",
      target: target.handle,
      companyName: target.companyName,
      entityId: target.entityId,
      sourceUrl: profileUrl,
      reason: "no_status_ids",
      message: `No post-level X status URLs were visible on ${target.handle}'s public profile HTML.`
    });
    return [];
  }

  const accepted: LiveEvidenceRecord[] = [];
  for (const postId of postIds) {
    const tweetResult = await fetchFxTweet(target.handle, postId, options.fetchImpl, options.requestTimeoutMs);
    if (!tweetResult.ok) {
      options.log({
        stage: "failed",
        platform: "x",
        target: target.handle,
        companyName: target.companyName,
        entityId: target.entityId,
        sourceUrl: `https://x.com/${target.handle}/status/${postId}`,
        reason: tweetResult.reason,
        message: `Could not resolve X status ${postId} for ${target.handle}: ${tweetResult.reason}.`
      });
      continue;
    }

    const record = xTweetToEvidenceRecord(target, tweetResult.tweet, options.now);
    const validation = validateXEvidenceRecord(record, target);
    if (!validation.ok) {
      options.log({
        stage: "dropped",
        platform: "x",
        target: target.handle,
        companyName: target.companyName,
        entityId: target.entityId,
        sourceUrl: record.sourceUrl,
        reason: validation.reason,
        message: validation.message
      });
      continue;
    }

    options.log({
      stage: "accepted",
      platform: "x",
      target: target.handle,
      companyName: target.companyName,
      entityId: target.entityId,
      sourceUrl: record.sourceUrl,
      count: computeVisibleMetricCount(record.metrics),
      message: `Accepted X post ${record.platformPostId} for ${target.companyName}: ${formatMetrics(record.metrics)}.`
    });
    accepted.push(record);
  }

  return accepted;
}

function xTweetToEvidenceRecord(
  target: XTarget,
  tweet: FxTweet,
  now: Date,
  options: { directSource?: boolean } = {}
): LiveEvidenceRecord {
  const postId = String(tweet.id ?? "");
  const authorHandle = normalizeHandle(tweet.author?.screen_name ?? target.handle);
  const sourceUrl = tweet.url ?? `https://x.com/${authorHandle || target.handle}/status/${postId}`;
  const mediaItems = tweet.media?.all ?? [];
  const mediaUrls = mediaItems.map((item) => item.url).filter((url): url is string => Boolean(url));
  const thumbnailUrl = mediaItems.find((item) => item.thumbnail_url)?.thumbnail_url ?? null;
  const metrics = xTweetMetrics(tweet);
  const postedAt = tweet.created_timestamp
    ? new Date(tweet.created_timestamp * 1000).toISOString()
    : parseDate(tweet.created_at)?.toISOString() ?? now.toISOString();
  const text = String(tweet.text ?? "").trim() || `X post by @${authorHandle || target.handle}`;
  const rawVisibleText = JSON.stringify({
    source: "live_x_profile",
    profile: {
      targetHandle: target.handle,
      accountUrl: target.accountUrl,
      batchSlug: target.batchSlug,
      directSource: options.directSource === true
    },
    post: tweet,
    counts: metrics
  });
  const contributionScore = provisionalContributionScore("x", metrics);

  return {
    id: `live-x-${target.entityType}-${slugify(target.companyName)}-${postId}`,
    entityType: target.entityType,
    entityId: target.entityId,
    companyName: target.companyName,
    platform: "x",
    title: truncateText(text, 140),
    sourceUrl,
    platformPostId: postId,
    text,
    thumbnailUrl,
    thumbnailSource: thumbnailUrl ? "x_media" : null,
    mediaUrl: mediaUrls[0] ?? null,
    mediaUrls,
    media_urls: mediaUrls,
    media_posters: thumbnailUrl ? [thumbnailUrl] : [],
    linkStatus: "verified",
    linkCheckedAt: now.toISOString(),
    rawVisibleText,
    postedAt,
    metrics,
    contributionScore,
    review_state: "verified",
    matchReason:
      target.entityType === "company"
        ? `Live manual refresh verified a native X post from official @${target.handle} for ${target.companyName}. Visible metrics were available from public post JSON.`
        : options.directSource
          ? `Live manual refresh verified an explicitly supplied native X post from verified founder @${target.handle} for ${target.companyName}. Visible metrics were available from public post JSON.`
        : `Live manual refresh verified a native X post from founder @${target.handle} mentioning ${target.companyName}. Visible metrics were available from public post JSON.`,
    first_seen_at: now.toISOString(),
    last_checked_at: now.toISOString(),
    last_updated_at: postedAt
  };
}

function topVoiceTweetToEvidenceRecord(
  target: TopVoiceXTarget,
  match: CompanyMatchTarget,
  tweet: FxTweet,
  now: Date
): LiveEvidenceRecord {
  const postId = String(tweet.id ?? "");
  const authorHandle = normalizeHandle(tweet.author?.screen_name ?? target.handle);
  const sourceUrl = tweet.url ?? `https://x.com/${authorHandle || target.handle}/status/${postId}`;
  const mediaItems = tweet.media?.all ?? [];
  const mediaUrls = mediaItems.map((item) => item.url).filter((url): url is string => Boolean(url));
  const thumbnailUrl = mediaItems.find((item) => item.thumbnail_url)?.thumbnail_url ?? null;
  const metrics = xTweetMetrics(tweet);
  const postedAt = tweet.created_timestamp
    ? new Date(tweet.created_timestamp * 1000).toISOString()
    : parseDate(tweet.created_at)?.toISOString() ?? now.toISOString();
  const text = String(tweet.text ?? "").trim() || `X post by @${authorHandle || target.handle}`;
  const rawVisibleText = JSON.stringify({
    source: "live_x_top_voice_profile",
    profile: {
      topVoiceMemberId: target.member.personId,
      topVoiceDisplayName: target.member.displayName,
      targetHandle: target.handle,
      batchSlug: match.batchSlug
    },
    post: tweet,
    counts: metrics
  });
  const contributionScore = provisionalContributionScore("x", metrics);

  return {
    id: `live-x-top-voice-${target.member.personId}-${slugify(match.companyName)}-${postId}`,
    entityType: "company",
    entityId: match.entityId,
    companyName: match.companyName,
    platform: "x",
    title: truncateText(text, 140),
    sourceUrl,
    platformPostId: postId,
    text,
    thumbnailUrl,
    thumbnailSource: thumbnailUrl ? "x_media" : null,
    mediaUrl: mediaUrls[0] ?? null,
    mediaUrls,
    media_urls: mediaUrls,
    media_posters: thumbnailUrl ? [thumbnailUrl] : [],
    linkStatus: "verified",
    linkCheckedAt: now.toISOString(),
    rawVisibleText,
    postedAt,
    metrics,
    contributionScore,
    review_state: "verified",
    matchReason: `Live manual refresh verified a native X post from top voice ${target.member.displayName} (@${target.handle}) mentioning ${match.companyName}. Visible metrics were available from public post JSON.`,
    first_seen_at: now.toISOString(),
    last_checked_at: now.toISOString(),
    last_updated_at: postedAt
  };
}

function xTweetMetrics(tweet: FxTweet): EvidenceMetrics {
  return {
    views: finiteNumber(tweet.views),
    likes: finiteNumber(tweet.likes),
    comments: finiteNumber(tweet.replies),
    replies: finiteNumber(tweet.replies),
    reposts: finiteNumber(tweet.retweets),
    quotes: finiteNumber(tweet.quotes),
    saves: finiteNumber(tweet.bookmarks)
  };
}

function matchTopVoiceTweetToCompanies(tweet: FxTweet, targets: CompanyMatchTarget[]): CompanyMatchTarget[] {
  const haystack = normalizeSearchText(String(tweet.text ?? ""));
  if (!haystack) {
    return [];
  }

  return targets.filter((target) => target.terms.some((term) => containsSearchTerm(haystack, term)));
}

function validateXEvidenceRecord(
  record: LiveEvidenceRecord,
  target: XTarget,
  options: { allowDirectFounderAttribution?: boolean } = {}
): { ok: true } | { ok: false; reason: string; message: string } {
  if (!record.platformPostId) {
    return { ok: false, reason: "no_post_id", message: "Dropped X row because no post id was available." };
  }
  if (!hasVisibleMetrics(record.metrics)) {
    return {
      ok: false,
      reason: "no_visible_metrics",
      message: `Dropped ${record.sourceUrl} because no positive public metrics were visible.`
    };
  }
  const parsedPost = (JSON.parse(record.rawVisibleText) as { post?: FxTweet }).post;
  const authorHandle = normalizeHandle(parsedPost?.author?.screen_name);
  if (authorHandle !== target.handle) {
    return {
      ok: false,
      reason: "author_handle_mismatch",
      message: `Dropped ${record.sourceUrl} because @${authorHandle || "unknown"} did not match target @${target.handle}.`
    };
  }
  if (isRepostLikeXTweet(parsedPost)) {
    return {
      ok: false,
      reason: "non_native_x_repost",
      message: `Dropped ${record.sourceUrl} because it is a retweet/repost rather than a native post from @${target.handle}.`
    };
  }
  if (
    target.entityType === "founder" &&
    !options.allowDirectFounderAttribution &&
    !mentionsCompanyTarget(record, target)
  ) {
    return {
      ok: false,
      reason: "founder_post_missing_company_mention",
      message: `Dropped founder X post ${record.sourceUrl} because it does not visibly mention ${target.companyName}, its handle, or its domain.`
    };
  }

  return { ok: true };
}

function isRepostLikeXTweet(tweet: FxTweet | undefined): boolean {
  if (!tweet) {
    return false;
  }
  const raw = tweet as FxTweet & Record<string, unknown>;
  return Boolean(
    tweet.is_retweet === true ||
      raw.retweeted_status ||
      raw.retweeted_tweet ||
      raw.retweet ||
      raw.reposted_tweet ||
      /^RT\s+@/i.test(String(tweet.text ?? "").trim())
  );
}

function mentionsCompanyTarget(record: LiveEvidenceRecord, target: XTarget): boolean {
  const text = normalizeSearchText([record.title, record.text].join(" "));
  return targetTerms(target).some((term) => containsSearchTerm(text, term));
}

function targetTerms(target: XTarget): string[] {
  return [
    target.companyName,
    target.companySlug,
    target.companyWebsiteUrl ? domainToken(target.companyWebsiteUrl) : null
  ]
    .filter((value): value is string => Boolean(value))
    .map(normalizeSearchText);
}

function extractStatusIds(html: string, handle: string): string[] {
  const normalizedHandle = handle.toLowerCase();
  const ids = new Set<string>();
  const patterns = [
    new RegExp(`(?:https?:\\\\/\\\\/(?:twitter|x)\\\\.com\\\\/|https?://(?:twitter|x)\\.com/)${escapeRegExp(normalizedHandle)}\\\\/status\\\\/(\\d{10,})`, "gi"),
    new RegExp(`\\\\/${escapeRegExp(normalizedHandle)}\\\\/status\\\\/(\\d{10,})`, "gi"),
    new RegExp(`/${escapeRegExp(normalizedHandle)}/status/(\\d{10,})`, "gi")
  ];

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      if (match[1]) {
        ids.add(match[1]);
      }
    }
  }

  return [...ids];
}

function parseXStatusReferences(
  rawUrls: string[],
  log: (entry: Omit<LiveRefreshStageLog, "at">) => void
): XStatusReference[] {
  if (!rawUrls.length) {
    return [];
  }

  const references: XStatusReference[] = [];
  const seen = new Set<string>();
  for (const rawUrl of rawUrls) {
    const reference = parseXStatusReference(rawUrl);
    if (!reference) {
      log({
        stage: "dropped",
        platform: "x",
        sourceUrl: String(rawUrl),
        reason: "invalid_direct_x_url",
        message: `Dropped direct X source URL because it is not a supported X/Twitter status URL: ${rawUrl}.`
      });
      continue;
    }

    const key = `${reference.handle}:${reference.postId}`;
    if (seen.has(key)) {
      log({
        stage: "dropped",
        platform: "x",
        target: reference.handle,
        sourceUrl: reference.sourceUrl,
        reason: "duplicate_direct_x_url",
        message: `Skipped duplicate direct X source URL ${reference.sourceUrl}.`
      });
      continue;
    }
    seen.add(key);
    references.push(reference);
  }

  log({
    stage: "parsed",
    platform: "x",
    count: references.length,
    message: `Parsed ${references.length} direct X status source URL(s) from refresh request.`
  });
  return references;
}

function parseXStatusReference(rawUrl: string): XStatusReference | null {
  const value = String(rawUrl ?? "").trim();
  if (!value) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }

  const hostname = url.hostname.replace(/^(www|mobile)\./, "").toLowerCase();
  if (!["x.com", "twitter.com", "fxtwitter.com", "vxtwitter.com"].includes(hostname)) {
    return null;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts[1]?.toLowerCase() !== "status" || !/^\d{10,}$/.test(parts[2] ?? "")) {
    return null;
  }

  const handle = normalizeHandle(parts[0]);
  if (!handle || handle === "i") {
    return null;
  }
  return {
    handle,
    postId: parts[2],
    sourceUrl: `https://x.com/${handle}/status/${parts[2]}`
  };
}

function parseNativeXStatusReference(rawUrl: string): XStatusReference | null {
  const value = String(rawUrl ?? "").trim();
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^(www|mobile)\./, "").toLowerCase();
    if (hostname !== "x.com" && hostname !== "twitter.com") {
      return null;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 3 || parts[1] !== "status" || !/^\d{10,}$/.test(parts[2])) {
      return null;
    }
    const handle = normalizeHandle(parts[0]);
    if (!handle || handle === "i") {
      return null;
    }
    return {
      handle,
      postId: parts[2],
      sourceUrl: `https://x.com/${handle}/status/${parts[2]}`
    };
  } catch {
    return null;
  }
}

async function fetchFxTweet(
  handle: string,
  postId: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<{ ok: true; tweet: FxTweet } | { ok: false; reason: string }> {
  const urls = [
    `https://api.fxtwitter.com/${handle}/status/${postId}`,
    `https://api.vxtwitter.com/${handle}/status/${postId}`
  ];

  for (const url of urls) {
    const response = await fetchJson(url, fetchImpl, timeoutMs);
    if (!response.ok) {
      continue;
    }
    const tweet = (response.json as { tweet?: FxTweet }).tweet;
    if (tweet?.id) {
      return { ok: true, tweet };
    }
  }

  return { ok: false, reason: "post_json_unavailable" };
}

async function fetchText(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { "user-agent": "Mozilla/5.0 returner-fund-live-refresh" }
    });
    if (!response.ok) {
      return { ok: false, reason: `http_${response.status}` };
    }
    return { ok: true, text: await response.text() };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "fetch_failed" };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<{ ok: true; json: unknown } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { "user-agent": "Mozilla/5.0 returner-fund-live-refresh" }
    });
    if (!response.ok) {
      return { ok: false, reason: `http_${response.status}` };
    }
    return { ok: true, json: await response.json() };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "fetch_failed" };
  } finally {
    clearTimeout(timeout);
  }
}

async function readEvidenceSnapshot(path: string, fallbackFetchedAt: string): Promise<EvidenceSnapshot> {
  try {
    const snapshot = JSON.parse(await readFile(path, "utf8")) as EvidenceSnapshot;
    return {
      source: snapshot.source ?? { fetchedAt: fallbackFetchedAt },
      evidence: Array.isArray(snapshot.evidence) ? snapshot.evidence : [],
      needsReview: Array.isArray(snapshot.needsReview) ? snapshot.needsReview : []
    };
  } catch {
    return {
      source: { fetchedAt: fallbackFetchedAt },
      evidence: [],
      needsReview: []
    };
  }
}

async function writeEvidenceSnapshot(path: string, snapshot: EvidenceSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  await rename(tempPath, path);
  liveEvidenceRecordsCache.delete(path);
}

async function writeStageLog(path: string, stageLog: LiveRefreshStageLog[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), stages: stageLog }, null, 2)}\n`);
  await rename(tempPath, path);
}

function mergeEvidence(existing: LiveEvidenceRecord[], accepted: LiveEvidenceRecord[]): LiveEvidenceRecord[] {
  const byKey = new Map<string, LiveEvidenceRecord>();

  for (const item of existing) {
    byKey.set(evidenceKey(item), item);
  }
  for (const item of accepted) {
    const key = evidenceKey(item);
    const existingItem = byKey.get(key);
    byKey.set(key, existingItem ? preserveFirstSeen(existingItem, item) : item);
  }

  return [...byKey.values()].sort((left, right) => compareIso(right.last_checked_at, left.last_checked_at));
}

function preserveFirstSeen(existing: LiveEvidenceRecord, next: LiveEvidenceRecord): LiveEvidenceRecord {
  return {
    ...next,
    first_seen_at: existing.first_seen_at || next.first_seen_at
  };
}

function evidenceKey(item: LiveEvidenceRecord): string {
  return `${item.entityId}:${item.platform}:${item.platformPostId ?? item.sourceUrl}`;
}

function batchSlugExpansion(batchSlug: string | undefined): string[] {
  if (!batchSlug) {
    return DEFAULT_BATCH_SLUGS;
  }
  return [batchSlug];
}

function normalizeRequestedPlatforms(platforms: Platform[] | undefined): Platform[] {
  return [...new Set(platforms?.filter(Boolean) ?? [])];
}

function shouldRefreshPlatform(platform: Platform, requestedPlatforms: Platform[]): boolean {
  return !requestedPlatforms.length || requestedPlatforms.includes(platform);
}

function countRowsByPlatform(records: LiveEvidenceRecord[]): Partial<Record<Platform, number>> {
  return records.reduce<Partial<Record<Platform, number>>>((counts, record) => {
    counts[record.platform] = (counts[record.platform] ?? 0) + 1;
    return counts;
  }, {});
}

function countReasons(stageLog: LiveRefreshStageLog[]): Record<string, number> {
  return stageLog.reduce<Record<string, number>>((counts, entry) => {
    if (entry.stage !== "failed" && entry.stage !== "dropped" && entry.stage !== "skipped") {
      return counts;
    }
    const reason = entry.reason ?? entry.stage;
    counts[reason] = (counts[reason] ?? 0) + 1;
    return counts;
  }, {});
}

function hasVisibleMetrics(metrics: EvidenceMetrics): boolean {
  return Object.values(metrics).some((value) => Number.isFinite(value) && Number(value) > 0);
}

function computeVisibleMetricCount(metrics: EvidenceMetrics): number {
  return Object.values(metrics).filter((value) => Number.isFinite(value) && Number(value) > 0).length;
}

function provisionalContributionScore(platform: Platform, metrics: EvidenceMetrics): number {
  const raw = computeEvidenceRawEngagement(platform, metrics);
  if (raw <= 0) {
    return 0;
  }
  return Math.max(1, Math.min(100, Math.round(16 + Math.log10(raw + 1) * 18)));
}

function formatMetrics(metrics: EvidenceMetrics): string {
  return Object.entries(metrics)
    .filter(([, value]) => Number.isFinite(value) && Number(value) > 0)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

function formatPlatform(platform: Platform): string {
  return platform.replace(/_/g, " ");
}

function finiteNumber(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function parseDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function compareIso(left: string | undefined, right: string | undefined): number {
  return Date.parse(left ?? "") - Date.parse(right ?? "");
}

function handleFromUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) {
    return null;
  }
  const value = rawUrl.trim();
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^(www|mobile)\./, "").toLowerCase();
    if (hostname === "x.com" || hostname === "twitter.com") {
      const handle = url.pathname.split("/").filter(Boolean)[0] ?? "";
      if (handle && !["i", "home", "search"].includes(handle.toLowerCase())) {
        return normalizeHandle(handle);
      }
    }
  } catch {
    return rawHandleFallback(value);
  }
  return null;
}

function genericHandleFromUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) {
    return null;
  }
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.replace(/^www\./, "").toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean);
    if ((hostname === "x.com" || hostname === "twitter.com") && parts[0] && !["i", "home", "search"].includes(parts[0])) {
      return normalizeHandle(parts[0]);
    }
    if (hostname === "instagram.com" && parts[0] && !["p", "reel", "tv", "explore"].includes(parts[0])) {
      return normalizeHandle(parts[0]);
    }
    if (hostname.endsWith("linkedin.com")) {
      const markerIndex = parts.findIndex((part) => ["in", "company"].includes(part.toLowerCase()));
      return markerIndex >= 0 && parts[markerIndex + 1] ? normalizeHandle(parts[markerIndex + 1]) : null;
    }
    if (hostname === "github.com" && parts[0]) {
      return normalizeHandle(parts[0]);
    }
    if (hostname.endsWith("youtube.com")) {
      const handle = parts.find((part) => part.startsWith("@"));
      return handle ? normalizeHandle(handle.slice(1)) : null;
    }
  } catch {
    return rawHandleFallback(rawUrl);
  }
  return null;
}

function rawHandleFallback(value: string | null | undefined): string | null {
  const candidate = String(value ?? "").trim().replace(/^@/, "");
  return /^[A-Za-z0-9._-]{1,30}$/.test(candidate) ? normalizeHandle(candidate) : null;
}

function domainToken(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "").split(".")[0] ?? null;
  } catch {
    return null;
  }
}

function normalizeHandle(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9._-]+/g, "")
    .replace(/^-+|-+$/g, "");
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\/(www\.)?/g, " ")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsSearchTerm(haystack: string, term: string): boolean {
  if (term.length < 4) {
    return false;
  }
  const escaped = escapeRegExp(term);
  return new RegExp(`(^| )${escaped}($| )`).test(haystack);
}

function isAmbiguousTopVoiceMatchTerm(term: string): boolean {
  return AMBIGUOUS_TOP_VOICE_MATCH_TERMS.has(term);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
