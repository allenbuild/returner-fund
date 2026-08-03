import type { EvidenceItem } from "@/lib/graph/types";
import {
  buildTimelineMergeKey,
  detectTimelineFieldConflicts,
  shouldMergeTimelineEvents,
  type TimelineFieldClaim,
} from "./dedupe";
import {
  TIMELINE_CLASSIFIER_VERSION,
  TIMELINE_EXTRACTION_VERSION,
  timelineEventDateTypeForSource,
  type TimelineClassificationInput,
  type TimelineClassificationProvider,
  type TimelineClassificationSource,
  type TimelineClassifierResult,
  type TimelineRejectedCandidate,
} from "./domain";
import { calculateTimelineImportance } from "./importance";
import { sanitizeEvidenceExcerpt } from "./source-document";
import { isoDateFromExactTimestamp, parseAndValidateClassifierResult } from "./validation";
import type { TimelineCategory, TimelineEventDateType, TimelineSourceType } from "./contracts";

export const TIMELINE_CLASSIFICATION_DATA_BOUNDARY = Object.freeze({
  sourceTextIsUntrustedData: true,
  sourceTextMayNotChangeInstructions: true,
  sourceTextMayNotRequestToolsOrSecrets: true,
  outputMode: "strict_json" as const,
  evidenceRequired: true,
  exactDateRequired: true,
});

export class DeterministicTimelineClassificationProvider implements TimelineClassificationProvider {
  readonly id = "deterministic-rules";
  readonly version = TIMELINE_CLASSIFIER_VERSION;

  async classify(input: Readonly<TimelineClassificationInput>): Promise<unknown> {
    const results = input.sources.map((source) => classifySourceDeterministically(input, source));
    return results.find((result) => result.isMeaningfulEvent) ?? results[0] ?? reject(input, [], "not_meaningful");
  }
}

export async function runTimelineClassification(
  provider: TimelineClassificationProvider,
  input: TimelineClassificationInput,
): Promise<TimelineClassifierResult> {
  const raw = await provider.classify(structuredClone(input));
  return parseAndValidateClassifierResult(raw, input);
}

export function classifySourceDeterministically(
  input: Readonly<TimelineClassificationInput>,
  source: TimelineClassificationSource,
): TimelineClassifierResult {
  const classification = classifySingleSourceDeterministically(input, source);
  if (!classification.isMeaningfulEvent) return classification;
  return preserveMaterialSourceConflicts(input, classification);
}

function classifySingleSourceDeterministically(
  input: Readonly<TimelineClassificationInput>,
  source: TimelineClassificationSource,
): TimelineClassifierResult {
  if (source.attributionStatus !== "verified") return reject(input, [source.id], "source_not_verified");
  if (source.linkStatus === "invalid" || source.linkStatus === "blocked") return reject(input, [source.id], "source_not_direct");
  const date = source.publicationDatePrecision === "unknown" ? null : isoDateFromExactTimestamp(source.publicationTimestamp);
  if (!date) return reject(input, [source.id], "exact_date_unsupported");

  const text = sourceClaimText(source);
  const claim = directClaimWindow(text);
  const category = detectCategory(claim, source);
  if (!category) {
    return reject(input, [source.id], source.authorRelationship === "founder" ? "irrelevant_founder_activity" : "not_meaningful");
  }
  if (!sourceMatchesCompany(input, source, category, claim)) {
    return reject(input, [source.id], "company_match_uncertain");
  }
  if (!claimantMatchesCompany(input, source, category, claim)) {
    return reject(input, [source.id], "company_match_uncertain");
  }

  const title = neutralEventTitle(category, claim, source, input.company.name);
  const summary = oneSentenceSummary(source, input.company.name, title, claim);
  if (!title || !summary) return reject(input, [source.id], "unsupported_claim");
  const importance = calculateTimelineImportance({
    category,
    sourceQualityTier: source.sourceQualityTier,
    hasQuantitativeMagnitude: /(?:[$€£]|\b\d[\d,.]*\s*(?:%|k|m|b|million|billion|users?|customers?|arr|mrr)\b)/i.test(text),
    namedExternalOrganization: /\b(?:with|led by|backed by|customer|partner)\s+[A-Z]/.test(text),
    stateChange: ["founded", "funding", "acquisition", "merger", "pivot", "shutdown", "business_model"].includes(category),
  });
  const mergeKey = buildTimelineMergeKey({ companyId: input.company.id, category, eventDate: date, title });
  if (input.existingEventKeys.includes(mergeKey)) return reject(input, [source.id], "duplicate");

  const candidate = {
    isMeaningfulEvent: true as const,
    companyId: input.company.id,
    category,
    title,
    summary,
    eventDate: date,
    eventDateType: timelineEventDateTypeForSource(source),
    isMajor: importance.isMajor,
    importanceScore: importance.score,
    entityIds: [input.company.id],
    sourceIds: [source.id],
    mergeKey,
    evidence: [{
      sourceId: source.id,
      supports: ["title", "summary", "eventDate" as const],
      excerpt: source.evidenceExcerpt,
    }],
    conflicts: [],
    classifierVersion: TIMELINE_CLASSIFIER_VERSION,
    extractionVersion: TIMELINE_EXTRACTION_VERSION,
  };

  try {
    return parseAndValidateClassifierResult(candidate, input);
  } catch {
    return reject(input, [source.id], "unsupported_claim");
  }
}

function preserveMaterialSourceConflicts(
  input: Readonly<TimelineClassificationInput>,
  primary: Extract<TimelineClassifierResult, { isMeaningfulEvent: true }>,
): TimelineClassifierResult {
  const accepted = input.sources.map((source) => ({
    source,
    result: classifySingleSourceDeterministically(input, source),
  })).filter((item): item is {
    source: TimelineClassificationSource;
    result: Extract<TimelineClassifierResult, { isMeaningfulEvent: true }>;
  } => item.result.isMeaningfulEvent && comparableMaterialEvent(primary, item.result));
  if (accepted.length < 2) return primary;

  const claims: TimelineFieldClaim[] = accepted.flatMap(({ source, result }) =>
    materialFieldClaims(source, result)
  );
  const conflicts = detectTimelineFieldConflicts(claims);

  const selected = [...accepted].sort((left, right) =>
    eventDateTypeRank(left.result.eventDateType) - eventDateTypeRank(right.result.eventDateType)
      || left.source.sourceQualityTier - right.source.sourceQualityTier
      || left.source.id.localeCompare(right.source.id)
  )[0]!;
  const relatedSourceIds = [selected.source.id, ...accepted.map((item) => item.source.id)
    .filter((sourceId) => sourceId !== selected.source.id).sort()];
  const evidence = relatedSourceIds.map((sourceId) => {
    const item = accepted.find((candidate) => candidate.source.id === sourceId)!;
    const supports = new Set(item.result.evidence.flatMap((claim) => claim.supports));
    if (materialFieldClaims(item.source, item.result).some((claim) => claim.field !== "event_date")) {
      supports.add("quantitativeClaim");
    }
    return {
      sourceId,
      supports: [...supports],
      excerpt: item.source.evidenceExcerpt,
    };
  });
  const candidate = {
    ...selected.result,
    sourceIds: relatedSourceIds,
    evidence,
    conflicts,
  };
  return parseAndValidateClassifierResult(candidate, {
    ...input,
    sources: [...input.sources],
  });
}

function comparableMaterialEvent(
  left: Extract<TimelineClassifierResult, { isMeaningfulEvent: true }>,
  right: Extract<TimelineClassifierResult, { isMeaningfulEvent: true }>,
): boolean {
  if (left.category !== right.category) return false;
  const dayDistance = Math.abs(Date.parse(`${left.eventDate}T00:00:00Z`) - Date.parse(`${right.eventDate}T00:00:00Z`)) / 86_400_000;
  if (!Number.isFinite(dayDistance) || dayDistance > 14) return false;
  if (left.category === "funding") {
    const leftRound = fundingRound(left.title);
    const rightRound = fundingRound(right.title);
    return !leftRound || !rightRound || leftRound === rightRound;
  }
  if (["traction_milestone", "revenue_milestone", "user_milestone"].includes(left.category)) {
    const leftUnit = materialMagnitude(left.title)?.unit;
    const rightUnit = materialMagnitude(right.title)?.unit;
    // Quantitative milestones recur naturally. Different dated announcements
    // (100 users, then 200 users) are distinct events, not contradictory
    // evidence. Only same-day claims with the same unit are safe to aggregate
    // automatically as a potential field conflict.
    return dayDistance === 0 && Boolean(leftUnit && rightUnit && leftUnit === rightUnit);
  }
  return shouldMergeTimelineEvents({
    companyId: left.companyId,
    category: left.category,
    eventDate: left.eventDate,
    title: left.title,
  }, {
    companyId: right.companyId,
    category: right.category,
    eventDate: right.eventDate,
    title: right.title,
  });
}

function eventDateTypeRank(value: TimelineEventDateType): number {
  return value === "occurrence_date" ? 0 : value === "announcement_date" ? 1 : 2;
}

function materialFieldClaims(
  source: TimelineClassificationSource,
  result: Extract<TimelineClassifierResult, { isMeaningfulEvent: true }>,
): TimelineFieldClaim[] {
  // eventDate is the exact timestamp provenance established by the source.
  // Third-party articles published on different days are not contradictory
  // occurrence claims; only native event records are typed as occurrences.
  const claims: TimelineFieldClaim[] = [];
  if (result.category === "funding") {
    const amount = fundingAmount(`${result.title} ${result.summary}`);
    const round = fundingRound(`${result.title} ${result.summary}`);
    if (amount) claims.push({ field: "funding_amount", value: amount, sourceId: source.id, sourceQualityTier: source.sourceQualityTier });
    if (round) claims.push({ field: "funding_round", value: round, sourceId: source.id, sourceQualityTier: source.sourceQualityTier });
  } else if (["traction_milestone", "revenue_milestone", "user_milestone"].includes(result.category)) {
    const magnitude = materialMagnitude(`${result.title} ${result.summary}`);
    if (magnitude) claims.push({
      field: result.category === "revenue_milestone" ? "revenue_milestone" : result.category === "user_milestone" ? "user_milestone" : "traction_milestone",
      value: `${magnitude.value} ${magnitude.unit}`,
      sourceId: source.id,
      sourceQualityTier: source.sourceQualityTier,
    });
  }
  return claims;
}

function fundingAmount(value: string): string | null {
  return value.match(/[$€£]\s*\d[\d,.]*(?:\s*(?:k|m|b|million|billion))?/i)?.[0]
    ?.replace(/\s+/g, " ").trim() ?? null;
}

function fundingRound(value: string): string | null {
  return value.match(/\b(?:pre[- ]?seed|seed|series\s+[a-z]|growth)\b/i)?.[0]
    ?.toLowerCase().replace(/\s+/g, " ").replace("pre seed", "pre-seed") ?? null;
}

function materialMagnitude(value: string): { value: string; unit: string } | null {
  const match = value.match(/\b(\d[\d,.]*(?:\s*(?:k|m|b|million|billion))?\+?)\s*(arr|mrr|active users?|users?|signups?|downloads?|customers?|deployments?|transactions?|github stars?|stars?|developers?|members?|contributors?)\b/i);
  return match ? {
    value: match[1]!.replace(/\s+/g, " ").trim(),
    unit: match[2]!.toLowerCase().replace(/\s+/g, " ").trim(),
  } : null;
}

export function timelineClassificationSourceFromGraphEvidence(evidence: EvidenceItem): TimelineClassificationSource {
  const text = typeof evidence.text === "string"
    ? evidence.text
    : typeof evidence.title === "string"
      ? evidence.title
      : "";
  return {
    id: evidence.id,
    url: evidence.sourceUrl,
    title: evidence.title ?? null,
    publisher: evidence.authorHandle || evidence.authorName || null,
    sourceType: sourceTypeForEvidence(evidence),
    platform: evidence.platform,
    publicationTimestamp: evidence.postedAt || null,
    publicationDatePrecision: evidence.publishedAtPrecision ?? "unknown",
    text,
    evidenceExcerpt: sanitizeEvidenceExcerpt(text, 600),
    sourceQualityTier: evidence.entityType === "company" || evidence.entityType === "founder" ? 1 : 2,
    attributionStatus: evidence.review_state === "verified" ? "verified" : "needs_review",
    linkStatus: evidence.linkStatus ?? "unchecked",
    topic: evidence.topicClassification?.primaryTopic ?? evidence.topics?.[0] ?? null,
    authorRelationship: evidence.entityType === "founder" ? "founder" : evidence.entityType === "company" ? "company" : "unknown",
  };
}

function detectCategory(text: string, source: TimelineClassificationSource): TimelineCategory | null {
  const excludedRetrospective = /\b(?:anniversary|months? since|weeks? since|years? since|days? since)\b/i.test(text);
  const prospective = /\b(?:on track|aim(?:s|ing)?|goal|target|coming soon|launch(?:es|ing)? in \d+|will (?:launch|release|ship)|to become)\b/i.test(text);
  if (/\b(?:we (?:were|have been) acquired by|acquired by|has acquired us)\b/i.test(text)) return "acquisition";
  if (/\b(?:we(?:'re| are) shutting down|we shut down|shutting down (?:the|our)|ceasing operations|closing (?:the|our) company)\b/i.test(text)) return "shutdown";
  if (/\b(?:we (?:have )?pivoted|we(?:'re| are) pivoting|changed (?:our )?direction from)\b/i.test(text)) return "pivot";
  if (!excludedRetrospective
      && /^(?:We|I|we|i)\s+(?:founded|co-founded|started)\s+(?:the company|[A-Z@][\w.-]{2,})\b/.test(text)) return "founded";
  if (/\b(?:we|our company|i|[A-Z@][\w.-]+)\s+(?:were |was |have been |just |finally )?(?:accepted into|got into|joined)\s+(?:y combinator|yc\b|[A-Z][\w ]+ accelerator)\b/i.test(text)) return "accelerator";
  if (/\b(?:we |[A-Z@][\w.-]+ )?(?:have |has |just )?raised\b.{0,100}(?:[$€£]\s?\d|\b(?:pre-?seed|seed|series\s+[a-z]|funding|financing|round)\b)/i.test(text)
      || /\b(?:announced|closed)\b.{0,80}\b(?:pre-?seed|seed|series\s+[a-z]|funding|financing|round)\b/i.test(text)
      || /\b(?:announc(?:e|ed|es|ing)|closed)\b.{0,80}[$€£]\s?\d[\d,.]*(?:\s?(?:k|m|b|million|billion))?\s+(?:raise|funding|financing|round)\b/i.test(text)) return "funding";
  if (/\b(?:we|our (?:product|company|device|application))\b.{0,50}\b(?:received|secured|obtained|earned)\b.{0,30}\b(?:fda|regulatory)\s+(?:approval|clearance)\b/i.test(text)) return "regulatory";

  if (!prospective && !excludedRetrospective && hasExplicitAchievedMagnitude(text, "revenue")) return "revenue_milestone";
  if (!prospective && !excludedRetrospective && hasExplicitAchievedMagnitude(text, "users")) return "user_milestone";
  if (!prospective && !excludedRetrospective && hasExplicitAchievedMagnitude(text, "traction")) return "traction_milestone";

  if (/\b(?:we |[A-Z@][\w.-]+ )?(?:have )?(?:partnered|entered (?:a )?partnership) with\b/i.test(text)) return "partnership";
  if (/\b(?:we |[A-Z@][\w.-]+ )?(?:have |just )?(?:signed (?:our )?(?:first|largest|new) (?:enterprise )?customer|were selected by|deployed (?:at|with)|customer chose)\b/i.test(text)) return "customer";
  if (/\b(?:we(?:'re| are| just)? |i(?:'m| am)? )?(?:open[- ]sourc(?:ed|ing)|released .{1,80} as open source|open source release)\b/i.test(text)) return "open_source";
  if (/\b(?:we |[A-Z@][\w.-]+ )?(?:published|released)\b.{0,60}\b(?:paper|research|study|benchmark|dataset)\b/i.test(text)
      || /\bset (?:a|the) (?:new )?record\b.{0,80}\bbenchmark\b/i.test(text)) return "research";
  if (!excludedRetrospective && !prospective && isExplicitProductUpdate(text, source)) return "product_update";
  if (!excludedRetrospective && !prospective && isExplicitProductRelease(text, source)) return "product_launch";
  if (/\b(?:we )?(?:changed our pricing|introduced new pricing|pricing update)\b/i.test(text)) return "pricing";
  if (/\b(?:we )?(?:appointed|named)\s+[A-Z][\w .'-]+\s+(?:as|to)s+(?:ceo|cto|coo|president)\b/i.test(text)) return "leadership";
  if (/\b(?:we |[A-Z@][\w.-]+ )?(?:won|received)\b.{0,60}\baward\b/i.test(text)) return "award";
  return null;
}

function neutralEventTitle(
  category: TimelineCategory,
  text: string,
  source: TimelineClassificationSource,
  companyName: string,
): string | null {
  const amount = text.match(/[$€£]\s?\d[\d,.]*(?:\s?(?:k|m|b|million|billion))?/i)?.[0]?.replace(/\s+/g, "") ?? null;
  const round = text.match(/\b(?:pre-?seed|seed|series\s+[a-z]|growth)\s+(?:funding|financing|round)\b/i)?.[0]
    ?? text.match(/\b(?:pre-?seed|seed|series\s+[a-z])\b/i)?.[0]
    ?? null;
  let title: string | null = null;
  switch (category) {
    case "funding":
      title = `${companyName} announced ${[amount, round ?? "funding round"].filter(Boolean).join(" ")}`;
      break;
    case "accelerator": {
      const program = normalizeAcceleratorName(text.match(/\b(?:y combinator|yc)(?:\s+(?:[swp]\s?\d{2}|summer\s+\d{4}|winter\s+\d{4}|spring\s+\d{4}))?/i)?.[0] ?? "an accelerator");
      title = `${companyName} was accepted into ${program}`;
      break;
    }
    case "product_launch": {
      if (source.sourceType === "product_hunt") {
        const product = platformLaunchSubject(source.title ?? text, companyName, "product hunt");
        title = product
          ? `${companyName} launched ${product} on Product Hunt`
          : `${companyName} launched on Product Hunt`;
      }
      else if (/^launch hn\b/i.test(text)) title = `${companyName} launched on Hacker News`;
      else if (/\b(?:launch yc|y combinator(?:'s)? launch|live on (?:@?ycombinator|yc(?:'s)? socials?))\b/i.test(text)) title = `${companyName} launched on Y Combinator`;
      else if (/\blive on product hunt\b/i.test(text)) title = `${companyName} launched on Product Hunt`;
      else if (/\blaunch(?: demo)? video\b/i.test(`${source.title ?? ""} ${text}`)) {
        const product = platformLaunchSubject(source.title ?? text, companyName, "launch video");
        title = product
          ? `${companyName} launched ${product}`
          : `${companyName} announced its public launch`;
      }
      else if (/\b(?:available today|now live|general availability|public beta)\b/i.test(text)) title = `${companyName} became publicly available`;
      else {
        const product = extractReleasedSubject(text, companyName);
        const sourceSubject = product ?? meaningfulSourceSubject(source.title, companyName);
        if (sourceSubject) title = `${companyName} released ${sourceSubject}`;
        else if (new RegExp(`^(?:introducing|announcing)\\s+${escapeRegExp(companyName)}(?:[,.!—:;-]|$)`, "i").test(text)) {
          title = `${companyName} was introduced`;
        } else title = `${companyName} announced its public launch`;
      }
      break;
    }
    case "product_update": {
      const version = text.match(/\bv?\d+(?:\.\d+){1,3}\b/i)?.[0] ?? null;
      const supported = text.match(/\bnow supports\s+([^.!?]{2,80}?)(?=\s+(?:you|users?)\s+can now\b|[.!?]|$)/i)?.[1]?.trim() ?? null;
      const capability = text.match(/^([^.!?]{2,60}?)\s+can now\s+([^.!?]{2,80})(?:[.!?]|$)/i);
      if (version) title = `${companyName} released version ${version.replace(/^v/i, "")}`;
      else if (supported) title = `${companyName} added support for ${supported}`;
      else if (capability) title = `${companyName} enabled ${capability[1]!.trim()} to ${capability[2]!.trim()}`;
      else if (/drag your files\b.{0,80}\bstart chatting/i.test(text)) title = `${companyName} added drag-and-drop file chat`;
      else title = `${companyName} announced a product update`;
      break;
    }
    case "open_source": {
      const subject = extractReleasedSubject(text, companyName);
      title = subject ? `${companyName} released ${subject} as open source` : `${companyName} released an open-source project`;
      break;
    }
    case "revenue_milestone":
    case "user_milestone":
    case "traction_milestone": {
      const magnitude = extractMagnitude(text, category);
      if (!magnitude) return null;
      title = /^(?:almost|nearly|about|approximately|roughly|approaching|close to)\b/i.test(magnitude)
        ? `${companyName} reported ${magnitude}`
        : `${companyName} reached ${magnitude}`;
      break;
    }
    case "partnership": {
      const partner = text.match(/\b(?:partnered|partnership) with\s+([^,.!;]{2,70})/i)?.[1]?.trim();
      title = partner ? `${companyName} partnered with ${partner}` : `${companyName} announced a partnership`;
      break;
    }
    case "customer":
      title = /first\s+(?:enterprise\s+)?customer/i.test(text)
        ? `${companyName} signed its first enterprise customer`
        : `${companyName} announced a customer deployment`;
      break;
    case "acquisition": {
      const acquirer = text.match(/\bacquired by\s+([^,.!;]{2,70})/i)?.[1]?.trim();
      title = acquirer ? `${companyName} was acquired by ${acquirer}` : `${companyName} announced an acquisition`;
      break;
    }
    case "shutdown": title = `${companyName} announced it was shutting down`; break;
    case "pivot": title = `${companyName} announced a strategic pivot`; break;
    case "founded": title = `${companyName} was founded`; break;
    case "regulatory": title = `${companyName} received regulatory approval`; break;
    case "research": title = `${companyName} published new research`; break;
    case "pricing": title = `${companyName} changed its pricing`; break;
    case "leadership": title = `${companyName} announced a leadership appointment`; break;
    case "award": {
      const award = text.match(/\b(?:won|received)\s+(?:the\s+)?([^.!;]{2,80}?\baward)\b/i)?.[1]?.trim();
      title = award ? `${companyName} won the ${award}` : `${companyName} received an award`;
      break;
    }
    default: return null;
  }
  return boundAtWord(title.replace(/\s+/g, " ").trim(), 140);
}

function oneSentenceSummary(
  source: TimelineClassificationSource,
  companyName: string,
  title: string | null,
  claim: string,
): string | null {
  if (!title) return null;
  const raw = collapseRepeatedOpening(cleanClaimText(claim));
  if (raw.length < 6) return null;
  if (source.sourceType === "video" && /\blaunch(?: demo)? video\b/i.test(`${source.title ?? ""} ${raw}`)) {
    const product = platformLaunchSubject(source.title ?? raw, companyName, "launch video");
    return product
      ? `${companyName} introduced ${product} in a dated launch video.`
      : `${companyName} announced its public launch in a dated company video.`;
  }
  let summary = raw
    .replace(/^today\s*,?\s*we(?:'re| are)\s+/i, `${companyName} announced it was `)
    .replace(/^we(?:'re| are)\s+/i, `${companyName} is `)
    .replace(/^we(?:'ve| have)\s+/i, `${companyName} has `)
    .replace(/^we\s+/i, `${companyName} `)
    .replace(/^i am celebrating\s+/i, `${companyName} reported reaching `)
    .replace(/^i(?:'m| am)\s+/i, `${companyName} is `)
    .replace(/^hey[,!]?\s+i(?:'m| am)\s+/i, `${companyName} is `)
    .replace(/^introducing\s+/i, `${companyName} introduced `)
    .replace(/^announce that\s+/i, `${companyName} announced that `)
    .replace(/\s+You can now\s+/i, ", so users can now ")
    .replace(/\bfrom your phone\b/i, "from their phones");
  if (!containsIdentityText(summary, [companyName])) {
    const opening = /^[A-Z]{2}(?:\b|\s)/.test(summary) ? summary : `${summary.charAt(0).toLowerCase()}${summary.slice(1)}`;
    summary = `${companyName} reported ${opening}`;
  }
  const companyPattern = escapeRegExp(companyName);
  summary = summary
    .replace(new RegExp(`^${companyPattern} announced that ${companyPattern} has\\b`, "i"), `${companyName} announced it had`)
    .replace(new RegExp(`^${companyPattern} has reached (.+?) (?:in|at) ${companyPattern}\\b`, "i"), `${companyName} reached $1`);
  summary = boundAtWord(summary.replace(/\s+([,.;:])/g, "$1").replace(/,+\s*\.+$/, "").replace(/[.!?…]+$/, ""), 280)
    .replace(/[,;:]+$/, "");
  if (!summary || normalizeForComparison(summary) === normalizeForComparison(title)) {
    summary = `${companyName} confirmed the event in a dated public announcement`;
  }
  return `${summary.replace(/[.!?…]+$/, "")}.`;
}

function sourceMatchesCompany(
  input: Readonly<TimelineClassificationInput>,
  source: TimelineClassificationSource,
  category: TimelineCategory,
  claim: string,
): boolean {
  const identities = companyIdentityTerms(input);
  const haystack = `${source.publisher ?? ""} ${source.title ?? ""} ${source.text}`;
  if (containsIdentityText(haystack, identities)) return true;
  if (source.authorRelationship === "company") return true;
  if (source.authorRelationship !== "founder") return false;

  // A founder mapping by itself is not evidence that a post concerns this
  // company. The narrow fallback below is reserved for verified, direct,
  // first-person announcements whose subject is the mapped product and which
  // do not identify another company or product.
  if (source.linkStatus !== "verified" || hasAlternativeCompanyIdentity(source.text, identities)) return false;
  if (!/^(?:today\s+)?(?:we|we(?:'re|'ve)|our)\b/i.test(claim)) return false;
  return ["product_launch", "open_source", "accelerator", "funding", "customer", "partnership", "pivot", "shutdown", "regulatory"].includes(category);
}

function claimantMatchesCompany(
  input: Readonly<TimelineClassificationInput>,
  source: TimelineClassificationSource,
  category: TimelineCategory,
  claim: string,
): boolean {
  const claimantVerbs: Partial<Record<TimelineCategory, RegExp>> = {
    funding: /\b(?:raised|announc(?:e|ed|es|ing)|closed)\b/i,
    customer: /\b(?:signed|selected|deployed|onboarded)\b/i,
    partnership: /\b(?:partnered|partnering|partnership)\b/i,
    acquisition: /\b(?:acquired|acquisition)\b/i,
  };
  if (category === "product_launch") {
    const namedLauncher = claim.match(/^(?:(?:this week|today)[,\s]+)?(@?[A-Za-z0-9_.-]{2,80})\s+(?:has\s+|just\s+|is\s+)?(?:launched|released|shipped)\b/i)?.[1] ?? null;
    return !namedLauncher || /^(?:we|i)$/i.test(namedLauncher)
      || containsIdentityText(namedLauncher, companyIdentityTerms(input));
  }
  if (category === "product_update") {
    const namedSubject = claim.match(/^(@[A-Za-z0-9_.-]{2,80}|[A-Z][A-Za-z0-9_.-]{2,80})\s+(?:can now|now supports|has released)\b/i)?.[1] ?? null;
    if (!namedSubject || /^(?:AI|API)$/i.test(namedSubject)) return true;
    return containsIdentityText(namedSubject, companyIdentityTerms(input));
  }
  const verb = claimantVerbs[category];
  if (!verb) return true;
  const match = verb.exec(claim);
  if (!match || match.index < 0) return false;

  const identities = companyIdentityTerms(input);
  const beforeVerb = claim.slice(0, match.index).trim();
  if (category === "funding" && !beforeVerb && source.authorRelationship === "company"
      && /^announc(?:e|ed|es|ing)\s+our\b/i.test(claim)) {
    return true;
  }
  const immediateSubject = beforeVerb.match(/(?:^|\s)(@?[A-Za-z0-9_.-]{1,80}|the team|our company)\s+(?:has\s+)?$/i)?.[1] ?? null;
  if (immediateSubject) {
    if (/^(?:we|the team|our company)$/i.test(immediateSubject)) {
      return /\bwe\b/i.test(beforeVerb)
        || containsIdentityText(`${source.title ?? ""} ${source.text}`, identities);
    }
    return containsIdentityText(immediateSubject, identities);
  }
  return /\bwe\b/i.test(beforeVerb)
    || containsIdentityText(beforeVerb, identities)
    || (/\b(?:founder says )?the team\b/i.test(beforeVerb)
      && containsIdentityText(`${source.title ?? ""} ${source.text}`, identities));
}

function sourceClaimText(source: TimelineClassificationSource): string {
  const title = cleanClaimText(source.title ?? "");
  const body = cleanClaimText(source.text);
  if (!title) return sanitizeEvidenceExcerpt(body, 2_000);
  if (!body) return sanitizeEvidenceExcerpt(title, 2_000);
  const normalizedTitle = normalizeForComparison(title.replace(/…$/, ""));
  const normalizedBody = normalizeForComparison(body);
  if (normalizedBody === normalizedTitle || normalizedBody.startsWith(normalizedTitle)
      || normalizedTitle.slice(0, 80).length >= 40 && normalizedBody.startsWith(normalizedTitle.slice(0, 80))) {
    return sanitizeEvidenceExcerpt(body, 2_000);
  }
  return sanitizeEvidenceExcerpt(`${title}. ${body}`, 2_000);
}

function directClaimWindow(text: string): string {
  return cleanClaimText(firstSentence(text) ?? text).slice(0, 700);
}

const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const DECIMAL_POINT_SENTINEL = "\uE000";
function firstSentence(value: string): string | null {
  // Keep quantified claims intact even on runtimes whose sentence boundary
  // implementation treats a decimal point as terminal punctuation.
  const segmentable = value.replace(/(\d)\.(?=\d)/g, `$1${DECIMAL_POINT_SENTINEL}`);
  const segment = sentenceSegmenter.segment(segmentable)[Symbol.iterator]().next().value?.segment?.trim();
  return segment?.replaceAll(DECIMAL_POINT_SENTINEL, ".") || null;
}

function cleanClaimText(value: string): string {
  return decodeTextEntities(sanitizeEvidenceExcerpt(value, 2_000))
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/^(?:iMessage\s+)?(?:Quote|Reposted|Replying to)\s+.{1,120}?[·•]\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+/i, "")
    .replace(/https?:\s*\/\/\s*\S+(?:\s*\/\S+)*/gi, " ")
    .replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+/gu, "")
    .replace(/^(?:huge|exciting|incredible)\s+(?:news|update)[:!\s-]*/i, "")
    .replace(/^(?:we(?:'re| are)?\s+)?(?:excited|thrilled|proud)\s+to\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeTextEntities(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"',
  };
  return value.replace(/&(?:#(\d{1,7})|#x([a-f0-9]{1,6})|([a-z]{2,8}));/gi, (match, decimal, hexadecimal, name) => {
    if (name) return named[String(name).toLowerCase()] ?? match;
    const codePoint = Number.parseInt(decimal ?? hexadecimal, decimal ? 10 : 16);
    return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : match;
  });
}

function isExplicitProductRelease(text: string, source: TimelineClassificationSource): boolean {
  if (/\b(?:teammate|welcome\b|we(?:'re| are) hiring|i(?:'m| am) hiring|join (?:our|the) team|job opening|anniversary)\b/i.test(text)) return false;
  if (/\b(?:i am|i'm|i got|i am being|i'm being) shipped\b/i.test(text)) return false;
  if (source.sourceType === "product_hunt") {
    return /\/launches\//i.test(source.url)
      || (!/\b(?:ask me anything|\bama\b)\b/i.test(text) && /\b(?:launch|launched|now live)\b/i.test(text));
  }
  if (/^launch hn\s*:/i.test(text)) return true;
  if (source.sourceType === "video" && /\b(?:launch(?: video)?|launch yc|yc launch)\b/i.test(text)) return true;
  if (/^(?:launching\s+\S+|[A-Z@][\w.-]+\s+(?:just\s+)?(?:launched|is launching)\b)/i.test(text)) return true;
  if (/^(?:this week\s*,?\s*)?[A-Z@][\w.-]+\s+(?:just\s+)?launched\s+\S+/i.test(text)) return true;
  if (/^(?:today\s+)?(?:we|i|[A-Z@][\w.-]+)\s+(?:just |today )?(?:launched|released|shipped)\s+(?:our |a |an |the )?\S+/i.test(text)) return true;
  if (/^(?:today\s+)?we(?:'re| are)\s+(?:launching|releasing|shipping)\s+(?:our |a |an |the )?\S+/i.test(text)) return true;
  if (/^(?:introducing|announcing)\s+(?![@\w.-]+\s+(?:teammate|employee|hire)\b).{2,500}/i.test(text)) return true;
  if (/^(?:we|[A-Z@][\w.-]+)\s+(?:are|is)\s+(?:officially\s+)?live\b/i.test(text)) return true;
  if (/\b(?:available today|went live today|now live|public beta|general availability)\b/i.test(text)
      && /(?:@[a-z0-9_]{3,}|\b(?:product|app|platform|software|model|api|feature|version|v\d)\b)/i.test(text)) return true;
  if (/^(?:excited|proud) to launch\s+\S+/i.test(text)) return true;
  return false;
}

function isExplicitProductUpdate(text: string, source: TimelineClassificationSource): boolean {
  if (/\b(?:teammate|hiring|join (?:our|the) team|anniversary)\b/i.test(text)) return false;
  if (/^(?:we|[A-Z@][\w.-]+)\s+(?:just\s+)?(?:shipped|released|launched)\s+(?:a|the|our)?\s*(?:new|major|big|crazy|significant|substantial)?\s*(?:update|feature|version|v\d)\b/i.test(text)) return true;
  if (/\b(?:new feature release|version\s+v?\d+(?:\.\d+)+|v\d+(?:\.\d+)+\s+(?:is\s+)?(?:live|released))\b/i.test(text)) return true;
  if (source.authorRelationship === "company"
      && (/^[^.!?]{2,100}\bcan now\b/i.test(text) || /\bnow supports\b/i.test(text))) return true;
  if (/\bavailable now\b/i.test(text)
      && /\b(?:feature|version|integration|support|files?|model|api)\b/i.test(text)) return true;
  return false;
}

function hasExplicitAchievedMagnitude(text: string, kind: "revenue" | "users" | "traction"): boolean {
  if (/\b(?:single[- ]day|one[- ]day|daily|per day|in (?:a |one )?day|in 24 hours?|over 24 hours?)\b/i.test(text)) return false;
  const unit = kind === "revenue"
    ? "(?:arr|mrr|revenue)"
    : kind === "users"
      ? "(?:active users?|users?|signups?|downloads?)"
      : "(?:customers?|deployments?|transactions?|github stars?|stars?|developers?|members?|contributors?)";
  const magnitude = `(?:[$€£]\\s*)?\\d[\\d,.]*(?:\\s*(?:k|m|b|million|billion))?\\+?\\s*(?:%\\s*)?${unit}`;
  const achieved = "(?:reached|hit|crossed|surpassed|exceeded|grew to|has reached|have reached|now (?:has|serves)|now at|celebrat(?:ed|ing))";
  if (new RegExp(`${achieved}.{0,90}${magnitude}`, "i").test(text)) return true;
  return new RegExp(`^${magnitude}.{0,50}\\b(?:already|to date|so far|and counting)\\b`, "i").test(text)
    || new RegExp(`^${magnitude}(?:[.!]|$)`, "i").test(text);
}

function extractMagnitude(text: string, category: "revenue_milestone" | "user_milestone" | "traction_milestone"): string | null {
  const unit = category === "revenue_milestone"
    ? "(?:ARR|MRR|revenue)"
    : category === "user_milestone"
      ? "(?:active users?|users?|signups?|downloads?)"
      : "(?:customers?|deployments?|transactions?|GitHub stars?|stars?|developers?|members?|contributors?)";
  return text.match(new RegExp(`(?:(?:almost|nearly|about|approximately|roughly|approaching|close to)\\s+)?(?:[$€£]\\s*)?\\d[\\d,.]*(?:\\s*(?:k|m|b|million|billion))?\\+?\\s*(?:%\\s*)?${unit}`, "i"))?.[0]
    ?.replace(/\s+/g, " ").trim() ?? null;
}

function meaningfulSourceSubject(value: string | null, companyName: string): string | null {
  if (!value) return null;
  let subject = cleanClaimText(value)
    .replace(/^(?:launch(?:ing)?|introducing|announcing)\s*[:—-]?\s*/i, "")
    .replace(/\s*(?:\||—|-)?\s*(?:launch video|launch hn|product hunt)\s*$/i, "")
    .replace(/[.!?…]+$/, "")
    .trim();
  if (!subject || subject.length < 4 || subject.length > 72) return null;
  if (/^(?:launch video|launch hn|product launch|new product|now live|general availability)$/i.test(subject)) return null;
  if (normalizeForComparison(subject) === normalizeForComparison(companyName)) return null;
  if (new RegExp(`^(?:we|i)?\\s*(?:just\\s+)?(?:launched|released|shipped|introduced)\\s+@?${escapeRegExp(companyName)}(?:[,.!—:;-]|$)`, "i").test(subject)) return null;
  if (/\b(?:huge|exciting|incredible|best|biggest|revolutionary)\b/i.test(subject)) return null;
  subject = subject.replace(/^@/, "").replace(/\s+/g, " ");
  return boundAtWord(subject, 72);
}

function platformLaunchSubject(
  value: string | null,
  companyName: string,
  kind: "launch video" | "product hunt",
): string | null {
  if (!value) return null;
  let subject = cleanClaimText(value)
    .replace(/^launch hn\s*:\s*/i, "")
    .replace(/\s*[|—:]\s*(?:yc\s*)?(?:product\s+)?launch(?:\s+(?:demo\s+)?video)?\s*$/i, "")
    .replace(kind === "launch video"
      ? /\s*(?:[-—|:]\s*)?(?:yc\s*)?(?:product\s+)?launch(?:\s+demo)?\s+video\s*$/i
      : /\s*(?:[-—|:]\s*)?product\s+hunt\s+launch\s*$/i, "")
    .replace(/\s*\((?:yc\s*)?[swp]\s?\d{2}\)\s*/gi, " ")
    .replace(/\s*\b(?:yc\s*)?[swp]\s?\d{2}\b\s*/gi, " ")
    .replace(/\s*[-—|:]\s*(?:y[- ]?combinator|yc)\s*$/i, "")
    .replace(/\s*[|—:]\s*$/g, "")
    .trim();
  if (kind === "product hunt") {
    subject = subject.split(/\s+(?:[-—|:]\s+)/, 1)[0]?.trim() ?? subject;
  }
  const normalizedCompany = normalizeForComparison(companyName);
  const normalizedCompanyCore = normalizedCompany.replace(/\s+(?:inc|incorporated|corp|corporation|ltd|llc)$/i, "");
  let normalizedSubject = normalizeForComparison(subject);
  if (normalizedSubject === normalizedCompany || normalizedSubject === normalizedCompanyCore) return null;
  if (new RegExp(`^${escapeRegExp(companyName)}\\s+`, "i").test(subject)) {
    subject = subject.replace(new RegExp(`^${escapeRegExp(companyName)}\\s+`, "i"), "").trim();
    normalizedSubject = normalizeForComparison(subject);
  }
  if (!subject || !normalizedSubject || normalizedSubject === normalizedCompany || normalizedSubject === normalizedCompanyCore
      || /^(?:launch|launch video|product launch|demo|yc|y combinator)$/i.test(subject)
      || /\blaunch(?: demo)? video\b/i.test(subject)
      || subject.length > 72) return null;
  return boundAtWord(subject.replace(/^@/, "").replace(/\s+/g, " "), 72);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractReleasedSubject(text: string, companyName: string): string | null {
  const normalizedText = text.replace(/^(?:hey[,!]?)\s+/i, "");
  const match = normalizedText.match(/^(?:today\s+)?(?:we(?:'re| are)?|i(?:'m| am)?|[A-Z@][\w.-]+)?\s*(?:just |today )?(?:are |'re )?(?:introducing|announcing|launching|launched|releasing|released|shipping|shipped|open[- ]sourcing|open[- ]sourced)\s+(?:our |a |an |the )?(.+)$/i)
    ?? text.match(/^(?:introducing|announcing)\s+(.+)$/i);
  let subject = match?.[1]?.trim() ?? null;
  if (!subject) return null;
  subject = subject.split(/\s+(?:today|now|for|with|that|which|so|because|imagine|powered by|it (?:lets|allows|helps|can|is)|(?:a|an) (?:browser|platform|tool|app|application|product|feature)|the (?:first|most))\b|[:,;.!…—]/i, 1)[0]?.trim() ?? "";
  subject = subject.replace(/^@/, "").replace(/[#@][a-z0-9_]+/gi, "").replace(/\s+/g, " ")
    .replace(/\s+(?:to|by|for|with|and|or)$/i, "").trim();
  if (!subject || /^(?:it|this|something|stuff|me|on|today|now)$/i.test(subject)
      || /\b(?:world['’]s|best|biggest|most|frontier|breakthrough|crazy)\b/i.test(subject)) return null;
  const normalizedSubject = normalizeForComparison(subject);
  const normalizedCompany = normalizeForComparison(companyName);
  if (normalizedSubject === normalizedCompany) return null;
  if (normalizedSubject.startsWith(`${normalizedCompany} `)) {
    const suffix = normalizedSubject.slice(normalizedCompany.length + 1);
    if (!/^(?:[a-z]?\d+(?:\.\d+)*|v\d+(?:\.\d+)*|pro|sdk|api)\b/i.test(suffix)) return null;
  }
  return boundAtWord(subject, 72);
}

function collapseRepeatedOpening(value: string): string {
  const words = value.split(/\s+/);
  const normalized = words.map((word) => normalizeForComparison(word));
  const maximum = Math.min(16, Math.floor(words.length / 2));
  for (let length = maximum; length >= 3; length -= 1) {
    if (normalized.slice(0, length).join(" ") === normalized.slice(length, length * 2).join(" ")) {
      return words.slice(length).join(" ");
    }
  }
  return value;
}

function companyIdentityTerms(input: Readonly<TimelineClassificationInput>): string[] {
  const terms = new Set<string>([input.company.name, ...input.company.aliases]);
  if (input.company.websiteUrl) {
    try { terms.add(new URL(input.company.websiteUrl).hostname.replace(/^www\./, "").split(".")[0] ?? ""); } catch { /* invalid upstream URL cannot establish identity */ }
  }
  for (const value of [...terms]) {
    const compact = normalizeForComparison(value).replace(/\s+/g, "");
    const core = compact.replace(/(?:labs?|ai|inc|technologies|technology|robotics)$/i, "");
    if (core.length >= 4) terms.add(core);
    if (/^hey[a-z0-9]{4,}$/i.test(compact)) terms.add(compact.slice(3));
  }
  return [...terms].filter((value) => normalizeForComparison(value).replace(/\s+/g, "").length >= 3);
}

function containsIdentityText(value: string, identities: readonly string[]): boolean {
  const normalizedValue = normalizeForComparison(value);
  const spaced = ` ${normalizedValue} `;
  const tokens = new Set(normalizedValue.split(" ").filter(Boolean));
  return identities.some((identity) => {
    const normalized = normalizeForComparison(identity);
    if (!normalized) return false;
    // Match a phrase at normalized word boundaries, or its exact compact form
    // as one token (for handles/domains such as "graphifylabs"). A substring
    // scan over the entire compact document falsely attributed common short
    // company names such as Ara to claimants such as Paragon.
    return spaced.includes(` ${normalized} `) || tokens.has(normalized.replace(/\s+/g, ""));
  });
}

function hasAlternativeCompanyIdentity(value: string, identities: readonly string[]): boolean {
  const ignored = new Set(["today", "first", "windows", "github", "product", "launch", "openai", "anthropic", "claude", "google"]);
  for (const match of value.matchAll(/\b([A-Z][A-Za-z0-9.-]{2,})\s+(?:gives|builds|raised|launches|launched|released|is)\b/g)) {
    const token = match[1]!;
    if (!ignored.has(token.toLowerCase()) && !containsIdentityText(token, identities)) return true;
  }
  for (const match of value.matchAll(/\b([a-z0-9-]{3,})\s*(?:\[dot\]|\.)\s*(?:ai|com|io)\b/gi)) {
    if (!containsIdentityText(match[1]!, identities)) return true;
  }
  return false;
}

function normalizeAcceleratorName(value: string): string {
  return value.replace(/^yc\b/i, "Y Combinator").replace(/\b([swp])\s?(\d{2})\b/i, (_, season: string, year: string) => `${season.toUpperCase()}${year}`);
}

function normalizeForComparison(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9$%]+/g, " ").replace(/\s+/g, " ").trim();
}

function boundAtWord(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const truncated = value.slice(0, maximum - 1).replace(/\s+\S*$/, "").trim();
  return `${truncated || value.slice(0, maximum - 1)}…`;
}

function sourceTypeForEvidence(evidence: EvidenceItem): TimelineSourceType {
  if (evidence.platform === "github") return evidence.mediaType === "repo" ? "github_repository" : "github_release";
  if (evidence.platform === "product_hunt") return "product_hunt";
  if (evidence.platform === "youtube") return "video";
  return evidence.entityType === "founder" ? "founder_post" : "company_post";
}

function reject(
  input: Readonly<TimelineClassificationInput>,
  sourceIds: string[],
  reason: TimelineRejectedCandidate["reason"],
): TimelineRejectedCandidate {
  return {
    isMeaningfulEvent: false,
    companyId: input.company.id,
    sourceIds,
    reason,
    classifierVersion: TIMELINE_CLASSIFIER_VERSION,
    extractionVersion: TIMELINE_EXTRACTION_VERSION,
  };
}
