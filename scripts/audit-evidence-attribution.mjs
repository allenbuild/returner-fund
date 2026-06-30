import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const apiUrl =
  argValue("--api-url") ??
  process.env.GRAPH_API_URL ??
  "http://127.0.0.1:3001/api/graph?batch=S2026&includeRaw=1&includeNonScoring=1";
const workerCount = Math.max(1, Number(argValue("--workers") ?? os.cpus().length ?? 4));
const writeDoc = booleanArg("--write-doc");
const strict = booleanArg("--strict");
const GENERIC_SINGLE_WORD_NAMES = new Set([
  "aice",
  "arden",
  "bloom",
  "chert",
  "cohesion",
  "dispatch",
  "drafted",
  "flow",
  "flowscope",
  "frame",
  "hedge",
  "hub",
  "hyper",
  "jo",
  "modern",
  "pentagon",
  "pluto",
  "primitive",
  "replicas",
  "result",
  "runtime",
  "stage",
  "standout",
  "superset",
  "thomas",
  "walter"
]);
const graph = await fetchJson(apiUrl);
const companies = graph.nodes.filter((node) => node.entityType === "company");
const context = buildContext(companies);
const scoredEvidence = graph.evidence.filter((item) => item.contributionScore > 0);
const chunks = chunk(scoredEvidence, workerCount);
const auditedChunks = await Promise.all(chunks.map((items) => Promise.resolve(items.map((item) => auditItem(item, context)))));
const audits = auditedChunks.flat();
const highRiskScored = audits.filter((item) => item.risk === "high");
const mediumRiskScored = audits.filter((item) => item.risk === "medium");
const guardedRows = graph.evidence.filter(
  (item) => item.contributionScore === 0 && /Attribution guard:/i.test(`${item.why ?? ""} ${item.matchReason ?? ""}`)
);
const firstPartySocialReviews = firstPartySocialReviewRows(scoredEvidence, context);

const report = {
  generated_at: new Date().toISOString(),
  api_url: apiUrl,
  worker_count: workerCount,
  company_count: companies.length,
  evidence_count: graph.evidence.length,
  scored_evidence_count: scoredEvidence.length,
  guarded_zero_score_rows: guardedRows.length,
  high_risk_scored_count: highRiskScored.length,
  medium_risk_scored_count: mediumRiskScored.length,
  first_party_social_review_count: firstPartySocialReviews.length,
  founder_first_party_review_count: firstPartySocialReviews.filter((item) => item.entityType === "founder").length,
  first_party_social_review_priority_counts: countBy(firstPartySocialReviews, "reviewPriority"),
  high_risk_scored: highRiskScored.slice(0, 200),
  medium_risk_scored: mediumRiskScored.slice(0, 200),
  first_party_social_review: firstPartySocialReviews.slice(0, 200),
  guarded_zero_score_examples: guardedRows.slice(0, 50).map(summaryRow),
  company_risk_summary: companyRiskSummary([...highRiskScored, ...mediumRiskScored]),
  result: highRiskScored.length === 0 ? "pass" : "needs_attention"
};

await fs.mkdir("outputs", { recursive: true });
await fs.writeFile(path.join("outputs", "evidence-attribution-audit-s2026.json"), JSON.stringify(report, null, 2));
if (writeDoc) {
  await writeMarkdownReport(report);
}

console.log(
  JSON.stringify(
    {
      outputPath: "outputs/evidence-attribution-audit-s2026.json",
      result: report.result,
      workers: workerCount,
      scoredEvidence: report.scored_evidence_count,
      highRiskScored: report.high_risk_scored_count,
      mediumRiskScored: report.medium_risk_scored_count,
      firstPartySocialReview: report.first_party_social_review_count,
      founderFirstPartyReview: report.founder_first_party_review_count,
      firstPartySocialReviewPriorityCounts: report.first_party_social_review_priority_counts,
      guardedZeroScoreRows: report.guarded_zero_score_rows
    },
    null,
    2
  )
);

if (strict && highRiskScored.length > 0) {
  process.exitCode = 1;
}

async function writeMarkdownReport(report) {
  const lines = [
    "# Evidence Attribution Audit",
    "",
    "## Latest Run",
    "",
    `- Generated at: ${report.generated_at}.`,
    `- Worker count: ${report.worker_count}.`,
    `- Companies checked: ${report.company_count}.`,
    `- Evidence rows checked: ${report.evidence_count}.`,
    `- Scored evidence rows audited: ${report.scored_evidence_count}.`,
    `- Guarded zero-score rows: ${report.guarded_zero_score_rows}.`,
    `- High-risk scored rows: ${report.high_risk_scored_count}.`,
    `- Medium-risk scored rows: ${report.medium_risk_scored_count}.`,
    `- First-party social rows needing body-signal review: ${report.first_party_social_review_count}.`,
    `- Founder first-party rows needing body-signal review: ${report.founder_first_party_review_count}.`,
    `- First-party review priorities: ${JSON.stringify(report.first_party_social_review_priority_counts)}.`,
    `- Result: ${report.result}.`,
    "",
    "## High-Risk Scored Rows",
    "",
    ...(report.high_risk_scored.length
      ? report.high_risk_scored.slice(0, 50).map(markdownAuditRow)
      : ["- None."]),
    "",
    "## Medium-Risk Scored Rows",
    "",
    ...(report.medium_risk_scored.length
      ? report.medium_risk_scored.slice(0, 50).map(markdownAuditRow)
      : ["- None."]),
    "",
    "## First-Party Social Body-Signal Review",
    "",
    ...(report.first_party_social_review.length
      ? report.first_party_social_review.slice(0, 75).map(markdownFirstPartyReviewRow)
      : ["- None."]),
    "",
    "## Guarded Zero-Score Examples",
    "",
    ...(report.guarded_zero_score_examples.length
      ? report.guarded_zero_score_examples.slice(0, 25).map((item) => `- ${item.company}: ${item.platform} ${item.title} (${item.url})`)
      : ["- None."]),
    "",
    "## Company Risk Summary",
    "",
    ...(report.company_risk_summary.length
      ? report.company_risk_summary.map((item) => `- ${item.company}: ${item.high} high, ${item.medium} medium.`)
      : ["- None."]),
    "",
    "Machine-readable output: `outputs/evidence-attribution-audit-s2026.json`.",
    ""
  ];

  await fs.mkdir("docs", { recursive: true });
  await fs.writeFile(path.join("docs", "EVIDENCE_ATTRIBUTION_AUDIT.md"), lines.join("\n"));
}

function markdownAuditRow(item) {
  return `- ${item.company}: ${item.platform} ${item.title} (${item.url}) - ${item.reasons.join(" ")}`;
}

function markdownFirstPartyReviewRow(item) {
  return `- [${item.reviewPriority}] ${item.company}: ${item.platform} ${item.title} (${item.url}) - ${item.reviewReason}`;
}

function auditItem(item, context) {
  const existingGuardText = `${item.why ?? ""} ${item.matchReason ?? ""}`;
  if (/Attribution guard:\s*low risk/i.test(existingGuardText)) {
    return {
      ...summaryRow(item),
      risk: "low",
      reasons: ["Live attribution guard already marked this row low risk."],
      conflictingCompanyNames: []
    };
  }

  const company = context.companyById.get(item.attachedCompanyId ?? item.entityId);
  if (!company) {
    return {
      ...summaryRow(item),
      risk: "high",
      reasons: ["Attached company could not be resolved."],
      conflictingCompanyNames: []
    };
  }

  const text = normalizeText(
    [
      item.authorName,
      item.authorHandle,
      item.text,
      item.rawVisibleText,
      item.sourceUrl,
      item.accountUrl,
      item.matchReason,
      item.why
    ].join(" ")
  );
  const ownSignal = hasOwnSignal(text, item, company);
  const verifiedAccount = hasVerifiedAccount(item, company);
  const conflicts = conflictingCompanies(text, context, company);
  const profileOrContext = item.contributionScore <= 0 || /profile|context only|retweet|repost/i.test(`${item.why ?? ""} ${item.rawVisibleText ?? ""}`);

  if (item.platform === "github" && !ownSignal && !verifiedAccount) {
    return {
      ...summaryRow(item),
      risk: "high",
      reasons: ["GitHub repo/account cannot be tied to the target company/founder account, name, handle, or domain."],
      conflictingCompanyNames: conflicts
    };
  }

  if (conflicts.length && !ownSignal) {
    return {
      ...summaryRow(item),
      risk: "high",
      reasons: [`Visible text matches another YC company without a target signal: ${conflicts.join(", ")}.`],
      conflictingCompanyNames: conflicts
    };
  }

  if (!ownSignal && !verifiedAccount && !profileOrContext && strictPlatform(item.platform)) {
    return {
      ...summaryRow(item),
      risk: "high",
      reasons: [`Scored ${item.platform} row lacks company/founder/domain/verified-account signal.`],
      conflictingCompanyNames: conflicts
    };
  }

  if (!ownSignal && !verifiedAccount && !profileOrContext) {
    return {
      ...summaryRow(item),
      risk: "medium",
      reasons: ["Weak attribution signal for scored evidence."],
      conflictingCompanyNames: conflicts
    };
  }

  return {
    ...summaryRow(item),
    risk: "low",
    reasons: verifiedAccount ? ["Verified account ownership signal."] : ["Visible target signal."],
    conflictingCompanyNames: conflicts
  };
}

function buildContext(companies) {
  const companyById = new Map();
  for (const company of companies) {
    const socialLinks = [...(company.socialAccounts ?? []), ...(company.founders ?? []).flatMap((founder) => founder.socialAccounts ?? [])];
    companyById.set(company.entityId, {
      id: company.entityId,
      name: company.label,
      names: distinctiveNames(company.label),
      domains: [domainFromUrl(company.websiteUrl), ...socialLinks.map((account) => domainFromUrl(account.url))].filter(Boolean),
      handlesByPlatform: handlesByPlatform(socialLinks),
      founders: company.founders ?? []
    });
  }
  return { companyById, companies: [...companyById.values()] };
}

function hasOwnSignal(text, item, company) {
  const platformHandles = company.handlesByPlatform[item.platform] ?? new Set();
  const founderNames = company.founders.flatMap((founder) => distinctiveNames(founder.name));

  return (
    company.names.some((name) => hasPhrase(text, name)) ||
    founderNames.some((name) => hasPhrase(text, name)) ||
    company.domains.some((domain) => domain && text.includes(domain)) ||
    [...platformHandles].some((handle) => handle && text.includes(handle))
  );
}

function hasVerifiedAccount(item, company) {
  const handles = company.handlesByPlatform[item.platform] ?? new Set();
  const candidates = [
    normalizeHandle(item.authorHandle),
    normalizeHandle(item.authorName),
    handleFromUrl(item.accountUrl),
    handleFromUrl(item.sourceUrl)
  ].filter(Boolean);
  return candidates.some((candidate) => handles.has(candidate));
}

function conflictingCompanies(text, context, ownCompany) {
  return context.companies
    .filter((company) => company.id !== ownCompany.id)
    .filter((company) => company.names.some((name) => hasPhrase(text, name)))
    .map((company) => company.name)
    .slice(0, 8);
}

function strictPlatform(platform) {
  return ["youtube", "product_hunt", "hacker_news", "reddit", "linkedin"].includes(platform);
}

function summaryRow(item) {
  return {
    id: item.id,
    company: item.attachedCompanyName ?? item.companyName ?? item.attachedCompanyId ?? item.entityId,
    entityType: item.entityType,
    entityId: item.entityId,
    platform: item.platform,
    title: truncate(item.text || item.title || item.authorName, 140),
    url: item.sourceUrl,
    score: item.contributionScore,
    metrics: item.metrics ?? {},
    authorName: item.authorName,
    authorHandle: item.authorHandle,
    accountUrl: item.accountUrl ?? "",
    matchReason: item.matchReason ?? item.why ?? ""
  };
}

function firstPartySocialReviewRows(items, context) {
  return items
    .flatMap((item) => {
      if (!["x", "instagram", "linkedin", "youtube"].includes(item.platform)) return [];
      const company = context.companyById.get(item.attachedCompanyId ?? item.entityId);
      if (!company || !hasVerifiedAccount(item, company)) return [];

      const visibleText = visiblePostText(item);
      const normalizedVisibleText = normalizeText(visibleText);
      if (!normalizedVisibleText || hasOwnSignal(normalizedVisibleText, item, company)) return [];

      const conflicts = conflictingCompanies(normalizedVisibleText, context, company);
      const productContext = hasProductContext(normalizedVisibleText);
      const personalContext = hasPersonalContext(normalizedVisibleText);
      const clearOffTopicContext = hasClearOffTopicContext(normalizedVisibleText);
      const highMetric = maxVisibleMetric(item) >= 100_000 || Number(item.contributionScore ?? 0) >= 50;
      const founderRow = item.entityType === "founder" || String(item.entityId ?? "").startsWith("founder-");
      const priorityScore =
        (founderRow ? 1 : 0) +
        (clearOffTopicContext ? 3 : 0) +
        (personalContext && !productContext ? 1 : 0) +
        (productContext ? 0 : 1) +
        (highMetric ? 1 : 0) +
        (conflicts.length ? 2 : 0);
      const reviewPriority = priorityScore >= 4 ? "high" : priorityScore >= 2 ? "medium" : "low";
      const reviewReason = [
        founderRow ? "founder account" : "company account",
        "is verified first-party, but the visible post body lacks a target company/founder/domain/handle signal",
        productContext ? "and has product/startup context" : "and lacks obvious product/startup context",
        clearOffTopicContext ? "and contains clear off-topic language" : personalContext ? "and contains personal-context language" : "",
        conflicts.length ? `while mentioning possible peer companies: ${conflicts.join(", ")}` : ""
      ]
        .filter(Boolean)
        .join(" ");

      return [
        {
          ...summaryRow(item),
          reviewPriority,
          reviewReason,
          visibleText: truncate(visibleText, 280),
          productContext,
          personalContext,
          clearOffTopicContext,
          maxVisibleMetric: maxVisibleMetric(item),
          conflictingCompanyNames: conflicts
        }
      ];
    })
    .sort((left, right) => priorityRank(right.reviewPriority) - priorityRank(left.reviewPriority) || right.score - left.score || right.maxVisibleMetric - left.maxVisibleMetric);
}

function visiblePostText(item) {
  return [item.text, extractRawVisibleBody(item.rawVisibleText)].filter(Boolean).join(" ");
}

function extractRawVisibleBody(rawVisibleText) {
  if (!rawVisibleText) return "";
  try {
    const parsed = JSON.parse(rawVisibleText);
    return [
      parsed.text,
      parsed.caption,
      parsed.title,
      parsed.description,
      parsed.full_text,
      parsed.fullText,
      parsed.body,
      parsed.content,
      parsed.visibleText,
      parsed.visible_text,
      parsed.story_text
    ]
      .filter(Boolean)
      .join(" ");
  } catch {
    return rawVisibleText;
  }
}

function hasProductContext(text) {
  return /\b(ai|agent|app|automated|automation|baseline|benchmark|beta|build|builds|building|built|business|claude|code|computer|control|cursor|customer|customers|data|demo|demos|developer|domain|github|launch|launched|launching|model|mrr|office hours|open source|operating system|platform|product|pull request|prs|release|released|report|reports|revenue|screen|ship|shipped|shipping|site|sites|startup|team|testing|tool|user|users|voice|waitlist|website|yc|y combinator)\b/i.test(
    text
  );
}

function hasPersonalContext(text) {
  return /\b(3 idiots|algorithm wants|barista|birthday|coffee|coffee shop|food|friend|friends|gym|hoop|marina theater|milk|movie|movies|restaurant|subtitles|theater|theatre|vacation|wedding)\b/i.test(
    text
  );
}

function hasClearOffTopicContext(text) {
  return /\b(3 idiots|algorithm wants|barista|coffee shop|gym|hoop|marina theater|milk|movie|movies|restaurant|subtitles|theater|theatre|vacation|wedding)\b/i.test(
    text
  );
}

function maxVisibleMetric(item) {
  const metrics = item.metrics ?? {};
  return Math.max(
    Number(metrics.views ?? 0),
    Number(metrics.likes ?? 0),
    Number(metrics.comments ?? 0),
    Number(metrics.reposts ?? metrics.shares ?? 0),
    Number(metrics.reactions ?? 0),
    Number(metrics.upvotes ?? 0)
  );
}

function priorityRank(priority) {
  return { high: 3, medium: 2, low: 1 }[priority] ?? 0;
}

function countBy(items, field) {
  return items.reduce((counts, item) => {
    const key = item[field] ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function companyRiskSummary(rows) {
  const byCompany = new Map();
  for (const row of rows) {
    const current = byCompany.get(row.company) ?? { company: row.company, high: 0, medium: 0 };
    if (row.risk === "high") current.high += 1;
    if (row.risk === "medium") current.medium += 1;
    byCompany.set(row.company, current);
  }
  return [...byCompany.values()].sort((left, right) => right.high - left.high || right.medium - left.medium).slice(0, 50);
}

function handlesByPlatform(accounts) {
  const byPlatform = {};
  for (const account of accounts) {
    const handle = handleFromUrl(account.url);
    if (!account.platform || !handle) continue;
    byPlatform[account.platform] ??= new Set();
    byPlatform[account.platform].add(handle);
  }
  return byPlatform;
}

function distinctiveNames(name) {
  const normalized = normalizeText(name);
  const compact = compactText(name);
  if (!normalized && !compact) return [];
  const tokenCount = normalized.split(" ").filter(Boolean).length;
  const names = [normalized, compact].filter(Boolean);
  return [...new Set(names)].filter((candidate) => {
    if (tokenCount > 1) return true;
    return candidate.length >= 5 && !GENERIC_SINGLE_WORD_NAMES.has(candidate);
  });
}

function hasPhrase(text, phrase) {
  if (!phrase) return false;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
}

function domainFromUrl(rawUrl) {
  if (!rawUrl) return "";
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function handleFromUrl(rawUrl) {
  if (!rawUrl) return "";
  try {
    const url = new URL(rawUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.hostname.includes("x.com") || url.hostname.includes("twitter.com")) return normalizeHandle(parts[0]);
    if (url.hostname.includes("instagram.com")) return normalizeHandle(parts[0]);
    if (url.hostname.includes("github.com")) return normalizeHandle(parts[0]);
    if (url.hostname.includes("linkedin.com")) return normalizeHandle(parts.at(-1));
  } catch {
    return normalizeHandle(rawUrl);
  }
  return "";
}

function normalizeHandle(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9._-]+/g, "")
    .replace(/^-+|-+$/g, "");
}

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/https?:\/\/(www\.)?/g, " ")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function truncate(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function chunk(items, count) {
  const chunks = Array.from({ length: Math.min(count, Math.max(items.length, 1)) }, () => []);
  items.forEach((item, index) => {
    chunks[index % chunks.length].push(item);
  });
  return chunks;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Graph API failed with ${response.status}`);
  }
  return response.json();
}

function argValue(name) {
  const equalsValue = process.argv.find((arg) => arg.startsWith(`${name}=`))?.split("=").slice(1).join("=");
  if (equalsValue !== undefined) return equalsValue;
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function booleanArg(name) {
  return process.argv.includes(name) || process.argv.some((arg) => arg === `${name}=true`);
}
