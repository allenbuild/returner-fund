#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DEFAULT_OVERRIDES = path.join(ROOT, 'src', 'lib', 'social', 'verified-social-overrides.json');
const DEFAULT_CHECKPOINT = path.join(ROOT, 'work', 'logged-in-social-checkpoint.json');
const DEFAULT_COMPANIES = path.join(ROOT, 'src', 'lib', 'yc', 'spring-2026-companies.json');
const DEFAULT_LOGGED_IN_EVIDENCE = path.join(ROOT, 'src', 'lib', 'social', 'logged-in-evidence-current.json');

function argValue(name, fallback) {
  const prefix = `${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeHandle(value) {
  if (!value) return '';
  const text = String(value).trim();
  const match = text.match(/instagram\.com\/([^/?#]+)/i);
  const handle = match ? match[1] : text.replace(/^@/, '');
  return handle.toLowerCase().replace(/\/+$/, '');
}

function instagramUrlFromHandle(handle) {
  return `https://www.instagram.com/${String(handle).replace(/^@/, '').replace(/\/+$/, '')}/`;
}

const overridesPath = path.resolve(argValue('--overrides', DEFAULT_OVERRIDES));
const checkpointPath = path.resolve(argValue('--checkpoint', DEFAULT_CHECKPOINT));
const companiesPath = path.resolve(argValue('--companies', DEFAULT_COMPANIES));
const evidencePath = path.resolve(argValue('--evidence', DEFAULT_LOGGED_IN_EVIDENCE));
const write = hasFlag('--write');
const quarantineSearchDerived = hasFlag('--quarantine-search-derived');
const quarantineEvidence = !hasFlag('--skip-evidence-quarantine');
const keepSearchDerivedSlugs = new Set(
  String(argValue('--keep-search-derived', ''))
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
);

const overrides = readJson(overridesPath, {});
const checkpoint = readJson(checkpointPath, {});
const companiesSnapshot = readJson(companiesPath, { companies: [] });
const loggedInEvidence = readJson(evidencePath, null);
const companiesBySlug = new Map((companiesSnapshot.companies || []).map((company) => [company.slug, company]));
const failures = (checkpoint.failures || []).filter((failure) => {
  return failure.platform === 'instagram' && /identity mismatch/i.test(failure.message || '');
});

const rejectedAt = new Date().toISOString();
const actions = [];

for (const failure of failures) {
  const slug = failure.companySlug;
  const entry = overrides[slug];
  if (!slug || !entry?.companySocialLinks?.instagram) continue;

  const handleMatch = String(failure.message || '').match(/@([^:]+):/);
  const failedHandle = normalizeHandle(handleMatch?.[1] || failure.url || '');
  const currentHandle = normalizeHandle(entry.companySocialLinks.instagram);

  if (failedHandle && currentHandle && failedHandle !== currentHandle) {
    actions.push({
      slug,
      status: 'skipped_handle_changed',
      current: entry.companySocialLinks.instagram,
      failedHandle,
    });
    continue;
  }

  const rejectedUrl = entry.companySocialLinks.instagram || instagramUrlFromHandle(failedHandle);
  const rejected = {
    url: rejectedUrl,
    rejectedAt,
    reason: failure.message || 'Instagram profile identity mismatch during logged-in verification.',
    source: 'logged-in-instagram-identity-guard',
  };

  const existingRejected = Array.isArray(entry.rejectedInstagram) ? entry.rejectedInstagram : [];
  const alreadyRejected = existingRejected.some((item) => normalizeHandle(item.url) === normalizeHandle(rejectedUrl));
  entry.rejectedInstagram = alreadyRejected ? existingRejected : [...existingRejected, rejected];

  delete entry.companySocialLinks.instagram;
  if (Object.keys(entry.companySocialLinks).length === 0) {
    delete entry.companySocialLinks;
  }

  actions.push({
    slug,
    status: write ? 'pruned' : 'would_prune',
    url: rejectedUrl,
    reason: rejected.reason,
  });
}

if (quarantineSearchDerived) {
  for (const [slug, entry] of Object.entries(overrides)) {
    const instagramUrl = entry?.companySocialLinks?.instagram;
    if (!instagramUrl || !isUnsafeSearchDerivedOverride(entry)) continue;

    if (keepSearchDerivedSlugs.has(slug)) {
      const company = companiesBySlug.get(slug);
      entry.instagramValidation = {
        review_state: 'verified',
        validatedAt: rejectedAt,
        method: 'explicit_keep_search_derived',
        reason: `Explicitly kept after user-visible profile review for ${company?.name ?? slug}.`
      };
      entry.matchReason = `Manual verified Instagram profile for ${company?.name ?? slug}; ${entry.matchReason ?? ''}`.trim();
      actions.push({
        slug,
        status: write ? 'kept_explicit_search_derived' : 'would_keep_explicit_search_derived',
        url: instagramUrl
      });
      continue;
    }

    const nextCompanySocialLinks = { ...(entry.companySocialLinks ?? {}) };
    delete nextCompanySocialLinks.instagram;
    const needsReview = {
      url: instagramUrl,
      movedAt: rejectedAt,
      reason:
        'Search-derived Instagram handle was not promoted: search-result handle/name matching alone is not enough to prove company/founder identity.',
      previousMatchReason: entry.matchReason ?? null,
      source: 'search-derived-instagram-quarantine'
    };
    entry.companySocialLinks = nextCompanySocialLinks;
    entry.needsReviewInstagram = [
      ...(Array.isArray(entry.needsReviewInstagram) ? entry.needsReviewInstagram : []),
      needsReview
    ];
    if (Object.keys(entry.companySocialLinks).length === 0) {
      delete entry.companySocialLinks;
    }
    actions.push({
      slug,
      status: write ? 'quarantined_search_derived' : 'would_quarantine_search_derived',
      url: instagramUrl,
      reason: needsReview.reason
    });
  }
}

const evidenceActions = quarantineEvidence ? quarantineUnverifiedInstagramEvidence(loggedInEvidence, overrides, rejectedAt) : [];

if (
  write &&
  actions.some((action) =>
    ['pruned', 'quarantined_search_derived', 'kept_explicit_search_derived'].includes(action.status)
  )
) {
  writeJson(overridesPath, overrides);
}
if (write && loggedInEvidence && evidenceActions.some((action) => action.status === 'quarantined_evidence')) {
  writeJson(evidencePath, loggedInEvidence);
}

const summary = [...actions, ...evidenceActions].reduce(
  (acc, action) => {
    acc[action.status] = (acc[action.status] || 0) + 1;
    return acc;
  },
  { failures: failures.length },
);

console.log(
  JSON.stringify(
    {
      checkpoint: checkpointPath,
      overrides: overridesPath,
      evidence: loggedInEvidence ? evidencePath : null,
      summary,
      actions,
      evidenceActions
    },
    null,
    2
  )
);

function isUnsafeSearchDerivedOverride(entry) {
  if (entry?.instagramValidation?.review_state === 'verified') return false;
  const reason = String(entry?.matchReason ?? '');
  return /(?:Web Instagram search|OpenCLI Instagram search)/i.test(reason);
}

function quarantineUnverifiedInstagramEvidence(snapshot, currentOverrides, checkedAt) {
  if (!snapshot?.evidence) return [];

  const verifiedHandlesBySlug = verifiedInstagramHandlesBySlug(currentOverrides);
  const evidenceActions = [];
  for (const item of snapshot.evidence) {
    if (item.platform !== 'instagram') continue;
    const slug = item.companySlug;
    if (!slug) continue;

    const verifiedHandles = verifiedHandlesBySlug.get(slug) ?? new Set();
    const handle = instagramEvidenceHandle(item);
    const hasVerifiedHandle = handle && verifiedHandles.has(handle);
    if (hasVerifiedHandle) continue;

    item.review_state = 'needs_review';
    item.contributionScore = 0;
    item.last_checked_at = checkedAt;
    item.last_updated_at = checkedAt;
    item.matchReason = appendReason(
      item.matchReason,
      handle
        ? `Instagram identity quarantine: @${handle} is not a verified company/founder Instagram handle for ${item.companyName}.`
        : `Instagram identity quarantine: row did not expose a verified company/founder Instagram handle for ${item.companyName}.`
    );
    evidenceActions.push({
      id: item.id,
      slug,
      status: 'quarantined_evidence',
      handle: handle || null
    });
  }

  return evidenceActions;
}

function verifiedInstagramHandlesBySlug(currentOverrides) {
  const bySlug = new Map();
  for (const [slug, entry] of Object.entries(currentOverrides)) {
    const handles = new Set();
    const companyHandle = normalizeHandle(entry?.companySocialLinks?.instagram);
    if (companyHandle) handles.add(companyHandle);
    for (const founder of entry?.founders ?? []) {
      const founderHandle = normalizeHandle(founder?.socialLinks?.instagram ?? founder?.instagram);
      if (founderHandle) handles.add(founderHandle);
    }
    if (handles.size) bySlug.set(slug, handles);
  }
  return bySlug;
}

function instagramEvidenceHandle(item) {
  const raw = String(item.rawVisibleText ?? '');
  try {
    const parsed = JSON.parse(raw);
    const username = parsed?.profile?.username || parsed?.profile?.url || parsed?.gridUrl?.rawHref || parsed?.gridUrl?.href;
    const normalized = normalizeHandle(username);
    if (normalized) return normalized;
  } catch {
    // Fall through to regex-based extraction.
  }

  const fromRawHref = raw.match(/instagram\.com\/([A-Za-z0-9._]+)\/(?:p|reel|tv)\//i)?.[1];
  if (fromRawHref) return normalizeHandle(fromRawHref);
  const fromProfileUrl = raw.match(/"url"\s*:\s*"https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]+)/i)?.[1];
  if (fromProfileUrl) return normalizeHandle(fromProfileUrl);
  const fromId = String(item.id ?? '').match(/instagram-(?:company|founder)-[^-]+-[^-]+-([a-z0-9._]+)-/i)?.[1];
  return normalizeHandle(fromId);
}

function appendReason(existing, addition) {
  const text = String(existing ?? '').trim();
  return text.includes(addition) ? text : [text, addition].filter(Boolean).join(' ');
}
