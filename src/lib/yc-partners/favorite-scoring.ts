import { canonicalPostKey, dedupeEvidenceForScoring } from "@/lib/graph/dedupe";
import { originalEvidenceText, splitVerbatimSentences } from "@/lib/graph/verbatim-evidence-text";
import type { EvidenceItem, Platform, TopVoiceMember } from "@/lib/graph/types";

export const YC_PARTNER_FAVORITE_MODEL_VERSION = "conviction-v1";
export const YC_PARTNER_FAVORITE_MODEL_NAME = "YC partner conviction score";

export type FavoriteSignalType =
  | "explicit_superlative"
  | "strong_conviction"
  | "substantive_praise"
  | "positive_commentary"
  | "neutral_mention"
  | "negative_commentary"
  | "unclear";

export type FavoriteConfidenceLevel = "low" | "medium" | "high";

export interface FavoriteEvidenceAnalysis {
  evidenceId: string;
  physicalPostKey: string;
  signalType: FavoriteSignalType;
  score: number;
  convictionStrength: number;
  praiseStrength: number;
  specificity: number;
  contextQuality: number;
  negativePenalty: number;
  reason: string;
  excerpt: string;
  verbatimContributingSentences: string[];
  /** Backwards-compatible alias for existing consumers. */
  contributingSentences: string[];
  platform: Platform;
  postedAt: string;
  sourceUrl: string;
}

export interface FavoriteScoreBreakdown {
  strongestEvidenceScore: number;
  secondaryEvidenceBonus: number;
  independentContextBonus: number;
  negativePenalty: number;
  convictionStrength: number;
  praiseStrength: number;
  specificity: number;
  contextQuality: number;
  uniqueEvidenceCount: number;
  uniquePlatformCount: number;
  uniqueContextCount: number;
  signalTypes: FavoriteSignalType[];
}

export interface FavoriteConfidence {
  level: FavoriteConfidenceLevel;
  score: number;
  reasons: string[];
  uniqueEvidenceCount: number;
  uniquePlatformCount: number;
  uniqueContextCount: number;
  datedEvidenceCount: number;
  verifiedLinkCount: number;
}

export interface FavoriteCitation {
  evidenceId: string;
  sourceUrl: string;
  platform: Platform;
  postedAt: string;
  excerpt: string;
  verbatimContributingSentences?: string[];
  contributingSentences?: string[];
  reason: string;
  signalType: FavoriteSignalType;
  scoreContribution: number;
}

export interface FavoritePairScore {
  score: number;
  confidence: FavoriteConfidence;
  primaryReason: string;
  citations: FavoriteCitation[];
  breakdown: FavoriteScoreBreakdown;
  analyses: FavoriteEvidenceAnalysis[];
}

const MAX_CITATIONS = 5;
const MAX_SCORE = 100;

const SUPERLATIVE_PATTERNS = [
  /\b(?:the|an?)\s+(?:best|strongest|greatest|most impressive|most exciting)\b/i,
  /\b(?:arguably|easily|by far)\s+(?:the|one of the)\b/i,
  /\bhard to think of a better\b/i,
  /\b(?:can't|cannot|couldn't|could not)\s+(?:think of|imagine)\s+(?:a\s+)?better\b/i,
  /\b(?:my money|my bet|i(?:'m| am) betting)\s+is on\b/i,
  /\b(?:my|our|one of my|personal)\s+(?:favorite|favourite)\s+(?:startups?|companies?|teams?|founders?|investments?)\b/i,
  /\b(?:favorite|favourite)\s+(?:startup|company|team|founder|investment|portfolio)\b/i,
  /\bworld[- ]class\b/i,
  /\btightest\s+founder[- ]market\s+fit\b/i
];

const STRONG_CONVICTION_PATTERNS = [
  /\b(?:incredible|exceptional|remarkable|amazing|outstanding|special|rare|phenomenal)\b/i,
  /\b(?:i(?:'m| am)\s+)?(?:very\s+)?excited\s+(?:about|for|to)\b/i,
  /\b(?:this|they|it)\s+(?:is|are|will be|going to be)\s+(?:big|huge|important|a winner)\b/i,
  /\b(?:love|loved|really like|strongly believe|highly recommend)\b/i,
  /\b(?:can't|cannot)\s+wait\b/i,
  /\b(?:a|the)?\s*(?:real|genuine)?\s*pleasure\s+working\s+with\b/i,
  /\b(?:unusual|exceptional|excellent|great|strong)\s+(?:product\s+)?taste\b/i,
  /\b(?:i|we)\s+think\s+(?:it(?:'s| is)|they(?:'re| are))\b/i,
  /\b(?:every|any)\s+team\s+should\s+use\b/i
];

const SPECIFICITY_TERMS = [
  "founder",
  "founders",
  "team",
  "market",
  "product",
  "technology",
  "technical",
  "customer",
  "distribution",
  "revenue",
  "growth",
  "traction",
  "fit",
  "moat",
  "platform",
  "infrastructure",
  "hardware",
  "software",
  "engineering",
  "scientific",
  "industrial",
  "quantum",
  "diamonds"
];

const POSITIVE_PATTERNS = [
  /\b(?:congrats|congratulations)\b/i,
  /\b(?:check out|introducing|launching|built by|backed by)\b/i,
  /\b(?:cool|great|good|impressive|promising|excited)\b/i,
  /\b(?:worth|should|will)\s+(?:watching|know|win|matter)\b/i
];

const NEGATIVE_PATTERNS = [
  /\b(?:concerned|skeptical|skepticism|worried|worry|doubt|doubts)\b/i,
  /\b(?:not sure|isn't clear|is not clear|question whether|unlikely)\b/i,
  /\b(?:bad|weak|poor|disappointing|risky)\b/i,
  /\b(?:fails?|failure)\s+(?:to|at|against|on|with)\b/i,
  /\b(?:problem|risk)\s+(?:with|for|is)\b/i,
  /\b(?:wouldn't|would not|won't|will not)\s+(?:bet|back|recommend)\b/i,
  /\b(?:least|worst)\s+(?:favorite|favourite)\b/i,
  /\bnot\s+(?:the\s+)?best\b/i
];

const NEUTRAL_PATTERNS = [
  /^(?:congrats|congratulations|nice|wow|cool)[!.\s]*$/i,
  /^(?:@?[a-z0-9_]+\s*){1,3}$/i,
  /\b(?:tagging|cc)\b/i
];

export function scoreFavoritePair(
  partner: TopVoiceMember,
  evidence: EvidenceItem[]
): FavoritePairScore {
  const uniqueEvidence = dedupeFavoriteEvidence(evidence)
    .filter((item) => Boolean(originalEvidenceText(item)));
  const analyses = uniqueEvidence
    .map(analyzeFavoriteEvidence)
    .sort(compareAnalyses);
  const strongest = analyses[0];
  const positiveAnalyses = analyses.filter((analysis) => analysis.signalType !== "negative_commentary");
  const negativePenalty = analyses
    .filter((analysis) => analysis.signalType === "negative_commentary")
    .reduce((sum, analysis) => sum + Math.min(8, analysis.negativePenalty), 0);
  const secondaryEvidenceBonus = Math.min(
    16,
    positiveAnalyses.slice(1, 6).reduce((sum, analysis, index) => sum + Math.max(2, 7 - index), 0)
  );
  const uniqueContexts = new Set(analyses.map((analysis) => analysis.physicalPostKey));
  const independentContextBonus = Math.min(8, Math.max(0, uniqueContexts.size - 1) * 2);
  const score = strongest
    ? clamp(
        strongest.score + secondaryEvidenceBonus + independentContextBonus - negativePenalty,
        1,
        MAX_SCORE
      )
    : 0;

  const breakdown: FavoriteScoreBreakdown = {
    strongestEvidenceScore: strongest?.score ?? 0,
    secondaryEvidenceBonus,
    independentContextBonus,
    negativePenalty,
    convictionStrength: strongest?.convictionStrength ?? 0,
    praiseStrength: strongest?.praiseStrength ?? 0,
    specificity: strongest?.specificity ?? 0,
    contextQuality: strongest?.contextQuality ?? 0,
    uniqueEvidenceCount: uniqueEvidence.length,
    uniquePlatformCount: new Set(analyses.map((analysis) => analysis.platform)).size,
    uniqueContextCount: uniqueContexts.size,
    signalTypes: [...new Set(analyses.map((analysis) => analysis.signalType))]
  };

  return {
    score,
    confidence: confidenceFor(partner, uniqueEvidence, analyses, breakdown),
    primaryReason: strongest?.reason ?? "No attributable partner commentary was found.",
    citations: analyses.slice(0, MAX_CITATIONS).map((analysis) => ({
      evidenceId: analysis.evidenceId,
      sourceUrl: safeCitationUrl(analysis.sourceUrl),
      platform: analysis.platform,
      postedAt: safeCitationDate(analysis.postedAt),
      excerpt: analysis.excerpt,
      verbatimContributingSentences: analysis.verbatimContributingSentences,
      contributingSentences: analysis.contributingSentences,
      reason: analysis.reason,
      signalType: analysis.signalType,
      scoreContribution: analysis.score
    })),
    breakdown,
    analyses
  };
}

export function analyzeFavoriteEvidence(item: EvidenceItem): FavoriteEvidenceAnalysis {
  const originalText = originalEvidenceText(item);
  const text = normalizedEvidenceText(originalText);
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const superlative = SUPERLATIVE_PATTERNS.some((pattern) => pattern.test(text));
  const strongConviction = STRONG_CONVICTION_PATTERNS.some((pattern) => pattern.test(text));
  const positive = POSITIVE_PATTERNS.some((pattern) => pattern.test(text));
  const negative = NEGATIVE_PATTERNS.some((pattern) => pattern.test(text));
  const neutral = NEUTRAL_PATTERNS.some((pattern) => pattern.test(text)) || wordCount <= 4;
  const specificity = Math.min(
    100,
    new Set(SPECIFICITY_TERMS.filter((term) => new RegExp(`\\b${term}\\b`, "i").test(text))).size * 18 +
      (wordCount >= 24 ? 20 : wordCount >= 12 ? 10 : 0)
  );
  const contextQuality = Math.min(
    100,
    (item.topVoice?.matchedBy ? 55 : 35) +
      (item.attachedCompanyId ? 30 : 0) +
      (item.linkStatus === "verified" ? 15 : 0)
  );

  let signalType: FavoriteSignalType;
  if (negative && !superlative && !strongConviction) signalType = "negative_commentary";
  else if (superlative) signalType = "explicit_superlative";
  else if (strongConviction) signalType = "strong_conviction";
  else if (specificity >= 36 && positive) signalType = "substantive_praise";
  else if (positive) signalType = "positive_commentary";
  else if (neutral) signalType = "neutral_mention";
  else signalType = "unclear";
  const verbatimContributingSentences = selectContributingSentences(originalText, signalType, specificity);

  const baseScore: Record<FavoriteSignalType, number> = {
    explicit_superlative: 78,
    strong_conviction: 65,
    substantive_praise: 52,
    positive_commentary: 38,
    neutral_mention: 20,
    negative_commentary: 7,
    unclear: 12
  };
  const convictionStrength = signalType === "explicit_superlative"
    ? 100
    : signalType === "strong_conviction"
      ? 84
      : signalType === "substantive_praise"
        ? 66
        : signalType === "positive_commentary"
          ? 45
          : signalType === "neutral_mention"
            ? 20
            : signalType === "negative_commentary"
              ? 5
              : 12;
  const praiseStrength = Math.min(
    100,
    (superlative ? 65 : 0) + (strongConviction ? 32 : 0) + (positive ? 18 : 0) + Math.round(specificity * 0.18)
  );
  const negativePenalty = negative ? (strongConviction || superlative ? 4 : 18) : 0;
  const score = clamp(
    baseScore[signalType] +
      Math.round(specificity * 0.12) +
      (wordCount >= 18 ? 4 : 0) +
      (contextQuality >= 85 ? 3 : 0) -
      negativePenalty,
    1,
    MAX_SCORE
  );

  return {
    evidenceId: item.id,
    physicalPostKey: canonicalPostKey(item),
    signalType,
    score,
    convictionStrength,
    praiseStrength,
    specificity,
    contextQuality,
    negativePenalty,
    reason: reasonFor(signalType, specificity),
    excerpt: excerptFor(originalText),
    verbatimContributingSentences,
    contributingSentences: verbatimContributingSentences,
    platform: item.platform,
    postedAt: item.postedAt,
    sourceUrl: item.sourceUrl
  };
}

/**
 * The graph-level deduper is platform-aware. Favorite inference also needs to
 * collapse an exact partner-authored cross-post, while keeping distinct short
 * mentions (for example, several separate "Kara" posts) independent.
 */
function dedupeFavoriteEvidence(items: EvidenceItem[]): EvidenceItem[] {
  const platformDeduped = dedupeEvidenceForScoring(items);
  const byPhysicalPost = new Map<string, EvidenceItem>();

  for (const item of platformDeduped) {
    const key = crossPostKey(item) ?? canonicalPostKey(item);
    const existing = byPhysicalPost.get(key);
    if (!existing || compareEvidencePreference(item, existing) < 0) {
      byPhysicalPost.set(key, item);
    }
  }

  return [...byPhysicalPost.values()].sort(compareEvidenceForDeterministicScoring);
}

function crossPostKey(item: EvidenceItem): string | null {
  const text = normalizedEvidenceText(originalEvidenceText(item))
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (text.length < 12) return null;

  const author = (item.topVoice?.memberId || item.authorHandle || item.authorName)
    .trim()
    .toLocaleLowerCase();
  const postedAtTimestamp = comparableTimestamp(item.postedAt);
  if (!author || postedAtTimestamp === Number.MIN_SAFE_INTEGER) return null;

  return `cross-post:${author}:${new Date(postedAtTimestamp).toISOString().slice(0, 10)}:${text}`;
}

function compareEvidencePreference(left: EvidenceItem, right: EvidenceItem): number {
  const leftPriority = evidencePreference(left);
  const rightPriority = evidencePreference(right);
  return rightPriority - leftPriority || left.id.localeCompare(right.id);
}

function evidencePreference(item: EvidenceItem): number {
  return (item.review_state === "verified" ? 16 : 0) +
    (item.linkStatus === "verified" ? 8 : 0) +
    (item.publishedAtPrecision === "exact" ? 4 : item.publishedAtPrecision === "day" ? 2 : 0) +
    (Number.isFinite(Date.parse(item.postedAt)) ? 1 : 0);
}

function compareEvidenceForDeterministicScoring(left: EvidenceItem, right: EvidenceItem): number {
  const leftContribution = Number.isFinite(left.contributionScore) ? left.contributionScore : 0;
  const rightContribution = Number.isFinite(right.contributionScore) ? right.contributionScore : 0;
  return comparableTimestamp(right.postedAt) - comparableTimestamp(left.postedAt) ||
    rightContribution - leftContribution ||
    left.id.localeCompare(right.id);
}

function confidenceFor(
  partner: TopVoiceMember,
  evidence: EvidenceItem[],
  analyses: FavoriteEvidenceAnalysis[],
  breakdown: FavoriteScoreBreakdown
): FavoriteConfidence {
  if (evidence.length === 0 || analyses.length === 0) {
    return {
      level: "low",
      score: 0,
      reasons: ["Verbatim partner-authored source text is unavailable."],
      uniqueEvidenceCount: 0,
      uniquePlatformCount: 0,
      uniqueContextCount: 0,
      datedEvidenceCount: 0,
      verifiedLinkCount: 0
    };
  }
  const uniquePlatforms = new Set(evidence.map((item) => item.platform));
  const uniqueContexts = new Set(analyses.map((analysis) => analysis.physicalPostKey));
  const datedEvidenceCount = evidence.filter((item) => Number.isFinite(Date.parse(item.postedAt))).length;
  const verifiedLinkCount = evidence.filter((item) => item.linkStatus === "verified").length;
  let score = 12;
  score += Math.min(24, evidence.length * 8);
  score += Math.min(18, Math.max(0, uniqueContexts.size - 1) * 6);
  score += Math.min(14, uniquePlatforms.size * 7);
  score += Math.round(breakdown.convictionStrength * 0.16);
  score += Math.round((datedEvidenceCount / Math.max(1, evidence.length)) * 8);
  score += Math.round((verifiedLinkCount / Math.max(1, evidence.length)) * 8);
  if (partner.active) score += 4;
  const normalizedScore = clamp(score, 0, 100);
  const reasons = [
    evidence.length === 1 ? "Based on one attributable post." : `${evidence.length} unique attributable posts support this ranking.`,
    uniquePlatforms.size > 1 ? "Evidence spans multiple platforms." : "Evidence comes from one platform.",
    uniqueContexts.size > 1 ? "The evidence comes from multiple independent posts or contexts." : "The signal is based on one independent post or context."
  ];
  if (datedEvidenceCount < evidence.length) reasons.push("Some evidence lacks a reliable publication date.");
  if (verifiedLinkCount === evidence.length && evidence.length > 0) reasons.push("Every citation has a verified source link.");

  return {
    level: normalizedScore >= 75 ? "high" : normalizedScore >= 45 ? "medium" : "low",
    score: normalizedScore,
    reasons,
    uniqueEvidenceCount: evidence.length,
    uniquePlatformCount: uniquePlatforms.size,
    uniqueContextCount: uniqueContexts.size,
    datedEvidenceCount,
    verifiedLinkCount
  };
}

function reasonFor(signalType: FavoriteSignalType, specificity: number): string {
  switch (signalType) {
    case "explicit_superlative":
      return specificity >= 36
        ? "Used a strong superlative and gave specific reasons about the startup or team."
        : "Used an explicit superlative or strongest-possible endorsement."
    case "strong_conviction":
      return specificity >= 36
        ? "Expressed strong conviction and included substantive reasoning."
        : "Expressed unusually strong positive conviction."
    case "substantive_praise":
      return "Mentioned the startup positively while giving specific reasoning about its team, product, market, or technology."
    case "positive_commentary":
      return "Posted positive commentary about the startup."
    case "neutral_mention":
      return "Mentioned or tagged the startup without much additional commentary, so it contributes only a small amount."
    case "negative_commentary":
      return "Included skeptical or negative language, which lowers the favorability signal."
    case "unclear":
      return "The startup was attributable to the partner, but the wording did not contain a clear favorability signal."
  }
}

function compareAnalyses(left: FavoriteEvidenceAnalysis, right: FavoriteEvidenceAnalysis): number {
  return right.score - left.score ||
    comparableTimestamp(right.postedAt) - comparableTimestamp(left.postedAt) ||
    left.evidenceId.localeCompare(right.evidenceId);
}

function comparableTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.MIN_SAFE_INTEGER;
}

function normalizedEvidenceText(sourceText: string): string {
  return [sourceText]
    .filter(Boolean)
    .join(" ")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function excerptFor(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= 280) return compact;
  return `${compact.slice(0, 277).trim()}...`;
}

function selectContributingSentences(
  value: string,
  signalType: FavoriteSignalType,
  specificity: number
): string[] {
  const sentences = splitVerbatimSentences(value);
  if (sentences.length <= 1) return sentences;

  const signalPatterns = signalPatternsFor(signalType);
  const ranked = sentences.map((sentence, index) => {
    const signalMatches = signalPatterns.filter((pattern) => pattern.test(sentence)).length;
    const specificityMatches = SPECIFICITY_TERMS.filter((term) =>
      new RegExp(`\\b${term}\\b`, "i").test(sentence)
    ).length;
    return {
      sentence,
      index,
      signalMatches,
      weight: signalMatches * 5 + (specificity >= 36 ? specificityMatches : 0)
    };
  });

  const hasDirectSignal = ranked.some((candidate) => candidate.signalMatches > 0);
  const matchingSentences = ranked.filter((candidate) =>
    hasDirectSignal ? candidate.signalMatches > 0 : candidate.weight > 0
  );

  if (matchingSentences.length === 0) return sentences;

  // Keep the evidence concise while allowing a long post to contribute more
  // than one exact sentence. Original order is restored after selecting the
  // strongest spans so the UI reads naturally and remains word-for-word.
  const selected = matchingSentences
    .sort((left, right) => right.weight - left.weight || left.index - right.index)
    .slice(0, 3)
    .sort((left, right) => left.index - right.index);
  return selected.map((candidate) => candidate.sentence);
}

function signalPatternsFor(signalType: FavoriteSignalType): RegExp[] {
  if (signalType === "explicit_superlative") {
    return [...SUPERLATIVE_PATTERNS, ...STRONG_CONVICTION_PATTERNS];
  }
  if (signalType === "strong_conviction") {
    return STRONG_CONVICTION_PATTERNS;
  }
  if (signalType === "substantive_praise" || signalType === "positive_commentary") {
    return [...STRONG_CONVICTION_PATTERNS, ...POSITIVE_PATTERNS];
  }
  if (signalType === "negative_commentary") return NEGATIVE_PATTERNS;
  if (signalType === "neutral_mention") return NEUTRAL_PATTERNS;
  return [];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function safeCitationUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function safeCitationDate(value: string): string {
  return Number.isFinite(Date.parse(value)) ? value : "";
}
