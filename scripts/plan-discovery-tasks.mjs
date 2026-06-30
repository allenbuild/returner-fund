import fs from "node:fs/promises";
import path from "node:path";

const apiUrl = process.env.GRAPH_API_URL ?? "http://127.0.0.1:3001/api/graph?batch=S2026&includeNonScoring=1";
const graph = await fetchJson(apiUrl);
const priorAttempts = await readJson(path.join("outputs", "discovery-attempts-current.json"), []);
const priorPaths = await readJson(path.join("outputs", "source-discovery-paths-current.json"), []);
const evidenceById = new Map(graph.evidence.map((item) => [item.id, item]));
const platforms = ["instagram", "x", "product_hunt", "youtube", "linkedin", "rss", "web", "hacker_news", "reddit"];
const plans = [];
const queryPatterns = [];

for (const node of graph.nodes) {
  const evidence = (node.evidenceIds ?? []).map((id) => evidenceById.get(id)).filter(Boolean);
  const platformsWithScoredEvidence = new Set(evidence.filter((item) => item.contributionScore > 0).map((item) => item.platform));
  const companyDomain = domainFor(node.websiteUrl);

  for (const platform of platforms) {
    if (platformsWithScoredEvidence.has(platform)) continue;
    const queries = queriesFor(platform, node, companyDomain);
    plans.push({
      company_id: node.entityId,
      company_name: node.label,
      platform,
      priority: priorityFor(node, platform),
      current_evidence_count: evidence.filter((item) => item.platform === platform).length,
      queries,
      reuse_key: `${platform}:${node.primaryIndustry}:${node.businessModel}`,
      status: "pending"
    });
    for (const query of queries) {
      queryPatterns.push({
        company_id: node.entityId,
        company_name: node.label,
        platform,
        query,
        source: "recursive_discovery_planner",
        status: "pending",
        result_count: 0,
        useful_result_count: 0
      });
    }
  }
}

const report = {
  generated_at: new Date().toISOString(),
  api_url: apiUrl,
  company_count: graph.nodes.length,
  task_count: plans.length,
  query_count: queryPatterns.length,
  high_priority: plans.filter((item) => item.priority === "high").length,
  learned_success_patterns: summarizeAttemptPatterns(priorAttempts, "success"),
  learned_failure_patterns: summarizeAttemptPatterns(priorAttempts, "failure"),
  useful_discovery_paths: summarizeDiscoveryPaths(priorPaths),
  plans: plans.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.company_name.localeCompare(b.company_name)),
  discovery_attempt_seeds: queryPatterns
};

await fs.mkdir("outputs", { recursive: true });
await fs.writeFile(path.join("outputs", "discovery-plan-s2026.json"), JSON.stringify(report, null, 2));
await updateDiscoveryDocs(report);

console.log(JSON.stringify({ outputPath: "outputs/discovery-plan-s2026.json", tasks: report.task_count, queries: report.query_count, highPriority: report.high_priority }, null, 2));

function queriesFor(platform, node, domain) {
  const company = quote(node.label);
  const founders = (node.founders ?? []).slice(0, 2).map((founder) => quote(founder.name));
  const base = {
    instagram: [
      `${company} "Y Combinator" Instagram`,
      `${company} "YC Spring 2026" Instagram`,
      `${company} site:instagram.com`,
      `${company} "startup" Instagram`,
      `${company} site:instagram.com/reel`,
      `${company} site:instagram.com/p`,
      `${company} "Instagram photos and videos"`
    ],
    x: [
      `${company} "Y Combinator" X`,
      `${company} "YC" "x.com"`,
      `${company} site:x.com`,
      `${company} site:twitter.com`,
      `${company} site:x.com status`,
      `${company} site:twitter.com status`,
      `${company} "YC" "x.com" status`
    ],
    product_hunt: [
      `${company} "Product Hunt"`,
      `${company} "launch"`,
      `${company} site:producthunt.com`,
      `${company} site:producthunt.com/products`,
      `${company} site:producthunt.com/posts`
    ],
    youtube: [
      `${company} site:youtube.com`,
      `${company} "demo" YouTube`,
      `${company} "launch" YouTube`,
      `${company} site:youtube.com/watch`,
      `${company} site:youtube.com/shorts`
    ],
    linkedin: [`${company} site:linkedin.com/company`, `${company} "YC" LinkedIn`],
    rss: [`${company} blog RSS`, `${company} engineering blog`, `${company} changelog`],
    web: [`${company} ${domain}`, `${company} "YC S2026"`, `${company} "Spring 2026"`],
    hacker_news: [`${company} site:news.ycombinator.com`, `${company} Hacker News`],
    reddit: [`${company} site:reddit.com`, `${company} reddit YC`]
  }[platform] ?? [`${company} ${platform}`];

  for (const founder of founders) {
    if (["instagram", "x", "linkedin"].includes(platform)) {
      base.push(`${founder} ${company} ${platform}`);
    }
  }

  return [...new Set(base)].slice(0, 8);
}

function priorityFor(node, platform) {
  if (node.label === "HeyClicky" && ["instagram", "x"].includes(platform)) return "high";
  if (platform === "instagram" && /consumer|creator|video|design|game|media|assistant/i.test(`${node.primaryIndustry} ${node.tagline ?? ""} ${node.description ?? ""}`)) {
    return "high";
  }
  if (platform === "x" && node.socialAccounts?.some((account) => account.platform === "x")) return "high";
  return "normal";
}

async function updateDiscoveryDocs(report) {
  const top = report.plans.slice(0, 80);
  const lines = [
    "# Discovery Learnings",
    "",
    "## Latest Recursive Discovery Plan",
    "",
    `- Generated at: ${report.generated_at}.`,
    `- Companies: ${report.company_count}.`,
    `- Planned platform tasks: ${report.task_count}.`,
    `- Planned query attempts: ${report.query_count}.`,
    `- High-priority tasks: ${report.high_priority}.`,
    `- Prior attempts analyzed: ${priorAttempts.length}.`,
    `- Prior discovery paths analyzed: ${priorPaths.length}.`,
    "",
    "## Highest Priority Planned Tasks",
    "",
    ...top.map((item) => `- ${item.company_name} / ${item.platform}: ${item.queries[0]}`),
    "",
    "## Successful Query / Source Patterns",
    "",
    ...formatPatternRows(report.learned_success_patterns),
    "",
    "## Failed Query / Source Patterns",
    "",
    ...formatPatternRows(report.learned_failure_patterns),
    "",
    "## Useful Discovery Paths",
    "",
    ...formatPathRows(report.useful_discovery_paths),
    "",
    "## Learned Strategy Rules",
    "",
    "- Use YC-linked company websites before search-only social candidates.",
    "- For Instagram/X gaps, combine exact company name, YC terms, platform domain filters, and founder-name variants.",
    "- Reuse query patterns by platform + industry + business model when a task succeeds.",
    "- Treat repeated `skipped` YC-profile-link attempts as evidence that website crawl and public search should run next.",
    "- Feed prior `sourceDiscoveryPaths` back into missing-social discovery so official-site social links can be retried by platform workers on resume.",
    "- Promote source-discovery paths only when `review_state` is verified or a post URL later passes public content checks.",
    "- Keep blocked public platforms in the plan, but mark them independently so the batch continues.",
    "",
    "Machine-readable output: `outputs/discovery-plan-s2026.json`.",
    ""
  ];
  await fs.writeFile(path.join("docs", "DISCOVERY_LEARNINGS.md"), lines.join("\n"));
}

function summarizeAttemptPatterns(attempts, kind) {
  const rows = new Map();
  for (const attempt of attempts) {
    const useful = Number(attempt.useful_result_count ?? 0);
    const status = String(attempt.status ?? "");
    const isSuccess = useful > 0 || status === "partial_success";
    const include = kind === "success" ? isSuccess : !isSuccess;
    if (!include) continue;
    const key = [
      attempt.platform ?? "unknown",
      attempt.source ?? "unknown",
      normalizeQueryPattern(attempt.query ?? ""),
      kind === "failure" ? normalizeFailure(attempt.failure_reason ?? status) : "useful"
    ].join("|");
    const current = rows.get(key) ?? {
      platform: attempt.platform ?? "unknown",
      source: attempt.source ?? "unknown",
      query_pattern: normalizeQueryPattern(attempt.query ?? ""),
      count: 0,
      useful_result_count: 0,
      result_count: 0,
      selected_urls: [],
      failure_reason: kind === "failure" ? normalizeFailure(attempt.failure_reason ?? status) : null
    };
    current.count += 1;
    current.useful_result_count += useful;
    current.result_count += Number(attempt.result_count ?? 0);
    if (attempt.selected_url && current.selected_urls.length < 5) {
      current.selected_urls.push(attempt.selected_url);
    }
    rows.set(key, current);
  }
  return [...rows.values()]
    .sort((left, right) => right.useful_result_count - left.useful_result_count || right.count - left.count)
    .slice(0, 30);
}

function summarizeDiscoveryPaths(paths) {
  const rows = new Map();
  for (const item of paths) {
    const key = [
      item.discovered_platform ?? "unknown",
      pathHost(item.source_url),
      item.review_state ?? "unknown",
      item.match_reason ?? "unknown"
    ].join("|");
    const current = rows.get(key) ?? {
      discovered_platform: item.discovered_platform ?? "unknown",
      source_host: pathHost(item.source_url),
      review_state: item.review_state ?? "unknown",
      match_reason: item.match_reason ?? "unknown",
      count: 0,
      examples: []
    };
    current.count += 1;
    if (item.discovered_url && current.examples.length < 5) {
      current.examples.push(`${item.company_name}: ${item.discovered_url}`);
    }
    rows.set(key, current);
  }
  return [...rows.values()].sort((left, right) => right.count - left.count).slice(0, 30);
}

function formatPatternRows(rows) {
  if (!rows.length) return ["- None recorded yet."];
  return rows.map((row) => {
    const reason = row.failure_reason ? `, failure ${row.failure_reason}` : "";
    const urls = row.selected_urls.length ? `, examples ${row.selected_urls.join(" ; ")}` : "";
    return `- ${row.platform} / ${row.source} / ${row.query_pattern}: ${row.count} attempts, ${row.useful_result_count} useful results${reason}${urls}.`;
  });
}

function formatPathRows(rows) {
  if (!rows.length) return ["- None recorded yet."];
  return rows.map(
    (row) =>
      `- ${row.discovered_platform} from ${row.source_host || "unknown"} (${row.review_state}): ${row.count} paths, ${row.match_reason}. Examples: ${row.examples.join(" ; ") || "none"}.`
  );
}

function normalizeQueryPattern(query) {
  return String(query)
    .replace(/"[^"]+"/g, '"{name}"')
    .replace(/\b[A-Z][A-Za-z0-9.-]{2,}\b/g, "{name}")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function normalizeFailure(reason) {
  return String(reason)
    .replace(/https?:\/\/\S+/g, "{url}")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function pathHost(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function domainFor(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function quote(value) {
  return `"${value.replace(/"/g, "")}"`;
}

function priorityRank(priority) {
  return priority === "high" ? 0 : 1;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Graph API failed with ${response.status}`);
  return response.json();
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}
