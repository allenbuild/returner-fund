/**
 * Versioned, deterministic topic classification for post-level evidence.
 *
 * Topics describe the principal announcement.  Signals describe facts that may
 * coexist in it.  This deliberately prevents a post such as a YC launch with a
 * metric from appearing three times in the map's topic filters.
 */

export const POST_TOPIC_TAXONOMY_VERSION = "post-topics-2026-07-22" as const;
export const POST_TOPIC_CLASSIFIER_VERSION = "post-topics-rules-2026-07-22.1" as const;
/** Kept for callers written against the former multi-label contract. */
export const MAX_AUTOMATIC_POST_TOPICS = 1 as const;

export const POST_TOPIC_TAXONOMY = [
  { slug: "traction-growth", label: "Traction & Growth", group: "Business progress", description: "A quantified milestone in revenue, users, usage, growth, retention, or deployment volume.", aliases: ["traction", "growth", "milestone"] },
  { slug: "product-launch", label: "Product Launch", group: "Product & technical", description: "A new product, major feature, public release, beta, or newly available version.", aliases: ["launch", "product update", "release"] },
  { slug: "product-demo-showcase", label: "Product Demo & Showcase", group: "Product & technical", description: "A demonstration, walkthrough, use case, screenshot, or video of an existing capability.", aliases: ["product showcase", "demo", "walkthrough"] },
  { slug: "customer-partnership-deployment", label: "Customer, Partnership & Deployment", group: "Business progress", description: "A named customer, contract, pilot, deployment, integration, or formal partnership.", aliases: ["customer win", "partnership", "customer success"] },
  { slug: "fundraising-financing", label: "Fundraising & Financing", group: "Business progress", description: "A financing round, grant, investment, debt facility, or fundraising milestone.", aliases: ["fundraising", "funding", "financing"] },
  { slug: "accelerator-program", label: "Accelerator & Program", group: "Ecosystem", description: "Acceptance into, participation in, or an announcement from an accelerator, fellowship, or demo day.", aliases: ["yc acceptance", "demo day", "y combinator"] },
  { slug: "hiring-team", label: "Hiring & Team", group: "Business progress", description: "Open roles, recruiting, team additions, or a people-focused company announcement.", aliases: ["hiring", "jobs", "team"] },
  { slug: "company-vision-founder-perspective", label: "Vision & Founder Perspective", group: "Company narrative", description: "A company thesis, mission, founder lesson, origin story, or strategic perspective.", aliases: ["company vision", "founder story", "market insight"] },
  { slug: "research-benchmark-technical-insight", label: "Research, Benchmark & Technical Insight", group: "Product & technical", description: "Research, a benchmark, an engineering explanation, or a substantive open-source technical contribution.", aliases: ["research or benchmark", "technical deep dive", "open source"] },
  { slug: "event-media-community", label: "Event, Media & Community", group: "Ecosystem", description: "A conference, interview, podcast, press feature, award, webinar, or community activity.", aliases: ["event", "press or media", "community"] },
  { slug: "educational-informational", label: "Educational & Informational", group: "Company narrative", description: "A tutorial, explainer, guide, or non-promotional informational post.", aliases: ["education", "tutorial", "informational"] },
  { slug: "humor-culture", label: "Humor & Culture", group: "Company narrative", description: "A meme, joke, playful culture post, or content whose principal purpose is entertainment.", aliases: ["humor", "culture", "behind the scenes"] },
  { slug: "corporate-update", label: "Corporate Update", group: "Other", description: "A meaningful company announcement that lacks evidence for a more precise primary topic.", aliases: ["company update", "general update"] },
  { slug: "other", label: "Other", group: "Other", description: "A legitimate post that is clearly in scope but does not fit a defined topic.", aliases: ["miscellaneous"] },
  { slug: "unclassified", label: "Unclassified", group: "Other", description: "Insufficient reliable content exists to select a primary topic; it remains visible for review.", aliases: ["uncategorized", "unknown"] }
] as const;

export type PostTopicDefinition = (typeof POST_TOPIC_TAXONOMY)[number];
export type CanonicalPostTopic = PostTopicDefinition["slug"];
/**
 * Storage and test fixtures from taxonomy v1 may still carry these values.
 * They are accepted at boundaries, then normalized to CanonicalPostTopic
 * before classification, filtering, or display.
 */
export type LegacyPostTopic =
  | "traction" | "product-showcase" | "yc-acceptance" | "company-vision" | "humor"
  | "customer-win" | "fundraising" | "hiring" | "founder-story" | "technical-deep-dive"
  | "open-source" | "research-or-benchmark" | "partnership" | "demo-day" | "milestone"
  | "product-update" | "behind-the-scenes" | "market-insight" | "community" | "press-or-media"
  | "awards" | "event" | "culture";
export type PostTopic = CanonicalPostTopic | LegacyPostTopic;
export type PostTopicGroup = PostTopicDefinition["group"];
export type PostTopicClassificationMethod = "curated" | "rules" | "fallback" | "manual";
export type PostTopicRuleStrength = "curated" | "manual" | "high" | "medium" | "low" | "fallback";
export type PostTopicMediaType = "text" | "image" | "video" | "link" | "repo" | "launch" | "unknown";
export type PostTopicAuthorType = "company" | "founder" | "third_party" | "unknown";
export type PostTopicSecondarySignal =
  | "contains_quantified_metric" | "revenue_mentioned" | "user_count_mentioned" | "growth_rate_mentioned"
  | "customer_named" | "partnership_named" | "funding_amount_mentioned" | "hiring_call_to_action"
  | "product_availability_announced" | "open_source_release" | "benchmark_result" | "accelerator_mentioned"
  | "founder_authored" | "company_authored" | "third_party_mention" | "competitor_comparison"
  | "geographic_expansion" | "regulatory_milestone" | "award" | "acquisition" | "event_participation" | "press_coverage";

export interface PostTopicClassifierInput {
  /** Curated values take precedence. Legacy labels are normalized safely. */
  explicitTopics?: readonly string[] | null;
  title?: string | null;
  text?: string | null;
  rawVisibleText?: string | null;
  hashtags?: readonly string[] | null;
  mediaType?: PostTopicMediaType | null;
  platform?: string | null;
  authorType?: PostTopicAuthorType | null;
}

export interface PostTopicRuleMatch { topic: PostTopic; score: number; confidence: number; strength: PostTopicRuleStrength; matchedTerms: readonly string[]; }
export interface PostTopicEvidence { text: string; signal: PostTopicSecondarySignal | "topic_rule"; }
export interface PostTopicAlternative { topic: PostTopic; confidence: number; }
export interface PostTopicClassification {
  /** Compatibility projection: primary followed by an optional genuinely co-primary topic. */
  topics: readonly PostTopic[];
  primaryTopic: PostTopic;
  secondaryTopic: PostTopic | null;
  secondarySignals: readonly PostTopicSecondarySignal[];
  evidence: readonly PostTopicEvidence[];
  reasoningSummary: string;
  alternatives: readonly PostTopicAlternative[];
  needsReview: boolean;
  /** Prior persisted result retained by database backfills; never raw content. */
  priorClassification?: { taxonomyVersion: string; classifierVersion: string; primaryTopic: string | null } | null;
  classifierVersion: typeof POST_TOPIC_CLASSIFIER_VERSION;
  taxonomyVersion: typeof POST_TOPIC_TAXONOMY_VERSION;
  method: PostTopicClassificationMethod;
  confidence: number;
  strength: PostTopicRuleStrength;
  matchedTerms: readonly string[];
  matches: readonly PostTopicRuleMatch[];
}

type Rule = { topic: Exclude<CanonicalPostTopic, "other" | "unclassified">; minimum: number; high: number; patterns: readonly [RegExp, number][]; exclude?: readonly RegExp[] };
const RULES: readonly Rule[] = [
  { topic: "fundraising-financing", minimum: 5, high: 7, patterns: [[/\b(?:raised|closed)\s+(?:\$|usd\s*)[\d,.]+\s*(?:[kmb]\b)?/i, 8], [/\b(?:pre-?seed|seed|series\s+[a-z]|grant|debt financing)\b.{0,45}\b(?:round|funding|financing|backed)\b/i, 6], [/\bfundraising\b/i, 3]] },
  { topic: "accelerator-program", minimum: 6, high: 7, patterns: [[/\b(?:we|i)\s+(?:were |got |have been |just )?(?:accepted|accepted into|got into|joined|are joining)\s+(?:y combinator|yc)\b/i, 8], [/\b(?:yc|y combinator)\s+(?:spring|summer|winter|fall|[wsf])\s*\d{2,4}\s+batch\b/i, 7], [/\b(?:yc\s+)?demo day\b/i, 6]], exclude: [/\b(?:apply|application|congratulations? to|how to get into)\b/i] },
  { topic: "customer-partnership-deployment", minimum: 5, high: 7, patterns: [[/\b(?:partnered|partnering|integration)\s+with\s+[a-z0-9]/i, 7], [/\b(?:customer|client)\s+(?:chose|selected|deployed|uses|is using|switched to)\b/i, 7], [/\b(?:pilot|contract|deployment|design partner)\b/i, 5], [/\b(?:case study|customer win|strategic partnership)\b/i, 6]] },
  { topic: "traction-growth", minimum: 6, high: 8, patterns: [[/\b(?:reached|hit|crossed|surpassed|serving)\s+(?:over\s+)?[\d,.]+\s*(?:[kmb]\b)?\s*(?:paid\s+)?(?:users?|customers?|teams?|signups?|transactions?|deployments?)\b/i, 8], [/\b(?:\$|usd\s*)[\d,.]+\s*(?:[kmb]\b)?\s*(?:arr|mrr|gmv|revenue)\b/i, 8], [/\b(?:grew|growth|up)\s+(?:by\s+)?\d+(?:\.\d+)?%/i, 7], [/\b\d+(?:\.\d+)?x\s+(?:revenue|arr|mrr|growth|customers?|clients?|users?)\b/i, 7], [/\b(?:arr|mrr|gmv|retention|waitlist|revenue)\b/i, 3]] },
  { topic: "hiring-team", minimum: 5, high: 7, patterns: [[/\b(?:we(?:'re| are)|i(?:'m| am)) hiring\b/i, 8], [/\b(?:open roles?|job openings?|join our team|come work with us|apply (?:here|now|for))\b/i, 6], [/\b(?:welcoming|welcome)\s+[A-Z][\w .'-]+\s+(?:to|as)\s+(?:our )?team\b/i, 5]] },
  { topic: "product-launch", minimum: 5, high: 7, patterns: [[/\b(?:we(?:'ve| have)?|i(?:'ve| have)?|now)\s+(?:just\s+)?(?:launched|released|shipped)\b/i, 7], [/\b[A-Z][\w.-]+\s+(?:has\s+)?(?:launched|released|shipped)\b/, 6], [/\b(?:introducing|available today|now live|public beta|general availability)\b/i, 6], [/\b(?:v|version\s*)\d+(?:\.\d+)+\s+(?:is|now available|released)\b/i, 6]], exclude: [/\b(?:launching a fund|launching a podcast)\b/i] },
  { topic: "research-benchmark-technical-insight", minimum: 5, high: 7, patterns: [[/\b(?:benchmark|evaluation|research|paper|arxiv|dataset)\b.{0,48}\b(?:result|results|outperforms?|findings?|release)\b/i, 7], [/\b(?:open[- ]sourced|open source release|mit license|apache\s*2\.0)\b/i, 7], [/\b(?:engineering|architecture|implementation|under the hood)\s+(?:deep dive|breakdown|details)\b/i, 6]] },
  { topic: "product-demo-showcase", minimum: 5, high: 7, patterns: [[/\b(?:watch|see|try)\s+(?:it|our|the).{0,20}\b(?:demo|in action)\b/i, 7], [/\b(?:walkthrough|product tour|screen recording|here(?:'s| is) how (?:it|our) works)\b/i, 6], [/\b(?:demo|showcase)\b/i, 3]], exclude: [/\b(?:demo day|book a demo|request a demo)\b/i] },
  { topic: "company-vision-founder-perspective", minimum: 5, high: 7, patterns: [[/\b(?:our mission|our vision|why we(?:'re| are) building|we believe the future|category thesis)\b/i, 7], [/\b(?:why|how) i (?:started|founded|built)\b/i, 6], [/\b(?:the future of|a world where)\b/i, 4]] },
  { topic: "event-media-community", minimum: 5, high: 7, patterns: [[/\b(?:speaking|presenting|exhibiting|join us|meet us) at\b/i, 6], [/\b(?:podcast|interview|featured in|press coverage|conference|webinar|meetup)\b/i, 5], [/\b(?:award|finalist|winner|community)\b/i, 4]] },
  { topic: "educational-informational", minimum: 5, high: 7, patterns: [[/\b(?:tutorial|guide|explainer|how to|step[- ]by[- ]step)\b/i, 6], [/\b(?:learn how|we explain|primer)\b/i, 5]] },
  { topic: "humor-culture", minimum: 5, high: 7, patterns: [[/\b(?:meme|parody|satire|shitpost|joke|expectation vs\.? reality)\b/i, 7], [/#(?:meme|startuphumor|techhumor)\b/i, 6], [/\b(?:offsite|behind the scenes|day in the life)\b/i, 5]] }
];

const LEGACY_ALIASES: Readonly<Record<string, CanonicalPostTopic>> = {
  "traction": "traction-growth", "growth": "traction-growth", "milestone": "traction-growth",
  "product-showcase": "product-demo-showcase", "product-demo": "product-demo-showcase",
  "yc-acceptance": "accelerator-program", "demo-day": "accelerator-program",
  "customer-win": "customer-partnership-deployment", "partnership": "customer-partnership-deployment",
  "fundraising": "fundraising-financing", "hiring": "hiring-team",
  "company-vision": "company-vision-founder-perspective", "founder-story": "company-vision-founder-perspective", "market-insight": "company-vision-founder-perspective",
  "technical-deep-dive": "research-benchmark-technical-insight", "research-or-benchmark": "research-benchmark-technical-insight", "open-source": "research-benchmark-technical-insight",
  "event": "event-media-community", "press-or-media": "event-media-community", "community": "event-media-community", "awards": "event-media-community",
  "humor": "humor-culture", "culture": "humor-culture", "behind-the-scenes": "humor-culture",
  "product-update": "product-launch", "other": "unclassified"
};

const RAW_VISIBLE_KEYS = new Set(["accessibilitycaption", "body", "caption", "content", "description", "fulltext", "rawtext", "text", "title", "visibletext"]);
const RAW_IGNORED_KEYS = new Set(["author", "batchcontext", "counts", "engagement", "metadata", "metrics", "owner", "profile", "target", "verification"]);
export const POST_TOPIC_SLUGS: readonly CanonicalPostTopic[] = POST_TOPIC_TAXONOMY.map((topic) => topic.slug);

export function isPostTopic(value: string): value is PostTopic { return POST_TOPIC_SLUGS.includes(value as CanonicalPostTopic) || Boolean(LEGACY_ALIASES[value]); }
export function getPostTopicDefinition(topic: PostTopic): PostTopicDefinition { const canonical = normalizePostTopic(topic); const definition = canonical && POST_TOPIC_TAXONOMY.find((item) => item.slug === canonical); if (!definition) throw new Error(`Unknown canonical post topic: ${topic}`); return definition; }
export function normalizePostTopic(value: string): CanonicalPostTopic | null {
  const key = normalizeAlias(value); if (!key) return null;
  const legacy = LEGACY_ALIASES[key]; if (legacy) return legacy;
  return POST_TOPIC_TAXONOMY.find((topic) => [topic.slug, topic.label, ...topic.aliases].some((candidate) => normalizeAlias(candidate) === key))?.slug ?? null;
}
export function normalizePostTopics(values: readonly string[]): CanonicalPostTopic[] { const valuesSet = new Set<CanonicalPostTopic>(); for (const value of values) { const topic = normalizePostTopic(value); if (topic) valuesSet.add(topic); } return POST_TOPIC_SLUGS.filter((topic) => valuesSet.has(topic)); }

export function classifyPostTopics(input: PostTopicClassifierInput): PostTopicClassification {
  const curated = normalizePostTopics(input.explicitTopics ?? []);
  if (curated.length) return result(curated[0]!, "curated", 1, "curated", [{ topic: curated[0]!, score: 1, confidence: 1, strength: "curated", matchedTerms: [getPostTopicDefinition(curated[0]!).label] }], input);
  const text = authoredText(input);
  const signals = extractTopicSignals(text, input.authorType ?? "unknown");
  const matches = RULES.map((rule, index) => ({ match: evaluate(rule, text), index })).filter((entry): entry is { match: PostTopicRuleMatch; index: number } => entry.match !== null).sort((a, b) => b.match.score - a.match.score || a.index - b.index).map((entry) => entry.match);
  if (!matches.length) {
    const fallbackTopic: PostTopic = hasMeaningfulCorporateUpdate(text)
      ? "corporate-update"
      : hasEnoughVisibleContent(text)
        ? "other"
        : "unclassified";
    const fallbackConfidence = fallbackTopic === "corporate-update" ? .45 : fallbackTopic === "other" ? .35 : .2;
    return result(fallbackTopic, "fallback", fallbackConfidence, "fallback", [{ topic: fallbackTopic, score: 0, confidence: fallbackConfidence, strength: "fallback", matchedTerms: [] }], input, signals);
  }
  const primary = matches[0]!;
  const second = matches[1];
  const primaryTopic = primary.topic;
  const secondaryTopic = second && isGenuinelyCoPrimary(primary, second) ? second.topic : null;
  return result(primaryTopic, "rules", primary.confidence, primary.strength, matches.slice(0, 3), input, signals, secondaryTopic);
}

/** Deterministic fact extraction, intentionally separate from primary-topic choice. */
export function extractTopicSignals(text: string, authorType: PostTopicAuthorType = "unknown"): PostTopicSecondarySignal[] {
  const signals = new Set<PostTopicSecondarySignal>();
  const add = (condition: boolean, signal: PostTopicSecondarySignal) => { if (condition) signals.add(signal); };
  add(/(?:\$|usd\s*)[\d,.]+\s*(?:[kmb]\b)?/i.test(text), "contains_quantified_metric");
  add(/(?:arr|mrr|gmv|revenue)\b/i.test(text), "revenue_mentioned"); add(/[\d,.]+\s*(?:paid\s+)?(?:users?|customers?|teams?|signups?)/i.test(text), "user_count_mentioned"); add(/(?:grew|growth|up)\s+(?:by\s+)?\d+(?:\.\d+)?%/i.test(text), "growth_rate_mentioned");
  add(/\b(?:customer|client|case study|pilot|contract|deployment)\b/i.test(text), "customer_named"); add(/\b(?:partnered|partnership|integration)\b/i.test(text), "partnership_named"); add(/\b(?:raised|funding|financing|seed|series\s+[a-z]|grant)\b/i.test(text), "funding_amount_mentioned"); add(/\b(?:we(?:'re| are)|are) hiring\b|\b(?:open roles?|join our team)\b/i.test(text), "hiring_call_to_action");
  add(/\b(?:launched|released|available today|now live|public beta)\b/i.test(text), "product_availability_announced"); add(/\b(?:open[- ]sourced|open source|mit license|apache)\b/i.test(text), "open_source_release"); add(/\b(?:benchmark|evaluation|outperforms?|research results?)\b/i.test(text), "benchmark_result"); add(/\b(?:y combinator|\byc\b|accelerator|demo day|fellowship)\b/i.test(text), "accelerator_mentioned");
  add(authorType === "founder", "founder_authored"); add(authorType === "company", "company_authored"); add(authorType === "third_party", "third_party_mention"); add(/\b(?:vs\.?|compared with|alternative to)\b/i.test(text), "competitor_comparison"); add(/\b(?:expanding to|expansion into|launching in)\b/i.test(text), "geographic_expansion"); add(/\b(?:regulatory|fda|approved|certified)\b/i.test(text), "regulatory_milestone"); add(/\b(?:award|finalist|winner)\b/i.test(text), "award"); add(/\b(?:acquired|acquisition)\b/i.test(text), "acquisition"); add(/\b(?:conference|webinar|meetup|speaking|presenting)\b/i.test(text), "event_participation"); add(/\b(?:featured in|podcast|interview|press coverage)\b/i.test(text), "press_coverage");
  return [...signals];
}

export function extractPostVisibleText(rawVisibleText: string | null | undefined): string {
  const raw = rawVisibleText?.trim(); if (!raw || (!raw.startsWith("{") && !raw.startsWith("["))) return "";
  try { const values: string[] = []; collectVisible(JSON.parse(raw.slice(0, 50_000)), "", 0, values); return normalizeText(values.join(" ")); } catch { return ""; }
}

function evaluate(rule: Rule, text: string): PostTopicRuleMatch | null { let score = 0; const matchedTerms: string[] = []; for (const [pattern, weight] of rule.patterns) { const found = pattern.exec(text); if (found?.[0]) { score += weight; matchedTerms.push(normalizeText(found[0])); } } if ((rule.exclude ?? []).some((pattern) => pattern.test(text))) score = 0; if (score < rule.minimum) return null; const strength: PostTopicRuleStrength = score >= rule.high ? "high" : "medium"; return { topic: rule.topic, score, confidence: Math.min(.98, .58 + (score - rule.minimum) * .07), strength, matchedTerms: unique(matchedTerms) }; }
function result(primaryTopic: PostTopic, method: PostTopicClassificationMethod, confidence: number, strength: PostTopicRuleStrength, matches: readonly PostTopicRuleMatch[], input: PostTopicClassifierInput, signals = extractTopicSignals(authoredText(input), input.authorType ?? "unknown"), secondaryTopic: PostTopic | null = null): PostTopicClassification {
  const primaryMatch = matches[0]; const evidence = primaryMatch?.matchedTerms.slice(0, 2).map((text) => ({ text, signal: "topic_rule" as const })) ?? [];
  const alternatives = matches.slice(1, 3).filter((match) => match.topic !== secondaryTopic).map((match) => ({ topic: match.topic, confidence: match.confidence }));
  const needsReview = method !== "curated" && (confidence < .72 || primaryTopic === "unclassified" || Boolean(secondaryTopic));
  return { topics: secondaryTopic ? [primaryTopic, secondaryTopic] : [primaryTopic], primaryTopic, secondaryTopic, secondarySignals: signals, evidence, reasoningSummary: reasoning(primaryTopic, signals, method), alternatives, needsReview, classifierVersion: POST_TOPIC_CLASSIFIER_VERSION, taxonomyVersion: POST_TOPIC_TAXONOMY_VERSION, method, confidence, strength, matchedTerms: unique(matches.flatMap((match) => match.matchedTerms)), matches };
}
function reasoning(topic: PostTopic, signals: readonly PostTopicSecondarySignal[], method: PostTopicClassificationMethod): string { if (method === "manual") return "A maintainer selected the canonical primary topic."; if (method === "curated") return "A maintained classification selected the canonical primary topic."; if (topic === "unclassified") return "The visible post text lacks reliable evidence for a canonical primary topic."; const facts = signals.slice(0, 2).map((signal) => signal.replaceAll("_", " ")); return facts.length ? `Primary topic selected from visible ${facts.join(" and ")}.` : "Primary topic selected from explicit visible announcement language."; }
function isGenuinelyCoPrimary(left: PostTopicRuleMatch, right: PostTopicRuleMatch) { return left.confidence >= .8 && right.confidence >= .8 && Math.abs(left.score - right.score) <= 1 && !["humor-culture", "event-media-community"].includes(right.topic); }
function authoredText(input: PostTopicClassifierInput): string { const tags = (input.hashtags ?? []).map((tag) => tag.trim()).filter(Boolean).map((tag) => tag.startsWith("#") ? tag : `#${tag}`); return normalizeText([input.title ?? "", input.text ?? "", extractPostVisibleText(input.rawVisibleText), ...tags].join(" ")); }
function hasMeaningfulCorporateUpdate(text: string) { return /\b(?:announc(?:e|ing|ement)|update|welcome|proud|excited|today|news)\b/i.test(text) && text.length >= 24; }
function hasEnoughVisibleContent(text: string) { return text.split(/\s+/).filter(Boolean).length >= 5; }
function collectVisible(value: unknown, parent: string, depth: number, values: string[]) { if (depth > 8 || values.length >= 24) return; if (typeof value === "string") { if (RAW_VISIBLE_KEYS.has(normalizeAlias(parent))) values.push(value); return; } if (Array.isArray(value)) { for (const child of value) collectVisible(child, parent, depth + 1, values); return; } if (!value || typeof value !== "object") return; for (const key of Object.keys(value as object).sort()) { if (RAW_IGNORED_KEYS.has(normalizeAlias(key))) continue; collectVisible(Reflect.get(value, key), key, depth + 1, values); } }
function normalizeAlias(value: string) { return value.trim().toLowerCase().replace(/[_/]+/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function normalizeText(value: string) { return value.replace(/\s+/g, " ").trim(); }
function unique(values: readonly string[]) { return [...new Set(values.filter(Boolean))]; }
