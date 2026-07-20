import {
  linkedinAccountSlugFromUrl,
  linkedinNativeAuthorSlugFromPayload,
  linkedinNativeAuthorSlugFromUrl,
  linkedinPostIdFromUrl
} from "./social-native-identity.mjs";

const COLLISION_PRONE_SINGLE_TOKEN_NAMES = new Set([
  "almanac",
  "archer",
  "august",
  "auto",
  "belong",
  "bloom",
  "forge",
  "hedge",
  "magic",
  "meridian",
  "mirror",
  "nex",
  "palette",
  "prism",
  "reason",
  "relay",
  "rise",
  "sun",
  "thomas",
  "trellis",
  "walter"
]);

const STRONG_ATTRIBUTION_SIGNALS = new Set([
  "company_domain",
  "founder_subject_exact_identity",
  "mapped_official_account",
  "native_channel_brand",
  "native_channel_roster_founder",
  "same_company_native_author_subject",
  "unique_native_author"
]);

export const PUBLIC_EVIDENCE_ATTRIBUTION_VERSION = 3;

export function containsExactTokenSequence(text, value) {
  const tokens = normalizeBoundaryIdentity(value).match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) return false;
  const pattern = tokens.map(escapeRegExp).join("[^\\p{L}\\p{N}]+");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${pattern}(?=$|[^\\p{L}\\p{N}])`, "iu")
    .test(normalizeBoundaryIdentity(text));
}

export function isCollisionProneCompanyName(companyName) {
  const words = String(companyName ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (words.length !== 1) return false;
  const [word] = words;
  return word.length <= 3 || COLLISION_PRONE_SINGLE_TOKEN_NAMES.has(word);
}

export function organizationQualifiedBatchMarker(batchSlug, text) {
  const value = String(text ?? "");
  if (batchSlug === "S2026") {
    return /(?:\bYC\s*(?:P26|S2026|Spring\s+2026)\b|\bY\s*Combinator\s*(?:P26|S2026|Spring\s+2026)\b)/i.test(value);
  }
  if (batchSlug === "S26") {
    return /(?:\bYC\s*(?:S26|Summer\s+2026)\b|\bY\s*Combinator\s*(?:S26|Summer\s+2026)\b)/i.test(value);
  }
  if (batchSlug === "A16ZSR006") {
    return /(?:\ba16z\s+Speedrun(?:\s+006)?\b|\bA16ZSR006\b)/i.test(value);
  }
  return false;
}

export function conflictingOrganizationBatchMarker(batchSlug, text) {
  const value = String(text ?? "");
  if (batchSlug === "S2026") {
    return /(?:\bYC\s*(?:S26|Summer\s+2026)\b|\bY\s*Combinator\s*(?:S26|Summer\s+2026)\b)/i.test(value);
  }
  if (batchSlug === "S26") {
    return /(?:\bYC\s*(?:P26|S2026|Spring\s+2026)\b|\bY\s*Combinator\s*(?:P26|S2026|Spring\s+2026)\b)/i.test(value);
  }
  return false;
}

export function assessPublicEvidenceAttribution({
  batchSlug,
  companyName,
  text,
  signals = [],
  descriptorMatches = []
}) {
  const signalSet = new Set((signals ?? []).filter(Boolean));
  const exactCompanyName = containsExactTokenSequence(text, companyName) ||
    containsExactCompactMultiTokenName(text, companyName);
  const controlledCompanyBrandVariant = containsControlledCompanyBrandVariant(text, companyName);
  const companySubjectNameMatch = exactCompanyName || controlledCompanyBrandVariant;
  const collisionProne = isCollisionProneCompanyName(companyName);
  const expectedBatch = organizationQualifiedBatchMarker(batchSlug, text);
  const conflictingBatch = conflictingOrganizationBatchMarker(batchSlug, text);
  const independentSignal = [...signalSet].some((signal) => STRONG_ATTRIBUTION_SIGNALS.has(signal));
  const descriptors = [...new Set((descriptorMatches ?? []).map((value) => String(value).toLowerCase()))];
  const companyAndRosterFounder = companySubjectNameMatch && signalSet.has("roster_founder");
  const companyAndDistinctivePhrase = companySubjectNameMatch && collisionProne &&
    signalSet.has("catalog_distinctive_phrase");
  const batchListOnly = signalSet.has("batch_list_only");
  const exactOwnerAnchor = [
    "mapped_official_account",
    "native_channel_brand",
    "native_channel_roster_founder",
    "same_company_native_author_subject",
    "unique_native_author"
  ].some((signal) => signalSet.has(signal));

  let verified = false;
  let reason = "semantic_attribution_missing";
  if (batchListOnly && !exactOwnerAnchor) {
    reason = "list_or_roundup_without_target_specific_owner_anchor";
  } else if (independentSignal) {
    verified = true;
    reason = "independent_identity_anchor";
  } else if (companyAndRosterFounder) {
    verified = true;
    reason = "exact_company_and_roster_founder";
  } else if (!companySubjectNameMatch) {
    reason = "company_name_token_boundary_mismatch";
  } else if (controlledCompanyBrandVariant && !exactCompanyName) {
    reason = "controlled_company_brand_variant_without_roster_founder_or_owner_anchor";
  } else if (expectedBatch) {
    // Exact organization-qualified cohort text disambiguates even short or
    // collision-prone company names (for example Ara or Trellis YC P26).
    verified = true;
    reason = "exact_company_and_expected_cohort";
  } else if (companyAndDistinctivePhrase) {
    verified = true;
    reason = "exact_company_and_catalog_phrase";
  } else if (collisionProne) {
    reason = "collision_prone_name_without_independent_anchor";
  } else {
    reason = "distinctive_name_without_strong_subject_anchor";
  }

  return {
    verified,
    reason,
    exactCompanyName,
    controlledCompanyBrandVariant,
    companySubjectNameMatch,
    collisionProne,
    expectedBatch,
    conflictingBatch,
    signals: [...signalSet].sort(),
    descriptorMatches: descriptors.sort()
  };
}

function containsExactCompactMultiTokenName(text, companyName) {
  const tokens = normalizeBoundaryIdentity(companyName).match(/[a-z0-9]+/g) ?? [];
  if (tokens.length < 2) return false;
  const compact = tokens.join("");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(compact)}(?=$|[^\\p{L}\\p{N}])`, "iu")
    .test(normalizeBoundaryIdentity(text));
}

export function containsControlledCompanyBrandVariant(text, companyName) {
  const tokens = normalizeBoundaryIdentity(companyName).match(/[a-z0-9]+/g) ?? [];
  if (tokens.length < 2) return false;
  const controlledSuffixes = new Set([
    "ai", "app", "corp", "corporation", "inc", "labs", "robotics", "systems",
    "technologies", "technology"
  ]);
  if (!controlledSuffixes.has(tokens.at(-1))) return false;
  const base = tokens.slice(0, -1).join(" ");
  if (base.replace(/\s+/g, "").length < 4) return false;
  const basePattern = base.split(/\s+/).map(escapeRegExp).join("[^\\p{L}\\p{N}]+");
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${basePattern}\\s*\\(\\s*(?:YC\\s*(?:P26|S26|S2026)|Y\\s*Combinator\\s*(?:P26|S26|S2026)|a16z\\s+Speedrun(?:\\s+006)?)\\s*\\)`,
    "iu"
  ).test(normalizeBoundaryIdentity(text));
}

export function publicEvidenceAttributionText(row) {
  const primaryPostText = extractLinkedInPrimaryPostText(row);
  if (primaryPostText) return primaryPostText;
  const platform = normalizePlatformName(row?.platform);
  const trustedLinkedInV3 = platform === "linkedin" &&
    Number(row?.attributionVersion ?? 0) >= PUBLIC_EVIDENCE_ATTRIBUTION_VERSION;
  if (trustedLinkedInV3 && row?.attributionProvenance === "verified_linkedin_primary_body_v3") {
    // The v3 field is already the structurally bounded primary body. Pipes in
    // it are authored content (for example "screenpipe | YC S26"), not search
    // title chrome, so suffix stripping would silently erase cohort proof.
    return cleanSubjectField(row?.text, { preservePipeSuffix: true });
  }
  if (trustedLinkedInV3 && row?.attributionProvenance === "strict_native_search_snippet_v3") {
    return [cleanSubjectField(row?.title, { title: true }), cleanSubjectField(row?.text)]
      .filter(Boolean)
      .join("\n");
  }
  const rawVisibleText = String(row?.rawVisibleText ?? "");
  const isLinkedInReaderPayload = Boolean(
    linkedinPostIdFromUrl(row?.sourceUrl ?? "") &&
    /\b(?:URL\s+Source|Markdown\s+Content)\s*:/i.test(rawVisibleText)
  );
  if (isLinkedInReaderPayload) return "";
  return [...new Set([
    cleanSubjectField(row?.title, { title: true }),
    cleanSubjectField(row?.text)
  ].filter(Boolean))].join("\n");
}

/**
 * Extract only the primary LinkedIn post body from a reader payload. LinkedIn
 * pages contain profile chrome, comments, and unrelated posts that must never
 * become semantic attribution evidence. A body is usable only when its exact
 * activity identity and both structural boundaries are visible.
 */
export function assessLinkedInPrimaryPostBody(row) {
  const rawVisibleText = String(row?.rawVisibleText ?? "").normalize("NFKC");
  if (!rawVisibleText) {
    return { verified: false, reason: "linkedin_primary_body_raw_unavailable", text: null };
  }

  const explicitId = String(row?.platformPostId ?? "");
  const expectedId = String(
    linkedinPostIdFromUrl(row?.sourceUrl ?? "") ??
      (/^\d{10,}$/.test(explicitId) ? explicitId : "")
  );
  if (!/^\d{10,}$/.test(expectedId)) {
    return { verified: false, reason: "linkedin_primary_body_activity_id_unavailable", text: null };
  }

  const sourceMatch = rawVisibleText.match(/\bURL\s+Source\s*:\s*(https?:\/\/\S+)/i);
  const sourceId = linkedinPostIdFromUrl(sourceMatch?.[1] ?? "");
  if (!sourceId) {
    return { verified: false, reason: "linkedin_primary_body_url_source_unavailable", text: null };
  }
  if (sourceId !== expectedId) {
    return {
      verified: false,
      reason: `linkedin_primary_body_activity_id_mismatch:expected=${expectedId};source=${sourceId}`,
      text: null
    };
  }

  const markdownStart = rawVisibleText.search(/\bMarkdown\s+Content\s*:/i);
  if (markdownStart < 0) {
    return { verified: false, reason: "linkedin_primary_body_markdown_marker_missing", text: null };
  }
  const relatedPostsStart = rawVisibleText.indexOf("## More Relevant Posts", markdownStart);
  const reportPattern = /\[Report this post\]\([^)]*guestReportContentType=POST[^)]*\)/gi;
  reportPattern.lastIndex = markdownStart;
  const reportMatch = reportPattern.exec(rawVisibleText);
  if (!reportMatch || (relatedPostsStart >= 0 && reportMatch.index >= relatedPostsStart)) {
    return { verified: false, reason: "linkedin_primary_body_report_marker_missing", text: null };
  }

  const bodyStart = reportMatch.index + reportMatch[0].length;
  const boundaryPatterns = [
    /\[(?:Like|Comment)\]\(/gi,
    /\[\d[\d,]*\s+Comments?\]\(/gi,
    /\bLike\s+Comment\s+Share\b/gi,
    /\bTo view or add a comment\b/gi,
    /##\s+More Relevant Posts\b/gi
  ];
  const boundaries = [];
  for (const pattern of boundaryPatterns) {
    pattern.lastIndex = bodyStart;
    const match = pattern.exec(rawVisibleText);
    if (match) boundaries.push(match.index);
  }
  if (boundaries.length === 0) {
    return { verified: false, reason: "linkedin_primary_body_end_boundary_missing", text: null };
  }
  const bodyEnd = Math.min(...boundaries);
  if (bodyEnd <= bodyStart) {
    return { verified: false, reason: "linkedin_primary_body_empty", text: null };
  }

  const markdownBody = rawVisibleText.slice(bodyStart, bodyEnd);
  const text = cleanLinkedInPrimaryPostMarkdown(markdownBody);
  if (!text) {
    return { verified: false, reason: "linkedin_primary_body_empty", text: null };
  }
  return { verified: true, reason: "linkedin_primary_body_complete", text };
}

export function extractLinkedInPrimaryPostText(row) {
  return assessLinkedInPrimaryPostBody(row).text;
}

export function organizationQualifiedBatchMarkerCount(batchSlug, text) {
  const value = String(text ?? "");
  if (batchSlug === "S2026") {
    return value.match(/(?:\bYC\s*(?:P26|S2026|Spring\s+2026)\b|\bY\s*Combinator\s*(?:P26|S2026|Spring\s+2026)\b)/gi)?.length ?? 0;
  }
  if (batchSlug === "S26") {
    return value.match(/(?:\bYC\s*(?:S26|Summer\s+2026)\b|\bY\s*Combinator\s*(?:S26|Summer\s+2026)\b)/gi)?.length ?? 0;
  }
  if (batchSlug === "A16ZSR006") {
    return value.match(/(?:\ba16z\s+Speedrun(?:\s+006)?\b|\bA16ZSR006\b)/gi)?.length ?? 0;
  }
  return 0;
}

export function isListOrRoundupAttributionContext(batchSlug, text) {
  const value = String(text ?? "");
  if (organizationQualifiedBatchMarkerCount(batchSlug, value) >= 8) return true;
  const plusEntryCount = value.match(/^\s*\+\s+(?=\S)/gmu)?.length ?? 0;
  const bulletCount = value.match(/^\s*(?:⏺(?:️)?|🔹|▪(?:️)?|▫(?:️)?|◦|•)\s*(?=\S)/gmu)?.length ?? 0;
  const numberedEntryCount = value.match(/^\s*\d{1,2}[.)]\s+(?=\S)/gm)?.length ?? 0;
  const structuredEntryCount = plusEntryCount + bulletCount + numberedEntryCount;
  const inlineBulletCount = value.match(/(?:⏺(?:️)?|🔹|▪(?:️)?|▫(?:️)?|◦|(?:^|\s)•(?=\s))/gu)?.length ?? 0;
  const inlineNumberedEntryCount = value.match(/(?:^|\s)\d{1,2}[.)]\s+/g)?.length ?? 0;
  const tangentialPeopleList = /\bsup+o+r+t\w*\s+by(?:\s+the\s+\w+)?\b[^.!?]{0,220},[^.!?]{0,180},[^.!?]{0,180},/i
    .test(value);
  const partnerRosterList = /\b(?:welcome\s+\d+\s+new\s+partners|say\s+hello\s+to\s+our\s+newest\s+partners)\b/i
    .test(value);
  if (tangentialPeopleList || partnerRosterList) return true;
  const roundupFraming = /\b(?:last\s+week|this\s+week|weekly|roundup|selection|news\s+digest)\b/i
    .test(value);
  if ((inlineBulletCount >= 4 || inlineNumberedEntryCount >= 5) && roundupFraming) return true;
  const explicitCompanyListFraming = [
    /\bhere(?:'s|\s+is)\s+the\s+top\b[^\n.!?]{0,100}\bstartups?\b/i,
    /\bthe\s+\d{1,2}\s+most\b[^\n.!?]{0,100}\bstartups?\b/i,
    /\bhere\s+are\s+(?:some\s+)?companies\b[^\n.!?]{0,140}\b(?:recommend|keep(?:ing)?\s+an\s+eye\s+on)\b/i,
    /\bcompanies\b[^\n.!?]{0,140}\b(?:recommend(?:ed)?|keep(?:ing)?\s+an\s+eye\s+on)\b/i
  ].some((pattern) => pattern.test(value));
  return structuredEntryCount >= 4 && explicitCompanyListFraming;
}

export function hasDistinctiveCatalogPhrase(company, text) {
  const subjectTokens = attributionPhraseTokens(text);
  const taglineTokens = attributionPhraseTokens(company?.tagline);
  if (subjectTokens.length < 3 || taglineTokens.length < 3) return false;
  const subject = subjectTokens.join(" ");
  const generic = new Set([
    "about", "agent", "agents", "and", "are", "build", "building", "company", "for",
    "from", "have", "into", "our", "platform", "product", "that", "the", "their",
    "they", "this", "through", "using", "was", "were", "with", "your"
  ]);
  for (let width = Math.min(6, taglineTokens.length); width >= 3; width -= 1) {
    for (let index = 0; index + width <= taglineTokens.length; index += 1) {
      const window = taglineTokens.slice(index, index + width);
      if (!window.some((token) => token.length >= 5 && !generic.has(token))) continue;
      if (subject.includes(window.join(" "))) return true;
    }
  }
  return false;
}

function cleanSubjectField(value, { title = false, preservePipeSuffix = false } = {}) {
  let text = String(value ?? "").normalize("NFKC").trim();
  if (!text) return "";
  if (title) {
    const segments = text.split(/\s+\|\s+/).map((segment) => segment.trim()).filter(Boolean);
    // Search-result titles commonly append a native author and the word
    // "LinkedIn" after pipes.  Those fields are attribution chrome, not post
    // content.  A cohort qualifier after a pipe is genuine subject context,
    // however (for example "Founder reacts to HeyClicky | YC Spring 2026"),
    // so retain only explicitly organization-qualified context segments.
    text = [
      segments[0],
      ...segments.slice(1).filter((segment) =>
        /(?:\bYC\s*(?:P26|S26|S2026|Spring\s+2026|Summer\s+2026)\b|\bY\s*Combinator\s*(?:P26|S26|S2026|Spring\s+2026|Summer\s+2026)\b|\ba16z\s+Speedrun(?:\s+006)?\b|\bA16ZSR006\b)/i.test(segment)
      )
    ].filter(Boolean).join(" | ");
  }
  const sourceMarker = text.search(/\bURL\s+Source\s*:/i);
  if (sourceMarker >= 0) text = text.slice(0, sourceMarker).trim();
  const markdownMarker = text.search(/\bMarkdown\s+Content\s*:/i);
  if (markdownMarker >= 0) text = text.slice(0, markdownMarker).trim();
  if (/^\[?Skip to main content\b/i.test(text) || /^Agree\s*&\s*Join\s+LinkedIn\b/i.test(text)) {
    return "";
  }
  return title || preservePipeSuffix
    ? text.trim()
    : text.replace(/\s+\|\s+[^|]{1,120}$/, "").trim();
}

function attributionPhraseTokens(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function normalizeBoundaryIdentity(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

function normalizePlatformName(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "twitter" ? "x" : normalized;
}

function cleanLinkedInPrimaryPostMarkdown(value) {
  const markdown = String(value ?? "");
  const firstMedia = markdown.indexOf("[![");
  return (firstMedia >= 0 ? markdown.slice(0, firstMedia) : markdown)
    // Media/link-preview Markdown is not authored subject text and often
    // contains AI-generated alt text. Remove it before retaining normal links.
    .replace(/\[!\[[\s\S]*?\]\([^)]*\)[\s\S]*?\]\([^)]*\)/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, (match, label, offset, input) =>
      ` ${label}${input[offset + match.length] === "." ? "" : " "}`
    )
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/(?:^|\s)[*•](?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build a fail-closed, native-author resolver from the complete autonomous
 * catalog.  The index is global (not batch-local) on purpose: an author found
 * in the wrong collector lane must be moved to its canonical owner, including
 * when that owner belongs to a different batch.
 */
export function buildPublicNativeAuthorResolver(catalogs) {
  const ownersByNativeAccount = new Map();
  const companiesByBatchEntity = new Map();
  const companyOwners = [];

  for (const catalog of catalogs ?? []) {
    for (const company of catalog?.companies ?? []) {
      const companySlug = catalogCompanySlug(company);
      const companyOwner = {
        batchSlug: catalog.slug,
        entityType: "company",
        entityId: company.sourceKey,
        entityName: company.name,
        companySlug,
        companyName: company.name,
        companyEntityId: company.sourceKey,
        company
      };
      companyOwners.push(companyOwner);
      indexOwnerAccounts(ownersByNativeAccount, companyOwner, company.accounts);
      companiesByBatchEntity.set(ownerLookupKey(catalog.slug, company.sourceKey), companyOwner);
      companiesByBatchEntity.set(ownerLookupKey(catalog.slug, companySlug), companyOwner);
      companiesByBatchEntity.set(ownerLookupKey(catalog.slug, company.name), companyOwner);

      for (const founder of company.founders ?? []) {
        const founderOwner = {
          ...companyOwner,
          entityType: "founder",
          entityId: founder.sourceKey,
          entityName: founder.name,
          founder
        };
        indexOwnerAccounts(ownersByNativeAccount, founderOwner, founder.accounts);
        companiesByBatchEntity.set(ownerLookupKey(catalog.slug, founder.sourceKey), companyOwner);
        companiesByBatchEntity.set(ownerLookupKey(catalog.slug, founder.name), companyOwner);
      }
    }
  }

  const resolve = (row) => {
    const author = nativeAuthorIdentity(row);
    if (!author) return { status: "unavailable", reason: "native_author_identity_unavailable" };
    const candidates = dedupeOwners(ownersByNativeAccount.get(`${author.platform}:${author.key}`) ?? []);
    if (candidates.length === 0) {
      return { status: "unmatched", reason: "native_author_not_in_canonical_roster", author };
    }
    if (candidates.length > 1) {
      return {
        status: "ambiguous",
        reason: "native_author_maps_to_multiple_canonical_owners",
        author,
        candidates: candidates.map(publicOwner)
      };
    }
    return {
      status: "matched",
      reason: "native_author_maps_to_unique_canonical_owner",
      author,
      owner: publicOwner(candidates[0]),
      company: candidates[0].company,
      founder: candidates[0].founder ?? null
    };
  };

  resolve.companyForRow = (row) => {
    const batchSlug = row?.batchSlug ?? row?.batch_slug;
    const identities = [
      row?.entityId,
      row?.entity_id,
      row?.attachedCompanyId,
      row?.companySlug,
      row?.company_slug,
      row?.companyName
    ].filter(Boolean);
    for (const identity of identities) {
      const companyOwner = companiesByBatchEntity.get(ownerLookupKey(batchSlug, identity));
      if (companyOwner) return companyOwner;
    }
    return null;
  };
  resolve.ownerIndex = ownersByNativeAccount;
  resolve.companyOwners = companyOwners;
  return resolve;
}

export function applyResolvedNativeAuthor(row, resolution) {
  if (resolution?.status !== "matched" || !resolution.owner) return { ...row };
  const owner = resolution.owner;
  const oldAttribution = publicAttribution(row);
  const changed =
    String(oldAttribution.batchSlug ?? "") !== String(owner.batchSlug) ||
    String(oldAttribution.entityType ?? "company") !== String(owner.entityType) ||
    String(oldAttribution.entityId ?? "") !== String(owner.entityId);
  return {
    ...row,
    batchSlug: owner.batchSlug,
    entityType: owner.entityType,
    entityId: owner.entityId,
    entityName: owner.entityName,
    companySlug: owner.companySlug,
    companyName: owner.companyName,
    nativeAuthorResolution: {
      status: "matched",
      author: resolution.author,
      owner,
      changed,
      ...(changed ? { previousAttribution: oldAttribution } : {})
    },
    attributionVersion: Math.max(2, Number(row?.attributionVersion ?? 0)),
    attributionStatus: "verified_native_author",
    attributionMode: "account_owner",
    attributionSignals: [...new Set([...(row?.attributionSignals ?? []), "unique_native_author"])].sort(),
    ...(changed
      ? {
          sourceEvidenceId: row?.sourceEvidenceId ?? row?.id ?? null,
          matchReason: `${row?.matchReason ?? "Public evidence candidate."} Canonical native-author resolution reassigned this physical post from ${oldAttribution.batchSlug ?? "unscoped"}/${oldAttribution.entityType ?? "company"}/${oldAttribution.entityId ?? "unknown"} to ${owner.batchSlug}/${owner.entityType}/${owner.entityId}.`
        }
      : {})
  };
}

export function publicAttribution(row) {
  return {
    batchSlug: row?.batchSlug ?? row?.batch_slug ?? null,
    entityType: row?.entityType ?? row?.entity_type ?? "company",
    entityId: row?.entityId ?? row?.entity_id ?? row?.attachedCompanyId ?? null,
    companySlug: row?.companySlug ?? row?.company_slug ?? null,
    companyName: row?.companyName ?? row?.company_name ?? null
  };
}

export function nativeAuthorIdentity(row) {
  const platform = normalizePlatform(row?.platform);
  if (!new Set(["x", "linkedin", "instagram"]).has(platform)) return null;
  let key = null;
  if (platform === "x") {
    key = xAuthorFromPostUrl(row?.sourceUrl ?? row?.canonicalUrl ?? row?.url) ??
      normalizeHandle(row?.authorHandle) ??
      accountIdentity("x", row?.accountUrl, null);
  } else if (platform === "linkedin") {
    key = linkedinNativeAuthorSlugFromUrl(row?.sourceUrl ?? row?.canonicalUrl ?? row?.url) ??
      linkedinNativeAuthorSlugFromPayload(row?.rawVisibleText) ??
      linkedinAuthorFromHandle(row?.authorHandle) ??
      accountIdentity("linkedin", row?.accountUrl, null);
  } else {
    key = normalizeHandle(row?.authorHandle) ?? accountIdentity("instagram", row?.accountUrl, null);
  }
  return key ? { platform, key } : null;
}

export function catalogCompanySlug(company) {
  try {
    const parts = new URL(company?.profileUrl).pathname.split("/").filter(Boolean);
    const index = parts.indexOf("companies");
    if (index >= 0 && parts[index + 1]) return parts[index + 1];
  } catch {
    // Fall through to stable source identity.
  }
  return String(company?.sourceKey ?? "")
    .replace(/^company-/, "")
    .replace(/^a16z-speedrun-006-/, "");
}

function indexOwnerAccounts(index, owner, accounts) {
  for (const account of accounts ?? []) {
    const platform = normalizePlatform(account?.platform);
    if (!new Set(["x", "linkedin", "instagram"]).has(platform)) continue;
    const key = accountIdentity(platform, account?.url, account?.handle);
    if (!key) continue;
    const indexKey = `${platform}:${key}`;
    index.set(indexKey, [...(index.get(indexKey) ?? []), owner]);
  }
}

function accountIdentity(platform, url, fallbackHandle) {
  if (platform === "linkedin") {
    return linkedinAccountSlugFromUrl(url) ?? linkedinAuthorFromHandle(fallbackHandle);
  }
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    if (parts[0]) return normalizeHandle(parts[0]);
  } catch {
    // Use the catalog's normalized handle below.
  }
  return normalizeHandle(fallbackHandle);
}

function xAuthorFromPostUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (!["x.com", "twitter.com", "mobile.twitter.com"].includes(host)) return null;
    const match = url.pathname.match(/^\/([^/]+)\/status\/\d+/i);
    return normalizeHandle(match?.[1]);
  } catch {
    return null;
  }
}

function linkedinAuthorFromHandle(value) {
  if (!value) return null;
  if (/^https?:/i.test(String(value))) return linkedinAccountSlugFromUrl(value);
  return normalizeHandle(String(value).replace(/^(?:in|company):/i, ""));
}

function normalizeHandle(value) {
  return String(value ?? "").trim().replace(/^@/, "").replace(/\/$/, "").toLowerCase() || null;
}

function normalizePlatform(value) {
  const platform = String(value ?? "").trim().toLowerCase();
  return platform === "twitter" ? "x" : platform;
}

function dedupeOwners(owners) {
  return [...new Map(owners.map((owner) => [
    `${owner.batchSlug}:${owner.entityType}:${owner.entityId}`,
    owner
  ])).values()];
}

function publicOwner(owner) {
  return {
    batchSlug: owner.batchSlug,
    entityType: owner.entityType,
    entityId: owner.entityId,
    entityName: owner.entityName,
    companySlug: owner.companySlug,
    companyName: owner.companyName,
    companyEntityId: owner.companyEntityId
  };
}

function ownerLookupKey(batchSlug, identity) {
  return `${String(batchSlug ?? "").trim().toUpperCase()}:${String(identity ?? "").trim().toLowerCase()}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
