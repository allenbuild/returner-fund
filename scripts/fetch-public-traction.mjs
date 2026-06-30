import * as cheerio from "cheerio";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = process.cwd();
const ycSnapshotPath = join(root, "src", "lib", "yc", "spring-2026-companies.json");
const outputPath = join(root, "src", "lib", "social", "public-evidence-current.json");
const checkpointPath = join(root, "work", "public-traction-checkpoint.json");
const now = new Date().toISOString();
const companyLimit = numberArg("--max-companies") ?? Number.POSITIVE_INFINITY;
const companyFilter = stringArg("--company")?.toLowerCase();
const socialMode = stringArg("--social") ?? "company"; // company | all | none
const platformInput = stringArg("--platforms") ?? stringArg("--platform") ?? "";
const platformFilter = new Set(
  platformInput
    .split(",")
    .map((item) => normalizePlatformArg(item.trim()))
    .filter(Boolean)
);
const requestDelayMs = numberArg("--delay-ms") ?? 450;
const workerCount = numberArg("--workers") ?? 8;
const forceRefresh = hasArg("--force");
const discoverMissingSocial = hasArg("--discover-missing-social") || platformFilter.size > 0;
const discoveryAttemptsPath = join(root, "outputs", "discovery-attempts-current.json");
const sourceDiscoveryPathsPath = join(root, "outputs", "source-discovery-paths-current.json");

const ycSnapshot = JSON.parse(await readFile(ycSnapshotPath, "utf8"));
const checkpoint = await readJson(checkpointPath, {
  attempts: {},
  evidence: [],
  needsReview: [],
  failures: [],
  discoveryAttempts: [],
  sourceDiscoveryPaths: []
});
const attemptMap = new Map(
  Object.entries(checkpoint.attempts ?? {}).filter(([, attempt]) => !isObsoleteInternalFailure(attempt))
);
const evidence = checkpoint.evidence ?? [];
const needsReview = checkpoint.needsReview ?? [];
const failures = checkpoint.failures ?? [];
const discoveryAttempts = (checkpoint.discoveryAttempts ?? []).filter((item) => !isObsoleteInternalFailure(item));
const sourceDiscoveryPaths = checkpoint.sourceDiscoveryPaths ?? [];
const companyBySlug = new Map(ycSnapshot.companies.map((company) => [company.slug, company]));
let checkpointWriteChain = Promise.resolve();
const platformCooldowns = new Map();
const INGEST_METRIC_WEIGHTS = {
  github: { stars: 1.5, forks: 4, watchers: 2, issues: 0.5, open_issues: 0.5, recent_commits_30d: 1 },
  x: { views: 0.02, likes: 1, replies: 3, comments: 3, reposts: 4, shares: 4, quotes: 4 },
  linkedin: { views: 0.02, likes: 1, reactions: 1, comments: 3, reposts: 4, shares: 4 },
  instagram: { views: 0.02, likes: 1, comments: 3, shares: 4, reposts: 4, saves: 4 },
  product_hunt: { upvotes: 2, comments: 3 },
  youtube: { views: 0.02, likes: 1, comments: 3 },
  hacker_news: { upvotes: 2, comments: 3 },
  reddit: { upvotes: 2, comments: 3 },
  bilibili: { views: 0.02, likes: 1, comments: 3, shares: 4 }
};
const COMMON_DESCRIPTOR_TOKENS = new Set([
  "about",
  "after",
  "again",
  "agent",
  "agents",
  "based",
  "build",
  "building",
  "company",
  "customer",
  "customers",
  "data",
  "every",
  "founder",
  "founders",
  "helps",
  "platform",
  "product",
  "software",
  "startup",
  "their",
  "through",
  "using",
  "where",
  "which",
  "with",
  "world"
]);

const companies = ycSnapshot.companies
  .filter(
    (company) =>
      !companyFilter ||
      company.slug.toLowerCase() === companyFilter ||
      company.name.toLowerCase() === companyFilter ||
      company.name.toLowerCase().includes(companyFilter)
  )
  .slice(0, companyLimit);

const taskPlan = companies.flatMap(buildCompanyTasks);
await runTaskPlan(taskPlan, workerCount);

const payload = {
  source: {
    label: "Public unauthenticated platform/page ingestion",
    fetchedAt: now,
    companiesAttemptedThisRun: companies.length,
    checkpointFlushOnly: taskPlan.length === 0,
    checkpointCompanyCount: new Set([
      ...evidence.map((item) => item.companySlug).filter(Boolean),
      ...needsReview.map((item) => item.companySlug).filter(Boolean),
      ...failures.map((item) => item.companySlug).filter(Boolean)
    ]).size,
    taskCountThisRun: taskPlan.length,
    checkpointAttemptCount: attemptMap.size,
    workerCount,
    forcedRefresh: forceRefresh,
    platformsAttempted: [
      "x",
      "linkedin",
      "instagram",
      "product_hunt",
      "youtube",
      "web",
      "rss",
      "hacker_news",
      "reddit"
    ],
    notes: [
      "Read-only public requests only.",
      "No account login, cookies, private APIs, browser sessions, or mutations.",
      "Blocked platforms are logged per company and do not fail the batch.",
      "YC profile text is not used as traction evidence.",
      ...(taskPlan.length === 0
        ? ["This write flushed the existing checkpoint to the app snapshot without making network requests."]
        : [])
    ]
  },
  evidence: dedupeById(evidence).map(normalizeStoredEvidence).filter(Boolean),
  needsReview: normalizeNeedsReviewItems(needsReview),
  failures: dedupeFailures(failures)
};

await writeJson(outputPath, payload);
await writeJson(discoveryAttemptsPath, dedupeDiscoveryAttempts(discoveryAttempts));
await writeJson(sourceDiscoveryPathsPath, dedupeById(sourceDiscoveryPaths));
await writeCheckpoint();
console.log(
  `Wrote ${payload.evidence.length} evidence items, ${payload.needsReview.length} review candidates, ${payload.failures.length} failures, ${dedupeById(discoveryAttempts).length} discovery attempts.`
);

function buildCompanyTasks(company) {
  const tasks = [
    connectorTask("website", company.slug, company, () => ingestWebsite(company)),
    connectorTask("rss", company.slug, company, () => ingestRss(company)),
    connectorTask("hacker_news", company.slug, company, () => ingestHackerNews(company)),
    connectorTask("youtube", company.slug, company, () => ingestYouTube(company)),
    connectorTask("product_hunt", company.slug, company, () => ingestProductHunt(company)),
    connectorTask("news_web", company.slug, company, () => ingestNewsWeb(company)),
    connectorTask("reddit", company.slug, company, () => ingestReddit(company))
  ];

  if (socialMode !== "none") {
    tasks.push(...socialTasksForEntity(company, company, "company"));
    if (socialMode === "all") {
      for (const founder of company.founders ?? []) {
        tasks.push(...socialTasksForEntity(company, founder, "founder"));
      }
    }
  }

  return tasks.filter(Boolean);
}

function connectorTask(platform, key, company, fn) {
  if (!platformAllowed(platform)) return null;
  return {
    lane: normalizePlatformArg(platform),
    company,
    label: `${normalizePlatformArg(platform)}:${company.slug}`,
    run: () => attempt(platform, key, company, fn)
  };
}

function socialTasksForEntity(company, entity, entityType) {
  return ["x", "linkedin", "instagram"]
    .filter((platform) => platformAllowed(platform))
    .map((platform) => ({
      lane: platform,
      company,
      label: `${platform}:${company.slug}:${entityType}:${entity.id ?? entity.slug}`,
      run: () => attemptSocialProfile(company, entity, entityType, platform)
    }));
}

async function runTaskPlan(tasks, maxWorkers) {
  const grouped = new Map();
  for (const task of tasks) {
    grouped.set(task.lane, [...(grouped.get(task.lane) ?? []), task]);
  }

  const lanes = [...grouped.entries()].map(([lane, laneTasks]) =>
    runLane(lane, laneTasks, Math.min(maxWorkers, platformConcurrency(lane)))
  );
  await Promise.all(lanes);
}

async function runLane(lane, tasks, limit) {
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async (_, workerIndex) => {
    while (cursor < tasks.length) {
      const task = tasks[cursor];
      cursor += 1;
      console.log(`[${lane}/worker-${workerIndex + 1}] ${task.label}`);
      const cooldown = platformCooldowns.get(lane);
      if (cooldown && cooldown.until > Date.now()) {
        failures.push(
          failure(
            lane,
            task.company,
            null,
            `Platform cooldown active until ${new Date(cooldown.until).toISOString()}: ${cooldown.reason}`
          )
        );
        await writeCheckpoint();
        continue;
      }
      await task.run();
    }
  });
  await Promise.all(workers);
}

function platformConcurrency(lane) {
  if (lane === "instagram") return 2;
  if (lane === "x") return 2;
  if (lane === "linkedin") return 1;
  if (lane === "reddit") return 2;
  if (lane === "product_hunt") return 2;
  if (lane === "youtube") return 3;
  if (lane === "rss") return 4;
  if (lane === "hacker_news") return 4;
  return 5;
}

async function attempt(platform, key, company, fn) {
  if (!platformAllowed(platform)) return;
  const normalizedPlatform = normalizePlatformArg(platform);
  const attemptKey = `${platform}:${key}`;
  if (!forceRefresh && attemptMap.get(attemptKey)?.status === "done") return;

  try {
    const result = await fn();
    addItems(result?.evidence ?? [], evidence);
    addItems(result?.needsReview ?? [], needsReview);
    addItems(result?.failures ?? [], failures);
    addItems(result?.sourceDiscoveryPaths ?? [], sourceDiscoveryPaths);
    const attemptSummary = summarizeConnectorResult(result);
    discoveryAttempts.push(
      discoveryAttempt({
        company,
        platform: normalizedPlatform,
        query: result?.query ?? defaultQueryFor(company, normalizedPlatform),
        source: result?.source ?? "public_connector",
        resultCount: attemptSummary.resultCount,
        usefulResultCount: attemptSummary.usefulResultCount,
        selectedUrl: selectedResultUrl(result),
        status: attemptSummary.status,
        failureReason: attemptSummary.failureReason
      })
    );
    attemptMap.set(attemptKey, { status: "done", checkedAt: now });
  } catch (error) {
    recordPlatformCooldownIfNeeded(normalizedPlatform, error);
    failures.push(failure(normalizedPlatform, company, null, errorMessage(error)));
    discoveryAttempts.push(
      discoveryAttempt({
        company,
        platform: normalizedPlatform,
        query: defaultQueryFor(company, normalizedPlatform),
        source: "public_connector",
        resultCount: 0,
        usefulResultCount: 0,
        selectedUrl: null,
        status: "failed",
        failureReason: errorMessage(error)
      })
    );
    attemptMap.set(attemptKey, { status: "failed", checkedAt: now, error: errorMessage(error) });
  }

  await writeCheckpoint();
  await delay(requestDelayMs);
}

function summarizeConnectorResult(result) {
  const evidenceRows = result?.evidence ?? [];
  const reviewRows = result?.needsReview ?? [];
  const failureRows = result?.failures ?? [];
  const usefulResultCount = evidenceRows.filter((item) => item.contributionScore > 0 || item.review_state === "verified").length;
  const resultCount = evidenceRows.length + reviewRows.length;

  if (usefulResultCount > 0) {
    return {
      resultCount,
      usefulResultCount,
      status: failureRows.length || reviewRows.length ? "partial_success" : "success",
      failureReason: failureRows[0]?.message ?? reviewRows[0]?.matchReason ?? null
    };
  }

  if (reviewRows.length > 0) {
    return {
      resultCount,
      usefulResultCount,
      status: "needs_review",
      failureReason: reviewRows[0]?.matchReason ?? "Only review candidates were found."
    };
  }

  if (failureRows.length > 0) {
    return {
      resultCount,
      usefulResultCount,
      status: "failed",
      failureReason: failureRows[0]?.message ?? "Connector returned failures only."
    };
  }

  return {
    resultCount,
    usefulResultCount,
    status: "skipped",
    failureReason: "Connector returned no evidence, review candidates, or failures."
  };
}

async function attemptSocialProfile(company, entity, entityType, platform) {
  const url = entity.socialLinks?.[platform];
  const entityId = entityIdFor(company, entity, entityType);
  const name = entityName(entity, entityType);

  if (!url) {
    if (entityType === "company") {
      const discoveredPathCandidates = discoveredSocialCandidatesFromPaths(company, platform);
      const searchCandidates = discoverMissingSocial ? await discoverSocialCandidates(company, platform) : [];
      const candidates = dedupeSocialCandidates([...discoveredPathCandidates, ...searchCandidates]);
      if (candidates.length) {
        const verifiedPostResults = [];
        const postCandidates = candidates.filter((candidate) => isSocialPostUrl(candidate.url, platform)).slice(0, 2);
        for (const candidate of postCandidates) {
          verifiedPostResults.push(await verifyPublicSocialPostCandidate(company, platform, candidate));
        }
        const verifiedPosts = verifiedPostResults.flatMap((result) => result.evidence ?? []);
        const verifiedPostUrls = new Set(verifiedPosts.map((item) => item.sourceUrl));
        const reviewItems = [
          ...verifiedPostResults.flatMap((result) => result.needsReview ?? []),
          ...candidates
            .filter((candidate) => !verifiedPostUrls.has(candidate.url) && !postCandidates.some((postCandidate) => postCandidate.url === candidate.url))
            .map((candidate) =>
              reviewCandidate(
                company,
                platform,
                candidate.url,
                `Public search discovered this ${platform} candidate; profile/post verification is required before scoring.`
              )
            )
        ];
        addItems(verifiedPosts, evidence);
        addItems(reviewItems, needsReview);
        addItems(
          candidates.map((candidate) =>
            sourceDiscoveryPath({
              company,
              sourceUrl: candidate.searchUrl,
              discoveredUrl: candidate.url,
              discoveredPlatform: platform,
              discoveredEntityType: "company",
              discoveredEntityName: company.name,
              matchReason: verifiedPostUrls.has(candidate.url)
                ? `Verified post-level public evidence from search query "${candidate.query}".`
                : `Found from public search query "${candidate.query}".`,
              reviewState: verifiedPostUrls.has(candidate.url) ? "verified" : "needs_review"
            })
          ),
          sourceDiscoveryPaths
        );
        discoveryAttempts.push(
          discoveryAttempt({
            company,
            platform,
            query: candidates[0].query,
            source: "public_search_missing_social",
            resultCount: candidates.length,
            usefulResultCount: verifiedPosts.length,
            selectedUrl: verifiedPosts[0]?.sourceUrl ?? candidates[0].url,
            status: verifiedPosts.length ? "partial_success" : "needs_review",
            failureReason: verifiedPosts.length ? null : "No YC-linked URL; public search candidates require review."
          })
        );
      } else {
        failures.push(failure(platform, company, null, "No public URL linked from YC."));
        discoveryAttempts.push(
          discoveryAttempt({
            company,
            platform,
            query: `${company.name} ${platform}`,
            source: "yc_profile_social_links",
            resultCount: 0,
            usefulResultCount: 0,
            selectedUrl: null,
            status: "skipped",
            failureReason: "No public URL linked from YC."
          })
        );
      }
      await writeCheckpoint();
      await delay(requestDelayMs);
    }
    return;
  }

  if (!urlMatchesPlatform(url, platform)) {
    const candidate = reviewCandidate(
      company,
      platform,
      url,
      `YC-linked ${platform} URL points to a different platform host and was not scored.`,
      entityType,
      entityId,
      name
    );
    needsReview.push(candidate);
    discoveryAttempts.push(
      discoveryAttempt({
        company,
        platform,
        query: `${name} ${company.name} ${platform}`,
        source: "yc_profile_social_links",
        resultCount: 1,
        usefulResultCount: 0,
        selectedUrl: url,
        status: "needs_review",
        failureReason: candidate.matchReason
      })
    );
    await writeCheckpoint();
    await delay(requestDelayMs);
    return;
  }

  const key = `${platform}:${entityType}:${entity.id ?? entity.slug}:${url}`;
  if (!forceRefresh && attemptMap.get(key)?.status === "done") return;

  try {
    const result = await ingestSocialProfile(company, entity, entityType, platform, url);
    addItems(result.evidence, evidence);
    addItems(result.needsReview, needsReview);
    addItems(result.failures, failures);
    addItems(result.sourceDiscoveryPaths ?? [], sourceDiscoveryPaths);
    const attemptSummary = summarizeConnectorResult(result);
    discoveryAttempts.push(
      discoveryAttempt({
        company,
        platform,
        query: `${name} ${company.name} ${platform}`,
        source: "yc_profile_social_links",
        resultCount: attemptSummary.resultCount,
        usefulResultCount: attemptSummary.usefulResultCount,
        selectedUrl: selectedResultUrl(result) ?? url,
        status: attemptSummary.status,
        failureReason: attemptSummary.failureReason
      })
    );
    attemptMap.set(key, { status: "done", checkedAt: now });
  } catch (error) {
    recordPlatformCooldownIfNeeded(platform, error);
    failures.push(failure(platform, company, url, errorMessage(error), entityType, name));
    discoveryAttempts.push(
      discoveryAttempt({
        company,
        platform,
        query: `${name} ${company.name} ${platform}`,
        source: "yc_profile_social_links",
        resultCount: 0,
        usefulResultCount: 0,
        selectedUrl: url,
        status: "failed",
        failureReason: errorMessage(error)
      })
    );
    attemptMap.set(key, { status: "failed", checkedAt: now, error: errorMessage(error) });
  }

  await writeCheckpoint();
  await delay(requestDelayMs);
}

function discoveredSocialCandidatesFromPaths(company, platform) {
  return sourceDiscoveryPaths
    .filter((item) => item.company_slug === company.slug)
    .filter((item) => item.discovered_platform === platform)
    .filter((item) => urlMatchesPlatform(item.discovered_url, platform))
    .map((item) => ({
      query: `${company.name} ${platform} from discovered public source path`,
      searchUrl: item.source_url,
      title: item.discovered_entity_name || company.name,
      snippet: item.match_reason,
      url: canonicalProfileUrl(item.discovered_url, platform)
    }));
}

async function ingestWebsite(company) {
  if (!company.websiteUrl) {
    return { failures: [failure("web", company, null, "No company website URL.")] };
  }

  const page = await fetchReadable(company.websiteUrl, { readerFallback: true });
  if (isBlocked(page.text)) {
    return { failures: [failure("web", company, company.websiteUrl, "Website returned a block/login/CAPTCHA page.")] };
  }

  const discoveredSocial = discoverSocialLinks(company, page.html, company.websiteUrl);

  return {
    evidence: [
      evidenceItem({
        company,
        entityType: "company",
        entityId: companyId(company),
        platform: "web",
        sourceUrl: company.websiteUrl,
        title: page.title || company.name,
        text: firstUsefulText(page.text),
        rawVisibleText: page.text,
        metrics: {},
        contributionScore: 0,
        review_state: "verified",
        matchReason: "Official company website from YC public profile. Stored as context only; not scored as traction."
      })
    ],
    needsReview: discoveredSocial.map((item) =>
      reviewCandidate(
        company,
        item.platform,
        item.url,
        `Discovered from official company website; queued for public profile/post verification before scoring.`
      )
    ),
    sourceDiscoveryPaths: discoveredSocial.map((item) =>
      sourceDiscoveryPath({
        company,
        sourceUrl: company.websiteUrl,
        discoveredUrl: item.url,
        discoveredPlatform: item.platform,
        discoveredEntityType: "company",
        discoveredEntityName: company.name,
        matchReason: "Found as an outbound social/profile link on the official public company website.",
        reviewState: "needs_review"
      })
    )
  };
}

async function ingestRss(company) {
  if (!company.websiteUrl) {
    return { failures: [failure("rss", company, null, "No company website URL for feed discovery.")] };
  }

  const homepage = await fetchReadable(company.websiteUrl, { readerFallback: false }).catch(() => null);
  const feedUrls = discoverFeedUrls(company.websiteUrl, homepage?.html ?? "");
  if (!feedUrls.length) {
    return { failures: [failure("rss", company, company.websiteUrl, "No RSS/Atom feed discovered on public homepage.")] };
  }

  const feedEvidence = [];
  const feedFailures = [];
  for (const feedUrl of feedUrls.slice(0, 2)) {
    try {
      const response = await fetchPublic(feedUrl);
      const xml = await response.text();
      const items = parseFeedItems(xml).slice(0, 5);
      for (const item of items) {
        feedEvidence.push(
          evidenceItem({
            company,
            entityType: "company",
            entityId: companyId(company),
            platform: "rss",
            sourceUrl: item.link || feedUrl,
            title: item.title || company.name,
            text: item.description || item.title || company.name,
            rawVisibleText: item.raw,
            postedAt: item.publishedAt,
            metrics: {},
            contributionScore: 0,
            review_state: "verified",
            matchReason: "Public RSS/Atom item from the company website. Stored as public content context; not scored without public engagement metrics."
          })
        );
      }
    } catch (error) {
      feedFailures.push(failure("rss", company, feedUrl, errorMessage(error)));
    }
  }

  return { evidence: feedEvidence, failures: feedFailures };
}

async function ingestHackerNews(company) {
  const query = encodeURIComponent(`"${company.name}"`);
  const url = `https://hn.algolia.com/api/v1/search?query=${query}&tags=story&hitsPerPage=5`;
  const response = await fetchPublic(url, { accept: "application/json" });
  const data = await response.json();
  const hits = (data.hits ?? []).filter((hit) =>
    isStrongPublicMatch(company, `${hit.title ?? ""} ${hit.url ?? ""}`, hit.url ?? "") &&
    isCurrentBatchHackerNewsHit(`${hit.title ?? ""} ${hit.url ?? ""}`)
  );

  if (!hits.length) {
    return { failures: [failure("hacker_news", company, url, "No verified public Hacker News matches.")] };
  }

  return {
    evidence: hits.map((hit) =>
      evidenceItem({
        company,
        entityType: "company",
        entityId: companyId(company),
        platform: "hacker_news",
        sourceUrl: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
        title: hit.title || company.name,
        text: hit.title || company.name,
        rawVisibleText: JSON.stringify(hit),
        postedAt: hit.created_at,
        metrics: {
          upvotes: numberOrNull(hit.points),
          comments: numberOrNull(hit.num_comments)
        },
        contributionScore: scoreMetrics("hacker_news", {
          upvotes: numberOrNull(hit.points),
          comments: numberOrNull(hit.num_comments)
        }),
        review_state: "verified",
        matchReason: "Exact company-name match in public Hacker News Algolia result."
      })
    )
  };
}

async function ingestYouTube(company) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(`${company.name} YC startup`)}`;
  const response = await fetchPublic(url);
  const html = await response.text();
  const results = parseYouTubeResults(html)
    .filter((item) => isStrongPublicMatch(company, `${item.title} ${item.description}`, ""))
    .slice(0, 3);

  if (!results.length) {
    return { failures: [failure("youtube", company, url, "No verified public YouTube result match.")] };
  }

  return {
    evidence: results.map((video) =>
      evidenceItem({
        company,
        entityType: "company",
        entityId: companyId(company),
        platform: "youtube",
        sourceUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
        title: video.title,
        text: video.description || video.title,
        rawVisibleText: video.raw,
        metrics: {
          views: video.views
        },
        contributionScore: scoreMetrics("youtube", { views: video.views }),
        review_state: "verified",
        matchReason: "Exact company-name match in public YouTube search result."
      })
    )
  };
}

async function ingestProductHunt(company) {
  const url = `https://www.producthunt.com/search?q=${encodeURIComponent(company.name)}`;
  const page = await fetchReader(url);
  if (isBlocked(page.text)) {
    return { failures: [failure("product_hunt", company, url, "Product Hunt public search was blocked.")] };
  }

  const searchPageLinks = extractMarkdownLinks(page.text)
    .filter((link) => link.url.includes("producthunt.com"))
    .filter((link) => /\/(products|posts)\//.test(link.url))
    .filter((link) => !/\/reviews\b|\/products\/lovable\b/i.test(link.url));
  const webSearchLinks = await searchProductHuntLinks(company);
  const links = dedupeProductHuntLinks([...searchPageLinks, ...webSearchLinks])
    .filter((link) => productHuntCandidateMatches(company, link))
    .slice(0, 5);
  const verified = [];
  const reviewCandidates = [];

  for (const link of links) {
    const result = await verifyProductHuntLink(company, link);
    if (result.evidence) verified.push(result.evidence);
    if (result.needsReview) reviewCandidates.push(result.needsReview);
    if (verified.length >= 3) break;
  }

  if (!verified.length) {
    const candidate = reviewCandidates[0] ?? links[0];
    return candidate
      ? {
          needsReview: [
            reviewCandidate(
              company,
              "product_hunt",
              candidate.url,
              candidate.reason
                ? `Product Hunt public result needs review: ${candidate.reason}.`
                : "Product Hunt public result did not clearly match both the company name and official domain."
            )
          ]
        }
      : { failures: [failure("product_hunt", company, url, "No public Product Hunt result links found.")] };
  }

  return {
    evidence: verified
  };
}

async function searchProductHuntLinks(company) {
  const queries = [
    `site:producthunt.com/products "${company.name}"`,
    `site:producthunt.com/posts "${company.name}"`
  ];
  const links = [];

  for (const query of queries) {
    const response = await fetchPublic(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
    if (response.status >= 400) continue;
    const html = await response.text();
    const $ = cheerio.load(html);
    $(".result")
      .toArray()
      .slice(0, 5)
      .forEach((node) => {
        const item = $(node);
        const title = cleanText(item.find(".result__title").text());
        const sourceUrl = normalizeSearchUrl(item.find(".result__a").attr("href") ?? "");
        if (/producthunt\.com\/(products|posts)\//i.test(sourceUrl)) {
          links.push({ text: title, url: sourceUrl });
        }
      });
  }

  return links;
}

async function discoverSocialCandidates(company, platform, entity = null) {
  const queries = socialDiscoveryQueries(company, platform, entity);
  const candidates = [];

  const maxQueries = platform === "instagram" || platform === "x" ? 8 : 5;
  for (const query of queries.slice(0, maxQueries)) {
    try {
      const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const response = await fetchPublic(searchUrl);
      if (response.status >= 400) continue;
      const html = await response.text();
      const $ = cheerio.load(html);
      $(".result")
        .toArray()
        .slice(0, 8)
        .forEach((node) => {
          const item = $(node);
          const title = cleanText(item.find(".result__title").text());
          const snippet = cleanText(item.find(".result__snippet").text());
          const url = normalizeSearchUrl(item.find(".result__a").attr("href") ?? "");
          if (!urlMatchesPlatform(url, platform)) return;
          if (!isCompanyMatch(company, `${title} ${snippet} ${url}`)) return;
          candidates.push({
            query,
            searchUrl,
            title,
            snippet,
            url: canonicalProfileUrl(url, platform)
          });
        });
    } catch {
      // Search discovery is opportunistic. Connector failures are captured at the parent attempt level.
    }
  }

  return [
    ...new Map(
      candidates
        .filter((candidate) => !isLowValueSocialUrl(candidate.url, platform))
        .map((candidate) => [candidate.url, candidate])
    ).values()
  ].slice(0, 5);
}

function dedupeSocialCandidates(candidates) {
  return [
    ...new Map(
      candidates
        .filter((candidate) => candidate?.url)
        .filter((candidate) => !isLowValueSocialUrl(candidate.url, platformFromUrl(candidate.url)))
        .map((candidate) => [candidate.url, candidate])
    ).values()
  ].slice(0, 8);
}

function socialDiscoveryQueries(company, platform, entity = null) {
  const platformLabel =
    platform === "x" ? "X" : platform === "instagram" ? "Instagram" : platform === "linkedin" ? "LinkedIn" : platform;
  const site =
    platform === "x"
      ? "site:x.com OR site:twitter.com"
      : platform === "instagram"
        ? "site:instagram.com"
        : "site:linkedin.com/company OR site:linkedin.com/in";
  const baseQueries = [
    `"${company.name}" "Y Combinator" ${platformLabel}`,
    `"${company.name}" "YC Spring 2026" ${platformLabel}`,
    `"${company.name}" ${site}`,
    `"${company.name}" "startup" ${platformLabel}`
  ];

  const entityQueries = socialEntityQueries(company, platform, entity, platformLabel);

  if (platform === "instagram") {
    return [
      ...baseQueries,
      ...entityQueries,
      `"${company.name}" site:instagram.com/reel`,
      `"${company.name}" site:instagram.com/p`,
      `"${company.name}" "Instagram photos and videos"`
    ];
  }

  if (platform === "x") {
    return [
      ...baseQueries,
      ...entityQueries,
      `"${company.name}" site:x.com status`,
      `"${company.name}" site:twitter.com status`,
      `"${company.name}" "YC" "x.com" status`
    ];
  }

  return [...baseQueries, ...entityQueries];
}

function socialEntityQueries(company, platform, entity, platformLabel) {
  const entityNameValue = String(entity?.name ?? "").trim();
  if (!entityNameValue || entityNameValue.toLowerCase() === company.name.toLowerCase()) {
    return [];
  }

  const queries = [
    `"${entityNameValue}" "${company.name}" ${platformLabel}`,
    `"${entityNameValue}" "${company.name}" site:${platform === "x" ? "x.com" : platform === "instagram" ? "instagram.com" : "linkedin.com"}`
  ];

  if (platform === "x") {
    queries.push(`"${entityNameValue}" "${company.name}" site:x.com status`);
  }
  if (platform === "instagram") {
    queries.push(`"${entityNameValue}" "${company.name}" site:instagram.com/reel`);
    queries.push(`"${entityNameValue}" "${company.name}" site:instagram.com/p`);
  }

  return queries;
}

function isLowValueSocialUrl(url, platform) {
  if (platform === "instagram") return /\/(p|reel|tv)\/[^/]+\/(?:liked_by|comments)\/?$/i.test(url);
  if (platform === "x") return /\/(intent|share|search)(\/|$)/i.test(url);
  if (platform === "linkedin") return /\/shareArticle\b|\/jobs\b|\/learning\b/i.test(url);
  return false;
}

function dedupeProductHuntLinks(links) {
  return [
    ...new Map(
      links
        .map((link) => ({ ...link, url: normalizeSearchUrl(link.url).replace(/[?#].*$/, "") }))
        .filter((link) => /^https:\/\/www\.producthunt\.com\/(products|posts)\//i.test(link.url))
        .filter((link) => !/\/reviews\b|\/products\/lovable\b/i.test(link.url))
        .map((link) => [link.url, link])
    ).values()
  ];
}

async function verifyProductHuntLink(company, link) {
  const page = await fetchReader(link.url).catch(() => null);
  if (!page || isBlocked(page.text)) return { needsReview: link };

  const verification = productHuntVerification(company, link, page);
  const verified = verification.verified;
  if (!verified) {
    if (/title did not match company name/i.test(verification.reason ?? "")) {
      return {};
    }

    return {
      needsReview: {
        ...link,
        reason: verification.reason
      }
    };
  }

  const metrics = {
    upvotes: parseNearbyMetric(page.text, "upvotes", /(\d[\d,]*)\s+upvotes?/i),
    comments: parseNearbyMetric(page.text, "comments", /(\d[\d,]*)\s+comments?/i)
  };

  return {
    evidence: evidenceItem({
      company,
      entityType: "company",
      entityId: companyId(company),
      platform: "product_hunt",
      sourceUrl: link.url,
      title: page.title || link.text || company.name,
      text: firstUsefulText(page.text) || page.title || link.text || company.name,
      rawVisibleText: page.text,
      metrics,
      contributionScore: scoreMetrics("product_hunt", metrics),
      review_state: "verified",
      matchReason: `Verified public Product Hunt page: ${verification.reason}.`
    })
  };
}

function productHuntVerification(company, link, page) {
  const title = page.title || link.text || "";
  const combined = `${title} ${page.text}`;
  const titleMatches = productHuntTitleMatches(company, title);
  if (!titleMatches) {
    return { verified: false, reason: "title did not match company name" };
  }

  if (companyDomainMentioned(company, combined)) {
    return { verified: true, reason: "title matched and official company domain appeared on the Product Hunt page" };
  }

  if (productHuntSlugMatchesCompany(company, link.url)) {
    return { verified: true, reason: "title matched and Product Hunt slug matched the company name" };
  }

  if (founderNameMentioned(company, combined)) {
    return { verified: true, reason: "title matched and a YC-listed founder name appeared on the Product Hunt page" };
  }

  const tokenMatches = companyDescriptorTokenMatches(company, combined);
  if (tokenMatches >= 3) {
    return { verified: true, reason: `title matched and ${tokenMatches} company descriptor tokens appeared on the Product Hunt page` };
  }

  return { verified: false, reason: "title matched, but no official domain, founder, slug, or descriptor corroboration appeared" };
}

function productHuntTitleMatches(company, title) {
  const normalizedTitle = cleanText(title)
    .toLowerCase()
    .replace(/\s*\|\s*product hunt.*$/i, "");
  const normalizedName = company.name.toLowerCase();
  if (normalizedName.length <= 3) {
    return new RegExp(`(^|\\W)${escapeRegExp(normalizedName)}(\\W|$)`, "i").test(normalizedTitle);
  }
  return normalizedTitle.includes(normalizedName);
}

function productHuntSlugMatchesCompany(company, rawUrl) {
  try {
    const path = new URL(rawUrl).pathname.toLowerCase();
    const lastSegment = path.split("/").filter(Boolean).at(-1) ?? "";
    const companySlug = slugify(company.name);
    const ycSlug = slugify(company.slug ?? "");
    if (!lastSegment || companySlug.length < 4) return false;
    return lastSegment === companySlug || lastSegment === ycSlug;
  } catch {
    return false;
  }
}

function companyDescriptorTokenMatches(company, text) {
  const lower = cleanText(text).toLowerCase();
  const tokens = new Set(
    `${company.tagline ?? ""} ${company.description ?? ""} ${(company.industries ?? []).join(" ")}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 5)
      .filter((token) => !COMMON_DESCRIPTOR_TOKENS.has(token))
  );
  return [...tokens].filter((token) => lower.includes(token)).length;
}

function productHuntCandidateMatches(company, link) {
  const haystack = cleanText(`${link.text ?? ""} ${link.url ?? ""}`).toLowerCase();
  const normalizedName = company.name.toLowerCase();
  const slugTokens = new Set([
    ...slugify(company.name).split("-"),
    ...slugify(company.slug ?? "").split("-")
  ].filter((token) => token.length >= 3));

  if (normalizedName.length <= 3) {
    return new RegExp(`(^|\\W)${escapeRegExp(normalizedName)}(\\W|$)`, "i").test(haystack);
  }

  if (haystack.includes(normalizedName) || haystack.includes(slugify(company.name))) {
    return true;
  }

  const matchedTokens = [...slugTokens].filter((token) => haystack.includes(token)).length;
  return matchedTokens >= Math.min(2, slugTokens.size);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function ingestNewsWeb(company) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(`${company.name} YC startup`)}`;
  const response = await fetchPublic(url);
  const html = await response.text();
  const $ = cheerio.load(html);
  const results = $(".result")
    .toArray()
    .map((node) => {
      const item = $(node);
      return {
        title: cleanText(item.find(".result__title").text()),
        sourceUrl: item.find(".result__a").attr("href") ?? "",
        snippet: cleanText(item.find(".result__snippet").text())
      };
    })
    .filter((item) => item.sourceUrl && isCompanyMatch(company, `${item.title} ${item.snippet}`))
    .map((item) => ({ ...item, sourceUrl: normalizeSearchUrl(item.sourceUrl) }))
    .filter((item) => isThirdPartyMention(company, item.sourceUrl))
    .slice(0, 3);

  if (!results.length) {
    return { failures: [failure("web", company, url, "No verified public web/news mention found.")] };
  }

  return {
    evidence: results.map((item) =>
      evidenceItem({
        company,
        entityType: "company",
        entityId: companyId(company),
        platform: "web",
        sourceUrl: item.sourceUrl,
        title: item.title,
        text: item.snippet || item.title,
        rawVisibleText: `${item.title}\n${item.snippet}`,
        metrics: {},
        contributionScore: 0,
        review_state: "verified",
        matchReason: "Public web/news result with exact company-name match. Stored as context only because no public engagement metrics were available."
      })
    )
  };
}

async function ingestReddit(company) {
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(`${company.name} YC`)}&limit=5&raw_json=1`;
  try {
    const response = await fetchPublic(url, { accept: "application/json" });
    const data = await response.json();
    const posts = (data.data?.children ?? [])
      .map((child) => child.data)
      .filter((post) => isCompanyMatch(company, `${post.title ?? ""} ${post.selftext ?? ""}`))
      .slice(0, 3);

    if (!posts.length) {
      return { failures: [failure("reddit", company, url, "No verified public Reddit matches.")] };
    }

    return {
      evidence: posts.map((post) =>
        evidenceItem({
          company,
          entityType: "company",
          entityId: companyId(company),
          platform: "reddit",
          sourceUrl: `https://www.reddit.com${post.permalink}`,
          title: post.title,
          text: post.selftext || post.title,
          rawVisibleText: JSON.stringify(post),
          postedAt: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : null,
          metrics: {
            upvotes: numberOrNull(post.ups),
            comments: numberOrNull(post.num_comments)
          },
          contributionScore: scoreMetrics("reddit", {
            upvotes: numberOrNull(post.ups),
            comments: numberOrNull(post.num_comments)
          }),
          review_state: "verified",
          matchReason: "Exact company-name match in public Reddit search JSON."
        })
      )
    };
  } catch (error) {
    const page = await fetchReader(`https://www.reddit.com/search/?q=${encodeURIComponent(`${company.name} YC`)}`).catch(() => null);
    return {
      failures: [
        failure(
          "reddit",
          company,
          url,
          page && isBlocked(page.text) ? "Reddit public access blocked by network security/login wall." : errorMessage(error)
        )
      ]
    };
  }
}

async function ingestSocialProfile(company, entity, entityType, platform, url) {
  const page = await fetchReader(url);
  if (isBlocked(page.text)) {
    const fallback = discoverMissingSocial
      ? await discoverAndVerifyPublicSocialPosts(
          company,
          platform,
          url,
          `YC-linked ${platform} profile was blocked/login-walled, so public post-search fallback was attempted.`,
          entity,
          entityType
        )
      : { evidence: [], needsReview: [], sourceDiscoveryPaths: [] };
    return {
      evidence: fallback.evidence,
      needsReview: fallback.needsReview,
      failures: [failure(platform, company, url, "Public page blocked or login-walled.", entityType, entityName(entity, entityType))],
      sourceDiscoveryPaths: fallback.sourceDiscoveryPaths
    };
  }

  const name = entityName(entity, entityType);
  const verified = isCompanyMatch({ name, websiteUrl: company.websiteUrl }, page.text) || page.title.toLowerCase().includes(name.toLowerCase());
  const metrics = metricsFromPublicProfile(platform, page.text, page.title);

  if (!verified) {
    return {
      evidence: [],
      failures: [],
      needsReview: [
        reviewCandidate(
          company,
          platform,
          url,
          `Public ${platform} page was readable but did not clearly match ${name}.`,
          entityType,
          entityIdFor(company, entity, entityType),
          name
        )
      ]
    };
  }

  const postResults = [];
  for (const candidate of extractSocialPostCandidates(page.text, platform, company).slice(0, 3)) {
    postResults.push(await verifyPublicSocialPostCandidate(company, platform, candidate));
  }
  const postEvidence = postResults.flatMap((result) => result.evidence ?? []);
  const postNeedsReview = postResults.flatMap((result) => result.needsReview ?? []);

  return {
    evidence: [
      evidenceItem({
        company,
        entityType,
        entityId: entityIdFor(company, entity, entityType),
        platform,
        sourceUrl: url,
        title: page.title || name,
        text: socialProfileSummary(platform, page.text, page.title || name),
        rawVisibleText: page.text,
        metrics,
        contributionScore: 0,
        review_state: "verified",
        matchReason: `Verified public ${platform} profile readable without login. Stored as identity context only; profile followers are not counted as post traction.`
      }),
      ...postEvidence.map((item) => ({
        ...item,
        id: stableId(`${item.platform}:${entityIdFor(company, entity, entityType)}:${item.sourceUrl}:${item.title}`),
        entityType,
        entityId: entityIdFor(company, entity, entityType)
      }))
    ],
    needsReview: postNeedsReview,
    failures: []
  };
}

async function discoverAndVerifyPublicSocialPosts(company, platform, sourceUrl, matchReasonPrefix, entity = company, entityType = "company") {
  const candidates = await discoverSocialCandidates(company, platform, entityType === "founder" ? entity : null);
  const postCandidates = candidates.filter((candidate) => isSocialPostUrl(candidate.url, platform)).slice(0, 3);
  const postResults = [];
  for (const candidate of postCandidates) {
    postResults.push(await verifyPublicSocialPostCandidate(company, platform, candidate));
  }
  const postEvidence = postResults.flatMap((result) => result.evidence ?? []);
  const attributedPostEvidence = postEvidence.map((item) =>
    entityType === "founder"
      ? {
          ...item,
          id: stableId(`${item.platform}:${entityIdFor(company, entity, entityType)}:${item.sourceUrl}:${item.title}`),
          entityType: "founder",
          entityId: entityIdFor(company, entity, entityType)
        }
      : item
  );
  const verifiedPostUrls = new Set(postEvidence.map((item) => item.sourceUrl));
  const postNeedsReview = postResults.flatMap((result) => result.needsReview ?? []);
  const reviewItems = [
    ...postNeedsReview,
    ...candidates
      .filter((candidate) => !postCandidates.some((postCandidate) => postCandidate.url === candidate.url))
      .slice(0, 3)
      .map((candidate) =>
        reviewCandidate(
          company,
          platform,
          candidate.url,
          `${matchReasonPrefix} Candidate needs review because it is not a verified public post URL.`
        )
      )
  ];

  return {
    evidence: attributedPostEvidence,
    needsReview: reviewItems,
    sourceDiscoveryPaths: candidates.map((candidate) =>
      sourceDiscoveryPath({
        company,
        sourceUrl: sourceUrl ?? candidate.searchUrl,
        discoveredUrl: candidate.url,
        discoveredPlatform: platform,
        discoveredEntityType: entityType,
        discoveredEntityName: entityName(entity, entityType),
        matchReason: verifiedPostUrls.has(candidate.url)
          ? `${matchReasonPrefix} Verified post-level evidence from public search query "${candidate.query}".`
          : `${matchReasonPrefix} Found candidate from public search query "${candidate.query}".`,
        reviewState: verifiedPostUrls.has(candidate.url) ? "verified" : "needs_review"
      })
    )
  };
}

async function verifyPublicSocialPostCandidate(company, platform, candidate) {
  try {
    const page = await fetchReader(candidate.url);
    const combined = `${candidate.title} ${candidate.snippet} ${page.title} ${page.text}`;
    if (isBlocked(page.text)) {
      const fallback = evidenceFromSearchSnippet(company, platform, candidate, "Reader page was blocked or login-walled");
      if (fallback) {
        return { evidence: [fallback] };
      }
      return {
        needsReview: [
          reviewCandidate(
            company,
            platform,
            candidate.url,
            `Public ${platform} post candidate was blocked or login-walled during verification.`
          )
        ]
      };
    }

    if (!isStrongPublicMatch(company, combined, candidate.url)) {
      const fallback = evidenceFromSearchSnippet(company, platform, candidate, "Reader page did not expose enough matching context");
      if (fallback) {
        return { evidence: [fallback] };
      }
      return {
        needsReview: [
          reviewCandidate(
            company,
            platform,
            candidate.url,
            `Public ${platform} post candidate did not clearly match company name/domain plus YC/startup context.`
          )
        ]
      };
    }

    const metrics = metricsFromPublicPost(platform, page.text);
    return {
      evidence: [
        evidenceItem({
          company,
          entityType: "company",
          entityId: companyId(company),
          platform,
          sourceUrl: canonicalProfileUrl(candidate.url, platform),
          title: page.title || candidate.title || company.name,
          text: firstUsefulText(page.text) || candidate.snippet || candidate.title || company.name,
          rawVisibleText: page.text,
          postedAt: parsePublicPostDate(page.text),
          metrics,
          contributionScore: scoreMetrics(platform, metrics),
          review_state: "verified",
          matchReason: `Verified public ${platform} post candidate from search results; company/domain and YC/startup context matched visible text.`
        })
      ]
    };
  } catch (error) {
    const fallback = evidenceFromSearchSnippet(
      company,
      platform,
      candidate,
      `Reader verification failed: ${errorMessage(error)}`
    );
    if (fallback) {
      return { evidence: [fallback] };
    }
    return {
      needsReview: [
        reviewCandidate(
          company,
          platform,
          candidate.url,
          `Public ${platform} post candidate verification failed: ${errorMessage(error)}.`
        )
      ]
    };
  }
}

function evidenceFromSearchSnippet(company, platform, candidate, reason) {
  const snippetText = cleanText(`${candidate.title ?? ""} ${candidate.snippet ?? ""}`);
  if (!snippetText) return null;
  const metrics = metricsFromPublicPost(platform, snippetText);
  if (!Object.values(metrics).some((value) => Number(value) > 0)) return null;
  if (!isStrongSearchSnippetPostMatch(company, snippetText)) return null;

  return evidenceItem({
    company,
    entityType: "company",
    entityId: companyId(company),
    platform,
    sourceUrl: canonicalProfileUrl(candidate.url, platform),
    title: candidate.title || company.name,
    text: firstUsefulText(snippetText) || candidate.title || company.name,
    rawVisibleText: snippetText,
    postedAt: parsePublicPostDate(snippetText),
    metrics,
    contributionScore: scoreMetrics(platform, metrics),
    review_state: "verified",
    matchReason: `Verified public ${platform} post candidate from search-result visible text only; ${reason}.`
  });
}

function isStrongSearchSnippetPostMatch(company, text) {
  const normalizedName = cleanText(company.name).toLowerCase();
  const hasSpecificCompanyName = normalizedName.length >= 6 && isCompanyMatch(company, text);
  if (hasSpecificCompanyName) return true;
  if (companyDomainMentioned(company, text)) return true;
  const hasFounderMatch = founderNameMentioned(company, text);
  const hasStartupContext = /\b(YC|Y Combinator|startup|founder|co[- ]?founder|launch|product|app|AI|open[- ]?source)\b/i.test(text);
  return hasFounderMatch && hasStartupContext;
}

function evidenceItem(input) {
  return {
    id: stableId(`${input.platform}:${input.entityId}:${input.sourceUrl}:${input.title}`),
    entityType: input.entityType,
    entityId: input.entityId,
    companySlug: input.company.slug,
    companyName: input.company.name,
    platform: input.platform,
    title: sanitizePublicText(input.title),
    sourceUrl: input.sourceUrl,
    platformPostId: input.platformPostId ?? platformPostIdFromUrl(input.platform, input.sourceUrl),
    text: sanitizePublicText(input.text).slice(0, 600),
    rawVisibleText: sanitizePublicText(input.rawVisibleText).slice(0, 6000),
    postedAt: input.postedAt ?? null,
    metrics: removeNullish(input.metrics ?? {}),
    contributionScore: input.contributionScore ?? 0,
    review_state: input.review_state,
    matchReason: input.matchReason,
    first_seen_at: now,
    last_checked_at: now,
    last_updated_at: input.postedAt ?? now
  };
}

function reviewCandidate(company, platform, url, reason, entityType = "company", entityId = companyId(company), entityNameValue = company.name) {
  return {
    id: stableId(`review:${platform}:${entityId}:${url}`),
    entityType,
    entityId,
    entityName: entityNameValue,
    companySlug: company.slug,
    companyName: company.name,
    platform,
    candidateUrl: url,
    review_state: "needs_review",
    matchReason: reason,
    first_seen_at: now,
    last_checked_at: now,
    last_updated_at: now
  };
}

function discoveryAttempt({
  company,
  platform,
  query,
  source,
  resultCount,
  usefulResultCount,
  selectedUrl,
  status,
  failureReason = null
}) {
  return {
    id: stableId(`discovery:${company.slug}:${platform}:${source}:${query}:${selectedUrl ?? "none"}:${status}`),
    company_id: companyId(company),
    company_slug: company.slug,
    company_name: company.name,
    platform,
    query,
    source,
    result_count: resultCount,
    useful_result_count: usefulResultCount,
    selected_url: selectedUrl,
    status,
    failure_reason: failureReason,
    created_at: now
  };
}

function sourceDiscoveryPath({
  company,
  sourceUrl,
  discoveredUrl,
  discoveredPlatform,
  discoveredEntityType,
  discoveredEntityName,
  matchReason,
  reviewState
}) {
  return {
    id: stableId(`path:${company.slug}:${sourceUrl}:${discoveredUrl}`),
    company_id: companyId(company),
    company_slug: company.slug,
    company_name: company.name,
    source_url: sourceUrl,
    discovered_url: discoveredUrl,
    discovered_platform: discoveredPlatform,
    discovered_entity_type: discoveredEntityType,
    discovered_entity_name: discoveredEntityName,
    match_reason: matchReason,
    review_state: reviewState,
    created_at: now
  };
}

function failure(platform, company, url, message, entityType = "company", entityNameValue = company.name) {
  return {
    id: stableId(`failure:${platform}:${company.slug}:${entityType}:${url ?? "none"}:${message}`),
    platform,
    companySlug: company.slug,
    companyName: company.name,
    entityType,
    entityName: entityNameValue,
    sourceUrl: url,
    message,
    checkedAt: now
  };
}

function selectedResultUrl(result) {
  return result?.evidence?.[0]?.sourceUrl ?? result?.needsReview?.[0]?.candidateUrl ?? result?.failures?.[0]?.sourceUrl ?? null;
}

function defaultQueryFor(company, platform) {
  if (platform === "product_hunt") return `${company.name} Product Hunt`;
  if (platform === "youtube") return `${company.name} YC startup YouTube`;
  if (platform === "hacker_news") return `"${company.name}" YC Spring 2026`;
  if (platform === "reddit") return `${company.name} YC reddit`;
  if (platform === "rss") return `${company.name} blog RSS`;
  if (platform === "web") return `${company.name} YC startup`;
  return `${company.name} ${platform}`;
}

function platformAllowed(platform) {
  return !platformFilter.size || platformFilter.has(normalizePlatformArg(platform));
}

function normalizePlatformArg(platform) {
  if (!platform) return "";
  if (platform === "website" || platform === "news_web" || platform === "web_news" || platform === "news") {
    return "web";
  }
  if (platform === "twitter") return "x";
  if (platform === "producthunt") return "product_hunt";
  if (platform === "hn") return "hacker_news";
  return platform;
}

async function fetchReadable(url, options = {}) {
  try {
    const response = await fetchPublic(url);
    const html = await response.text();
    return htmlToReadable(url, html);
  } catch (error) {
    if (!options.readerFallback) throw error;
    return fetchReader(url);
  }
}

async function fetchReader(url) {
  const pageUrl = `https://r.jina.ai/http://${url}`;
  const response = await fetchPublic(pageUrl);
  const text = await response.text();
  throwIfPlatformCooldown(response, text);
  return {
    html: text,
    text: cleanText(text),
    title: cleanText((text.match(/^Title:\s*(.+)$/m) ?? [])[1] ?? "")
  };
}

async function fetchPublic(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "YCNetworkIntelligence/0.1 read-only public ingestion",
        Accept: options.accept ?? "text/html,application/xhtml+xml,application/xml,text/plain,application/json;q=0.9,*/*;q=0.8"
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

function throwIfPlatformCooldown(response, text) {
  if (response.status !== 451 && !/SecurityCompromiseError|anonymous access .* blocked until/i.test(text)) {
    return;
  }

  const untilText = (text.match(/blocked until ([^"]+?) due to/i) ?? [])[1];
  const until = untilText ? new Date(untilText).valueOf() : Date.now() + 30 * 60_000;
  const error = new Error(`Platform cooldown from reader: HTTP ${response.status}; blocked until ${new Date(until).toISOString()}.`);
  error.platformCooldownUntil = Number.isFinite(until) ? until : Date.now() + 30 * 60_000;
  error.platformCooldownReason = sanitizePublicText(text).slice(0, 260);
  throw error;
}

function recordPlatformCooldownIfNeeded(platform, error) {
  if (!error?.platformCooldownUntil) {
    return;
  }

  platformCooldowns.set(normalizePlatformArg(platform), {
    until: error.platformCooldownUntil,
    reason: error.platformCooldownReason ?? errorMessage(error)
  });
}

function htmlToReadable(url, html) {
  const $ = cheerio.load(html);
  $("script,style,noscript,svg,canvas").remove();
  const title = cleanText($("title").first().text() || $("h1").first().text());
  const text = cleanText($("body").text());
  return { html, title, text, url };
}

function discoverFeedUrls(baseUrl, html) {
  const urls = new Set();
  if (html) {
    const $ = cheerio.load(html);
    $("link[type*='rss'],link[type*='atom'],a[href*='rss'],a[href*='feed'],a[href*='atom']").each((_, el) => {
      const href = $(el).attr("href");
      if (href) urls.add(new URL(href, baseUrl).toString());
    });
  }
  for (const path of ["/feed", "/rss", "/rss.xml", "/feed.xml", "/atom.xml", "/blog/rss.xml"]) {
    urls.add(new URL(path, baseUrl).toString());
  }
  return [...urls].slice(0, 6);
}

function discoverSocialLinks(company, html, baseUrl) {
  if (!html || !baseUrl) return [];
  const $ = cheerio.load(html);
  const links = new Map();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const absolute = safeAbsoluteUrl(href, baseUrl);
    if (!absolute) return;
    const platform = platformFromUrl(absolute);
    if (!platform) return;
    links.set(canonicalProfileUrl(absolute, platform), { platform, url: canonicalProfileUrl(absolute, platform) });
  });

  return [...links.values()]
    .filter((item) => {
      if (item.platform === "x") return !/\/intent\/|\/share\b/i.test(item.url);
      if (item.platform === "linkedin") return !/\/shareArticle\b/i.test(item.url);
      return true;
    })
    .slice(0, 12);
}

function platformFromUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
    if (host === "x.com" || host === "twitter.com" || host === "mobile.twitter.com") return "x";
    if (host === "instagram.com" || host.endsWith(".instagram.com")) return "instagram";
    if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return "linkedin";
    if (host === "youtube.com" || host === "youtu.be" || host.endsWith(".youtube.com")) return "youtube";
    if (host === "producthunt.com" || host.endsWith(".producthunt.com")) return "product_hunt";
    if (host === "reddit.com" || host.endsWith(".reddit.com")) return "reddit";
  } catch {
    return null;
  }
  return null;
}

function canonicalProfileUrl(rawUrl, platform) {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.replace(/^www\./, "").toLowerCase();
    if (platform === "x" && (url.hostname === "twitter.com" || url.hostname === "mobile.twitter.com")) {
      url.hostname = "x.com";
    }
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function platformPostIdFromUrl(platform, rawUrl) {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname.replace(/\/$/, "");
    if (platform === "x") return path.match(/\/status\/(\d+)/i)?.[1] ?? null;
    if (platform === "instagram") return path.match(/^\/(?:p|reel|tv)\/([^/]+)/i)?.[1] ?? null;
    if (platform === "linkedin") {
      return (
        path.match(/\/feed\/update\/urn:li:activity:(\d+)/i)?.[1] ??
        path.match(/\/posts\/([^/]+)/i)?.[1] ??
        null
      );
    }
    if (platform === "youtube") return url.searchParams.get("v") ?? path.match(/\/shorts\/([^/]+)/i)?.[1] ?? null;
    if (platform === "product_hunt") {
      return path.match(/\/posts\/([^/]+)/i)?.[1] ?? path.match(/\/products\/([^/]+)/i)?.[1] ?? null;
    }
    if (platform === "reddit") return path.match(/\/comments\/([^/]+)/i)?.[1] ?? null;
    if (platform === "hacker_news") return url.searchParams.get("id");
  } catch {
    return null;
  }
  return null;
}

function safeAbsoluteUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function parseFeedItems(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const items = $("item, entry").toArray();
  return items.map((node) => {
    const item = $(node);
    const link = item.find("link").first().attr("href") || item.find("link").first().text();
    const title = cleanText(item.find("title").first().text());
    const description = cleanText(item.find("description, summary, content").first().text());
    const publishedAt = cleanText(item.find("pubDate, published, updated").first().text());
    return {
      title,
      description,
      link,
      publishedAt: publishedAt ? new Date(publishedAt).toISOString() : null,
      raw: cleanText(item.text())
    };
  });
}

function parseYouTubeResults(html) {
  const results = [];
  const seen = new Set();
  const regex = /"videoId":"([^"]+)".{0,500}?"title":\{"runs":\[\{"text":"([^"]+)"/g;
  let match;
  while ((match = regex.exec(html)) && results.length < 20) {
    const videoId = match[1];
    if (seen.has(videoId)) continue;
    seen.add(videoId);
    const windowText = html.slice(match.index, match.index + 2500);
    const viewsText = (windowText.match(/"viewCountText":\{"simpleText":"([^"]+)"/) ?? [])[1] ?? "";
    const description = (windowText.match(/"descriptionSnippet":\{"runs":\[\{"text":"([^"]+)"/) ?? [])[1] ?? "";
    results.push({
      videoId,
      title: decodeJsonText(match[2]),
      description: decodeJsonText(description),
      views: parseCompactNumber(viewsText),
      raw: cleanText(windowText)
    });
  }
  return results;
}

function extractMarkdownLinks(text) {
  const links = [];
  const regex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let match;
  while ((match = regex.exec(text))) {
    links.push({ text: cleanText(match[1]), url: match[2] });
  }
  return links;
}

function extractSocialPostCandidates(text, platform, company) {
  const markdownLinks = extractMarkdownLinks(text);
  const rawLinks = [...String(text).matchAll(/https?:\/\/[^\s)"'>]+/g)].map((match) => ({
    text: "",
    url: match[0]
  }));

  return [
    ...new Map(
      [...markdownLinks, ...rawLinks]
        .map((link) => ({
          query: `${company.name} ${platform} public profile post links`,
          searchUrl: link.url,
          title: link.text || company.name,
          snippet: "",
          url: canonicalProfileUrl(link.url, platform)
        }))
        .filter((candidate) => urlMatchesPlatform(candidate.url, platform))
        .filter((candidate) => isSocialPostUrl(candidate.url, platform))
        .map((candidate) => [candidate.url, candidate])
    ).values()
  ];
}

function lineAround(text, needle) {
  if (!needle) return "";
  return text
    .split(/\n+/)
    .map(cleanText)
    .find((line) => line.toLowerCase().includes(needle.toLowerCase())) ?? "";
}

function metricsFromPublicProfile(platform, text, title = "") {
  if (platform === "x") {
    return {
      likes: null,
      comments: null,
      views: null,
      reposts: null,
      followers: parseXFollowers(text, title)
    };
  }
  if (platform === "linkedin") {
    return {
      followers: parseLinkedInFollowers(text, title)
    };
  }
  if (platform === "instagram") {
    return {
      followers: parseNearbyMetric(text, "followers", /([\d,.]+[KMB]?)\s+followers/i)
    };
  }
  return {};
}

function metricsFromPublicPost(platform, text) {
  if (platform === "x") {
    return removeNullish({
      views: parseNearbyMetric(text, "Views", /([\d,.]+[KMB]?)\s+Views?/i),
      likes: parseNearbyMetric(text, "Likes", /([\d,.]+[KMB]?)\s+Likes?/i),
      replies: parseNearbyMetric(text, "Replies", /([\d,.]+[KMB]?)\s+Replies?/i),
      comments: parseNearbyMetric(text, "Replies", /([\d,.]+[KMB]?)\s+Replies?/i),
      reposts: parseNearbyMetric(text, "Reposts", /([\d,.]+[KMB]?)\s+(?:Reposts?|Retweets?)/i),
      quotes: parseNearbyMetric(text, "Quotes", /([\d,.]+[KMB]?)\s+Quotes?/i)
    });
  }
  if (platform === "instagram") {
    return removeNullish({
      views: parseNearbyMetric(text, "views", /([\d,.]+[KMB]?)\s+views?/i),
      likes: parseNearbyMetric(text, "likes", /([\d,.]+[KMB]?)\s+likes?/i),
      comments: parseNearbyMetric(text, "comments", /([\d,.]+[KMB]?)\s+comments?/i)
    });
  }
  if (platform === "linkedin") {
    return removeNullish({
      views: parseNearbyMetric(text, "views", /([\d,.]+[KMB]?)\s+views?/i),
      reactions: parseNearbyMetric(text, "reactions", /([\d,.]+[KMB]?)\s+(?:reactions?|likes?)/i),
      comments: parseNearbyMetric(text, "comments", /([\d,.]+[KMB]?)\s+comments?/i),
      reposts: parseNearbyMetric(text, "reposts", /([\d,.]+[KMB]?)\s+reposts?/i)
    });
  }
  return {};
}

function scoreMetrics(platform, metrics) {
  const weights = INGEST_METRIC_WEIGHTS[platform] ?? INGEST_METRIC_WEIGHTS.x;
  const raw = Object.entries(metrics ?? {}).reduce((sum, [metric, rawValue]) => {
    const value = Number(rawValue);
    return Number.isFinite(value) ? sum + value * (weights[metric] ?? 0) : sum;
  }, 0);

  if (raw <= 0) {
    return 0;
  }

  const platformFloor = platform === "web" || platform === "rss" ? 0 : 1;
  return Math.max(platformFloor, Math.min(100, Math.round(Math.log1p(raw) * 18)));
}

function parseXFollowers(text, title) {
  const handle = (title.match(/\(@([^)]+)\)/) ?? [])[1];
  if (handle) {
    const handleIndex = profileHandleIndex(text, handle);
    if (handleIndex >= 0) {
      const windowText = text.slice(handleIndex, handleIndex + 1400);
      const value = (windowText.match(/\[([\d,.]+[KMB]?)\s+Followers\]/i) ?? windowText.match(/([\d,.]+[KMB]?)\s+Followers/i) ?? [])[1];
      return value ? parseCompactNumber(value) : null;
    }
  }
  return parseNearbyMetric(text, "Followers", /\[([\d,.]+[KMB]?)\s+Followers\]/i);
}

function parseLinkedInFollowers(text, title) {
  const profileName = title.replace(/\s*\|\s*LinkedIn.*$/i, "").trim();
  const nameIndex = profileName ? text.toLowerCase().indexOf(`# ${profileName.toLowerCase()}`) : -1;
  const scoped = nameIndex >= 0 ? text.slice(nameIndex, nameIndex + 1000) : "";
  const value =
    (scoped.match(/###\s+[^#\[]*?\s+([\d,.]+[KMB]?)\s+followers\b/i) ??
      scoped.match(/\b([\d,.]+[KMB]?)\s+followers\b/i) ??
      [])[1];
  return value ? parseCompactNumber(value) : null;
}

function parseNearbyMetric(text, needle, regex) {
  const around = needle ? lineAround(text, needle) || text : text;
  const value = (around.match(regex) ?? text.match(regex) ?? [])[1];
  return value ? parseCompactNumber(value) : null;
}

function parseCompactNumber(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/,/g, "").trim();
  const match = cleaned.match(/([\d.]+)\s*([KMB])?/i);
  if (!match) return null;
  const number = Number(match[1]);
  const suffix = match[2]?.toUpperCase();
  const multiplier = suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : suffix === "B" ? 1_000_000_000 : 1;
  return Number.isFinite(number) ? Math.round(number * multiplier) : null;
}

function parsePublicPostDate(text) {
  const value =
    (text.match(/\b(?:Posted|Published|Date)\s*:?\s*([A-Z][a-z]{2,9}\s+\d{1,2},\s+\d{4})\b/) ?? [])[1] ??
    (text.match(/\b(\d{4}-\d{2}-\d{2})\b/) ?? [])[1];
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function profileHandleIndex(text, handle) {
  const lower = text.toLowerCase();
  const marker = `@${handle.toLowerCase()}`;
  const first = lower.indexOf(marker);
  if (first < 0) return -1;
  const second = lower.indexOf(marker, first + marker.length);
  return second >= 0 ? second : first;
}

function isCompanyMatch(company, text) {
  const lower = cleanText(text).toLowerCase();
  const name = company.name.toLowerCase();
  if (name.length <= 3) {
    return lower.includes(`${name} `) || lower.includes(` ${name}`) || lower.includes(`${name}.`);
  }
  if (lower.includes(name)) return true;
  const host = company.websiteUrl ? new URL(company.websiteUrl).hostname.replace(/^www\./, "").split(".")[0] : "";
  return host.length > 4 && lower.includes(host.toLowerCase());
}

function isStrongPublicMatch(company, text, sourceUrl) {
  const hasCompanyMatch = isCompanyMatch(company, text);
  const hasFounderMatch = founderNameMentioned(company, text);
  if (!hasCompanyMatch && !hasFounderMatch) return false;
  if (sourceUrl && isCompanyDomain(company, sourceUrl)) return true;
  if (companyDomainMentioned(company, text)) return true;
  const hasStartupContext = /\b(YC|Y Combinator|startup|founder|co[- ]?founder|launch|product)\b/i.test(text);
  return hasCompanyMatch ? hasStartupContext : hasFounderMatch && hasStartupContext;
}

function isCurrentBatchHackerNewsHit(text) {
  return /\bYC\s*(P26|S26|Spring\s+2026)\b/i.test(text);
}

function isCompanyDomain(company, sourceUrl) {
  try {
    if (!company.websiteUrl) return false;
    const sourceHost = new URL(sourceUrl).hostname.replace(/^www\./, "").toLowerCase();
    const companyHost = new URL(company.websiteUrl).hostname.replace(/^www\./, "").toLowerCase();
    return sourceHost === companyHost || sourceHost.endsWith(`.${companyHost}`);
  } catch {
    return false;
  }
}

function companyDomainMentioned(company, text) {
  try {
    if (!company.websiteUrl) return false;
    const host = new URL(company.websiteUrl).hostname.replace(/^www\./, "").toLowerCase();
    const root = host.split(".")[0];
    const lower = cleanText(text).toLowerCase();
    return lower.includes(host) || (root.length > 4 && lower.includes(root));
  } catch {
    return false;
  }
}

function founderNameMentioned(company, text) {
  const lower = cleanText(text).toLowerCase();
  return (company.founders ?? []).some((founder) => {
    const name = String(founder.name ?? "").toLowerCase().trim();
    if (!name) return false;
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2 && lower.includes(name)) return true;
    return false;
  });
}

function companyId(company) {
  return `company-${company.slug}`;
}

function entityIdFor(company, entity, entityType) {
  return entityType === "company" ? companyId(company) : `founder-${company.slug}-${slugify(entity.name)}-${entity.id}`;
}

function entityName(entity, entityType) {
  return entityType === "company" ? entity.name : entity.name;
}

function firstUsefulText(text) {
  const lines = cleanText(text)
    .split(/(?<=\.)\s+|\n+/)
    .map(cleanText)
    .filter((line) => line.length > 24 && !/^(title|url source|markdown content):/i.test(line));
  return lines[0] ?? cleanText(text).slice(0, 300);
}

function socialProfileSummary(platform, text, title) {
  const compact = cleanText(text);
  if (platform === "x") {
    const handle = (title.match(/\(@([^)]+)\)/) ?? [])[1];
    if (handle) {
      const handleIndex = profileHandleIndex(compact, handle);
      if (handleIndex >= 0) {
        const profileWindow = compact.slice(handleIndex + handle.length + 1, handleIndex + 800);
        const beforeJoined = profileWindow.split(/\s+Joined\s+/i)[0];
        const withoutLinks = stripMarkdownLinks(beforeJoined)
          .replace(/\b\d[\d,]*\s+posts?\b/i, "")
          .replace(/\s+/g, " ")
          .trim();
        if (withoutLinks.length > 12) return withoutLinks;
      }
    }
  }

  if (platform === "linkedin") {
    const summary = (compact.match(/####\s+(.+?)(?:\s+\[|\s+###|\s*$)/) ?? [])[1];
    if (summary && !/^(follow|sign in|join linkedin)$/i.test(summary.trim())) {
      return stripMarkdownLinks(summary).trim();
    }
  }

  const fallback = firstUsefulText(compact);
  return isGenericProfileText(fallback) ? title : fallback;
}

function stripMarkdownLinks(value) {
  return cleanText(value)
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1");
}

function isGenericProfileText(value) {
  return /don't miss what's happening|skip to main content|agree & join linkedin|log in|sign up/i.test(value);
}

function isSocialPostUrl(url, platform) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (platform === "x") return /\/status\/\d+/i.test(path);
    if (platform === "instagram") return /^\/(p|reel|tv)\/[^/]+/i.test(path);
    if (platform === "linkedin") return /\/feed\/update\/urn:li:activity:|\/posts\//i.test(path);
    return false;
  } catch {
    return false;
  }
}

function isBlocked(text) {
  return /captcha|blocked by network security|target url returned error 403|forbidden|access denied|temporarily blocked|unusual traffic|enable javascript to continue|to continue, log in/i.test(text);
}

function isThirdPartyMention(company, sourceUrl) {
  try {
    const host = new URL(sourceUrl).hostname.replace(/^www\./, "").toLowerCase();
    const companyHost = company.websiteUrl ? new URL(company.websiteUrl).hostname.replace(/^www\./, "").toLowerCase() : "";
    if (companyHost && host === companyHost) return false;
    if (host.endsWith("ycombinator.com") || host.endsWith("workatastartup.com")) return false;
    return true;
  } catch {
    return false;
  }
}

function normalizeSearchUrl(url) {
  if (url.startsWith("//")) {
    url = `https:${url}`;
  }
  try {
    const parsed = new URL(url);
    const duckTarget = parsed.searchParams.get("uddg");
    return duckTarget ? decodeURIComponent(duckTarget) : parsed.toString();
  } catch {
    return url;
  }
}

function urlMatchesPlatform(url, platform) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (platform === "x") return host === "x.com" || host === "twitter.com";
    if (platform === "linkedin") return host === "linkedin.com" || host.endsWith(".linkedin.com");
    if (platform === "instagram") return host === "instagram.com" || host.endsWith(".instagram.com");
    return true;
  } catch {
    return false;
  }
}

function cleanText(value) {
  return String(value ?? "").replace(/\\u0026/g, "&").replace(/\s+/g, " ").trim();
}

function sanitizePublicText(value) {
  return redactTokenLikeStrings(cleanText(value));
}

function decodeJsonText(value) {
  try {
    return JSON.parse(`"${String(value).replace(/"/g, '\\"')}"`);
  } catch {
    return cleanText(value);
  }
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function removeNullish(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined));
}

function stableId(value) {
  return value
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 180);
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function addItems(items, target) {
  for (const item of items) {
    target.push(item);
  }
}

function dedupeById(items) {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function dedupeFailures(items) {
  return dedupeById(items)
    .filter((item) => !isObsoleteInternalFailure(item))
    .sort((a, b) => a.platform.localeCompare(b.platform) || a.companyName.localeCompare(b.companyName));
}

function dedupeDiscoveryAttempts(items) {
  return dedupeById(items).filter((item) => !isObsoleteInternalFailure(item));
}

function normalizeNeedsReviewItems(items) {
  return dedupeById(items).filter((item) => isUsefulNeedsReviewItem(item));
}

function isUsefulNeedsReviewItem(item) {
  if (item.platform !== "product_hunt") return true;

  const company = companyBySlug.get(item.companySlug);
  const candidateUrl = item.candidateUrl ?? item.sourceUrl ?? "";
  if (!company || !candidateUrl) return false;

  try {
    const parsed = new URL(candidateUrl);
    const isProductHuntProduct = /^\/(products|posts)\//i.test(parsed.pathname);
    if (!isProductHuntProduct) return false;
  } catch {
    return false;
  }

  return productHuntCandidateMatches(company, { text: item.title ?? "", url: candidateUrl });
}

function isObsoleteInternalFailure(item) {
  return /Cannot access 'INGEST_METRIC_WEIGHTS' before initialization/i.test(
    item?.message ?? item?.failure_reason ?? item?.error ?? ""
  );
}

function normalizeStoredEvidence(item) {
  if (item.platform === "web" || item.platform === "rss") {
    return {
      ...item,
      contributionScore: 0,
      matchReason:
        item.platform === "rss"
          ? "Public RSS/blog item stored as context. It is not scored without public engagement metrics."
          : item.matchReason.replace(
              /Low score because no public engagement metrics were available\./,
              "Stored as context only because no public engagement metrics were available."
            )
    };
  }
  if (["x", "linkedin", "instagram"].includes(item.platform)) {
    const isPostEvidence =
      /verified public .* (post|tweet|status|activity)/i.test(item.matchReason ?? "") ||
      /\/status\/\d+|\/feed\/update\/urn:li:activity:|\/posts\/|\/(p|reel|tv)\//i.test(item.sourceUrl ?? "");
    const metrics = isPostEvidence ? removeNullish(item.metrics ?? {}) : removeNullish(metricsFromPublicProfile(item.platform, item.rawVisibleText, item.title));
    return {
      ...item,
      text: isPostEvidence ? item.text : socialProfileSummary(item.platform, item.rawVisibleText, item.title).slice(0, 600),
      metrics,
      contributionScore: isPostEvidence ? scoreMetrics(item.platform, metrics) : 0,
      matchReason: isPostEvidence
        ? item.matchReason
        : `Public ${item.platform} profile stored as identity context only. Profile followers are not counted as post traction.`
    };
  }
  if (item.platform === "product_hunt") {
    const company = companyBySlug.get(item.companySlug);
    const verification = company
      ? productHuntVerification(
          company,
          { text: item.title, url: item.sourceUrl },
          { title: item.title, text: item.rawVisibleText }
        )
      : { verified: false };
    if (!company || !verification.verified) {
      return null;
    }
    const metrics = removeNullish(item.metrics ?? {});
    return {
      ...item,
      metrics,
      contributionScore: scoreMetrics("product_hunt", metrics),
      matchReason: `Verified public Product Hunt page: ${verification.reason}.`
    };
  }
  return item;
}

async function writeCheckpoint() {
  checkpointWriteChain = checkpointWriteChain.then(async () => {
    const checkpointPayload = {
      attempts: Object.fromEntries(
        [...attemptMap.entries()].filter(([, attempt]) => !isObsoleteInternalFailure(attempt))
      ),
      evidence: dedupeById(evidence).map(normalizeStoredEvidence).filter(Boolean),
      needsReview: normalizeNeedsReviewItems(needsReview),
      failures: dedupeFailures(failures),
      discoveryAttempts: dedupeDiscoveryAttempts(discoveryAttempts),
      sourceDiscoveryPaths: dedupeById(sourceDiscoveryPaths)
    };
    await writeJson(checkpointPath, checkpointPayload);
  });
  await checkpointWriteChain;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${serializeJson(value)}\n`);
  for (let attemptIndex = 0; attemptIndex < 8; attemptIndex += 1) {
    try {
      await rename(tempPath, path);
      return;
    } catch (error) {
      if (!["EPERM", "UNKNOWN"].includes(error?.code) || attemptIndex === 7) {
        throw error;
      }
      await delay(250 + attemptIndex * 250);
    }
  }
}

function serializeJson(value) {
  return redactTokenLikeStrings(JSON.stringify(value, null, 2));
}

function redactTokenLikeStrings(value) {
  return String(value)
    .replace(/gh[pousr]_[A-Za-z0-9_]{12,}/g, "[redacted-public-token]")
    .replace(/github_pat_[A-Za-z0-9_]{12,}/g, "[redacted-public-token]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted-public-token]")
    .replace(/xox[baprs]-[A-Za-z0-9-]{12,}/g, "[redacted-public-token]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[redacted-public-token]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{12,}/gi, "Bearer [redacted-public-token]")
    .replace(/\b[A-Za-z0-9_-]{3,}=[A-Za-z0-9%._/-]{16,}/g, (match) => {
      const key = match.split("=")[0];
      return `${key}=[redacted-public-param]`;
    });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numberArg(name) {
  const raw = process.argv.find((arg) => arg.startsWith(`${name}=`))?.split("=")[1];
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringArg(name) {
  return process.argv.find((arg) => arg.startsWith(`${name}=`))?.split("=").slice(1).join("=");
}

function hasArg(name) {
  return process.argv.includes(name);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
