import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const ycSnapshotPath = join(root, "src", "lib", "yc", "spring-2026-companies.json");
const outputPath = join(root, "src", "lib", "social", "logged-in-evidence-current.json");
const checkpointPath = join(root, "work", "logged-in-social-checkpoint.json");
const verifiedSocialOverridesPath = join(root, "src", "lib", "social", "verified-social-overrides.json");
const openCliMain = join(process.env.APPDATA ?? "", "npm", "node_modules", "@jackwener", "opencli", "dist", "src", "main.js");
const now = new Date().toISOString();
const targetLimit = numberArg("--max-targets") ?? Number.POSITIVE_INFINITY;
const postLimit = numberArg("--limit") ?? 30;
const instagramFetchDetails = !booleanArg("--skip-instagram-details");
const scrollPasses = Math.max(0, Math.min(numberArg("--scrolls") ?? 8, 30));
const workers = Math.max(1, Math.min(numberArg("--workers") ?? 2, 8));
const perTargetTimeoutMs = numberArg("--timeout-ms") ?? 75_000;
const delayMs = numberArg("--delay-ms") ?? 1_500;
const force = booleanArg("--force");
const platformFilter = new Set((stringArg("--platforms") ?? "instagram,x").split(",").map((item) => item.trim()).filter(Boolean));
const entityFilter = stringArg("--entities") ?? "all"; // all | company | founder
const companyFilter = stringArg("--company")?.toLowerCase();
const includeRetweets = booleanArg("--include-retweets");
const allowXAdapterFallback = booleanArg("--allow-x-adapter-fallback");
const finalizeOnly = booleanArg("--finalize-only");
const retryEmpty = booleanArg("--retry-empty");
const allowLinkedIn = platformFilter.has("linkedin") && booleanArg("--allow-linkedin");
const openCliFormatArgs = ["-f", "json", "--site-session", "persistent"];
const instagramTractionCutoffMs = Date.parse("2025-01-01T00:00:00.000Z");
let writeSequence = 0;
let checkpointWriteChain = Promise.resolve();

const ycSnapshot = JSON.parse(await readFile(ycSnapshotPath, "utf8"));
const verifiedSocialOverrides = await readJson(verifiedSocialOverridesPath, {});
const checkpoint = await readJson(checkpointPath, { attempts: {}, evidence: [], failures: [], needsReview: [] });
const currentOutput = await readJson(outputPath, { evidence: [], failures: [], needsReview: [] });
const attemptMap = new Map(Object.entries(checkpoint.attempts ?? {}));
const evidence = dedupeById([...(currentOutput.evidence ?? []), ...(checkpoint.evidence ?? [])]);
const failures = dedupeById([...(currentOutput.failures ?? []), ...(checkpoint.failures ?? [])]);
const needsReview = dedupeById([...(currentOutput.needsReview ?? []), ...(checkpoint.needsReview ?? [])]);

const targets = finalizeOnly ? [] : collectTargets(ycSnapshot.companies).slice(0, targetLimit);
console.log(`Logged-in social targets: ${targets.length} (${workers} workers, up to ${postLimit} posts each, ${scrollPasses} scroll passes).`);

await runWorkerPool(targets, workers, async (target, workerIndex) => {
  const attemptKey = attemptKeyFor(target);
  const existingAttempt = attemptMap.get(attemptKey);
  if (!force && existingAttempt?.status === "done" && !(retryEmpty && existingAttempt.count === 0)) return;

  try {
    const result =
      target.platform === "linkedin"
        ? await fetchLinkedInPosts(target, workerIndex)
        : target.platform === "instagram"
          ? await fetchInstagramPosts(target, workerIndex)
          : await fetchXTweets(target, workerIndex);
    if (force) removeTargetEvidence(target);
    removeTargetFailures(target);
    addItems(result.evidence, evidence);
    addItems(result.failures, failures);
    addItems(result.needsReview, needsReview);
    attemptMap.set(attemptKey, { status: "done", checkedAt: now, count: result.evidence.length });
    console.log(`${target.platform} ${target.companyName} / ${target.name}: ${result.evidence.length} posts`);
  } catch (error) {
    failures.push(failure(target, errorMessage(error)));
    attemptMap.set(attemptKey, { status: "failed", checkedAt: now, error: errorMessage(error) });
    console.warn(`${target.platform} ${target.companyName} / ${target.name}: ${errorMessage(error)}`);
  }

  await writeCheckpoint();
  await delay(delayMs);
});

const payloadFailures = dedupeById(failures).filter((item) => !isObsoleteToolFailure(item.message));
const payload = {
  source: {
    label: "Opt-in logged-in browser social post ingestion",
    fetchedAt: now,
    targetCount: targets.length,
    fetchedCount: targets.filter((target) => attemptMap.get(attemptKeyFor(target))?.status === "done").length,
    failedCount: targets.filter((target) => attemptMap.get(attemptKeyFor(target))?.status === "failed").length,
    notes: [
      "Read-only browser automation through the user's authenticated OpenCLI browser session.",
      "No likes, follows, comments, messages, saves, stars, subscriptions, profile edits, or other mutations are performed.",
      "Instagram profile grids and X profile timelines are treated as opt-in authenticated/read-only sources when explicitly targeted.",
      "X ingestion uses visible browser timeline parsing by default; high-level adapter fallback is disabled unless --allow-x-adapter-fallback is passed.",
      "Logged-in LinkedIn activity scraping is disabled unless both --platforms=linkedin and --allow-linkedin are passed.",
      "Each target is checkpointed independently; blocked or timed-out profiles are logged and do not stop the batch."
    ]
  },
  evidence: sanitizeStoredRows(dedupeById(evidence)).sort((a, b) => b.contributionScore - a.contributionScore),
  failures: sanitizeStoredRows(payloadFailures),
  needsReview: sanitizeStoredRows(dedupeById(needsReview))
};

await writeJson(outputPath, payload);
await writeCheckpoint();
console.log(`Wrote ${payload.evidence.length} logged-in post evidence items, ${payload.failures.length} failures.`);

function collectTargets(companies) {
  const targets = [];

  for (const company of companies) {
    if (companyFilter && !company.name.toLowerCase().includes(companyFilter) && company.slug !== companyFilter) {
      continue;
    }
    if (entityFilter !== "founder") {
      if (allowLinkedIn && company.socialLinks?.linkedin) {
        targets.push(targetFor(company, company, "company", "linkedin", company.socialLinks.linkedin));
      }
      if (platformFilter.has("x") && company.socialLinks?.x) {
        targets.push(targetFor(company, company, "company", "x", company.socialLinks.x));
      }
      if (platformFilter.has("instagram") && company.socialLinks?.instagram) {
        targets.push(targetFor(company, company, "company", "instagram", company.socialLinks.instagram));
      }
    }

    if (entityFilter !== "company") {
      for (const founder of company.founders ?? []) {
        if (allowLinkedIn && founder.socialLinks?.linkedin) {
          targets.push(targetFor(company, founder, "founder", "linkedin", founder.socialLinks.linkedin));
        }
        if (platformFilter.has("x") && founder.socialLinks?.x) {
          targets.push(targetFor(company, founder, "founder", "x", founder.socialLinks.x));
        }
        if (platformFilter.has("instagram") && founder.socialLinks?.instagram) {
          targets.push(targetFor(company, founder, "founder", "instagram", founder.socialLinks.instagram));
        }
      }
    }

    targets.push(...manualTargetsForCompany(company));
  }

  return dedupeTargets(targets.filter((target) => target.url));
}

function targetFor(company, entity, entityType, platform, url) {
  return {
    platform,
    url,
    companySlug: company.slug,
    companyName: company.name,
    companyWebsiteUrl: company.websiteUrl,
    entityType,
    entityId: entityType === "company" ? companyId(company) : `founder-${company.slug}-${slugify(entity.name)}-${entity.id}`,
    name: entityType === "company" ? company.name : entity.name,
    matchReason: entity.matchReason ?? null
  };
}

function manualTargetsForCompany(company) {
  const override = verifiedSocialOverrides[company.slug];
  if (!override) return [];

  const targets = [];
  if (entityFilter !== "founder") {
    for (const [platform, url] of Object.entries(override.companySocialLinks ?? override.company ?? {})) {
      if (platformFilter.has(platform)) {
        if (platform === "instagram" && !instagramOverrideIsVerifiedForIngestion(override)) {
          continue;
        }
        targets.push(
          targetFor(
            company,
            {
              ...company,
              matchReason:
                override.matchReason ??
                `Verified social override for ${company.name}; profile links back to the official company identity.`
            },
            "company",
            platform,
            url
          )
        );
      }
    }
  }

  if (entityFilter !== "company") {
    for (const founder of override.founders ?? []) {
      for (const platform of ["instagram", "x"]) {
        const url = founder.socialLinks?.[platform] ?? founder[platform];
        if (url && platformFilter.has(platform)) {
          if (platform === "instagram" && !instagramMatchReasonIsVerifiedForIngestion(founder.matchReason)) {
            continue;
          }
          targets.push(targetFor(company, founder, "founder", platform, url));
        }
      }
    }
  }

  return targets;
}

function dedupeTargets(targets) {
  return [
    ...new Map(
      targets.map((target) => [
        `${target.platform}:${target.entityId}:${normalizeComparableUrl(target.url)}`,
        target
      ])
    ).values()
  ];
}

async function fetchLinkedInPosts(target, workerIndex) {
  if (!urlMatchesPlatform(target.url, "linkedin")) {
    return { evidence: [], failures: [failure(target, "LinkedIn URL host did not match linkedin.com.")], needsReview: [] };
  }

  const activityUrl = linkedInActivityUrl(target.url);
  if (!activityUrl) {
    return { evidence: [], failures: [failure(target, "Unsupported LinkedIn URL shape.")], needsReview: [] };
  }

  const session = `yc-li-${workerIndex}`;
  await runOpenCli(["browser", session, "open", activityUrl], { timeoutMs: perTargetTimeoutMs });
  await runOpenCli(["browser", session, "wait", "time", "5"], { timeoutMs: 12_000 });
  for (let index = 0; index < 2; index += 1) {
    await runOpenCli(["browser", session, "scroll", "down", "--amount", "1200"], { timeoutMs: 12_000 }).catch(() => null);
    await runOpenCli(["browser", session, "wait", "time", "2"], { timeoutMs: 8_000 }).catch(() => null);
  }

  const raw = await runOpenCli(["browser", session, "eval", linkedInExtractJs()], { timeoutMs: perTargetTimeoutMs });
  const posts = parseJsonOutput(raw)
    .filter((post) => !isLinkedInRepost(post, target.name))
    .slice(0, postLimit);
  if (!posts.length) {
    return { evidence: [], failures: [failure(target, "No original visible LinkedIn posts found on activity page.", activityUrl)], needsReview: [] };
  }

  return {
    evidence: posts.map((post, index) =>
      socialEvidenceItem({
        target,
        sourceUrl: post.url || `${activityUrl}#post-${index + 1}`,
        title: `${target.name} LinkedIn post`,
        text: post.body || post.rawText || `${target.name} LinkedIn post`,
        rawVisibleText: post.rawText || post.body || "",
        postedAt: null,
        metrics: {
          likes: numberOrNull(post.reactions),
          comments: numberOrNull(post.comments),
          reposts: numberOrNull(post.reposts),
          views: numberOrNull(post.impressions)
        },
        mediaUrls: post.mediaUrls ?? [],
        contributionScore: scoreMetrics("linkedin", {
          likes: numberOrNull(post.reactions),
          comments: numberOrNull(post.comments),
          reposts: numberOrNull(post.reposts),
          views: numberOrNull(post.impressions)
        }),
        matchReason: `Opt-in logged-in LinkedIn activity-page original post scrape from ${target.entityType} URL.`
      })
    ),
    failures: [],
    needsReview: []
  };
}

async function fetchInstagramPosts(target, workerIndex) {
  if (!urlMatchesPlatform(target.url, "instagram")) {
    return { evidence: [], failures: [failure(target, "Instagram URL host did not match instagram.com.")], needsReview: [] };
  }

  const handle = instagramHandleFromUrl(target.url);
  if (!handle) {
    return { evidence: [], failures: [failure(target, "Could not parse Instagram username.")], needsReview: [] };
  }

  const adapterFailures = [];
  const [profileRaw, postsRaw, gridUrls] = await Promise.all([
    runOpenCli(["instagram", "profile", handle, ...openCliFormatArgs], { timeoutMs: perTargetTimeoutMs }).catch((error) => {
      adapterFailures.push(failure(target, `Instagram profile adapter failed: ${errorMessage(error)}`));
      return "[]";
    }),
    runOpenCli(["instagram", "user", handle, "--limit", String(postLimit), ...openCliFormatArgs], {
      timeoutMs: perTargetTimeoutMs
    }).catch((error) => {
      adapterFailures.push(failure(target, `Instagram user adapter failed: ${errorMessage(error)}`));
      return "[]";
    }),
    fetchInstagramGridUrls(handle, workerIndex, postLimit).catch((error) => {
      adapterFailures.push(failure(target, `Instagram browser grid extractor failed: ${errorMessage(error)}`));
      return [];
    })
  ]);

  const profile = parseJsonOutput(profileRaw)[0] ?? null;
  const posts = parseJsonOutput(postsRaw).slice(0, postLimit);
  if (profile && !instagramProfileMatchesTarget(target, handle, profile)) {
    return {
      evidence: [],
      failures: [
        ...adapterFailures,
        failure(
          target,
          `Instagram profile identity mismatch for @${handle}: visible profile name/bio/link did not match ${target.entityType === "company" ? target.companyName : target.name}.`
        )
      ],
      needsReview: []
    };
  }
  const detailItems = instagramFetchDetails
    ? await fetchInstagramPostDetails(handle, gridUrls, workerIndex).catch(() => [])
    : [];
  const detailsByUrl = new Map(detailItems.map((item) => [canonicalInstagramPostUrl(item.url), item]));
  const adapterEvidence = posts.map((post, index) => {
    const gridItem = instagramGridItemForPost(gridUrls, post, index);
    const gridUrl = gridItem?.href ?? null;
    const sourceUrl =
      canonicalInstagramPostUrl(post.url) ??
      canonicalInstagramPostUrl(gridUrl) ??
      `https://www.instagram.com/${handle}/#post-${post.index ?? index + 1}`;
    const detail = detailsByUrl.get(canonicalInstagramPostUrl(sourceUrl));
    const metrics = {
      likes: maxMetric(post.likes, detail?.likes, gridItem?.likes),
      comments: maxMetric(post.comments, detail?.comments, gridItem?.comments),
      views: maxMetric(post.views, detail?.views, gridItem?.views)
    };
    const caption = bestInstagramCaption(post.caption, gridItem?.caption, detail?.caption);
    return socialEvidenceItem({
      target,
      sourceUrl,
      platformPostId: instagramPostIdFromUrl(sourceUrl) ?? `${handle}-${post.index ?? index + 1}`,
      title: caption || `${handle} Instagram ${post.type ?? "post"}`,
      text: caption || `${handle} Instagram ${post.type ?? "post"}`,
      rawVisibleText: JSON.stringify({ profile, post, gridUrl: gridItem, detail }),
      postedAt: parseInstagramDateOrNull(post.date) ?? detail?.postedAt ?? null,
      metrics,
      mediaUrls: detail?.mediaUrls ?? gridItem?.mediaUrls ?? [],
      contributionScore: scoreMetrics("instagram", metrics),
      matchReason:
        target.matchReason ??
        `Opt-in read-only Instagram profile scrape for @${handle}; metrics came from visible post grid/profile/detail data.`
    });
  });
  const seenPostIds = new Set(adapterEvidence.map((item) => item.platformPostId).filter(Boolean));
  const gridEvidence = gridUrls
    .filter((gridUrl) => {
      const sourceUrl = canonicalInstagramPostUrl(gridUrl.href);
      const postId = instagramPostIdFromUrl(sourceUrl);
      return sourceUrl && postId && !seenPostIds.has(postId);
    })
    .map((gridUrl, index) => {
      const sourceUrl = canonicalInstagramPostUrl(gridUrl.href);
      const detail = detailsByUrl.get(sourceUrl);
      const metrics = {
        likes: maxMetric(detail?.likes, gridUrl.likes),
        comments: maxMetric(detail?.comments, gridUrl.comments),
        views: maxMetric(detail?.views, gridUrl.views)
      };
      const caption = bestInstagramCaption(gridUrl.caption, detail?.caption);
      return socialEvidenceItem({
        target,
        sourceUrl,
        platformPostId: instagramPostIdFromUrl(sourceUrl) ?? `${handle}-grid-${index + 1}`,
        title: caption || `${handle} Instagram post`,
        text: caption || `${handle} Instagram post`,
        rawVisibleText: JSON.stringify({ profile, gridUrl, detail }),
        postedAt: detail?.postedAt ?? null,
        metrics,
        mediaUrls: detail?.mediaUrls ?? gridUrl.mediaUrls ?? [],
        contributionScore: scoreMetrics("instagram", metrics),
        matchReason:
          target.matchReason ??
          `Opt-in read-only Instagram grid/detail scrape for @${handle}; adapter did not return this visible grid item.`
      });
    });
  const evidenceItems = dedupeById([...adapterEvidence, ...gridEvidence])
    .filter(hasScoredTraction)
    .filter(isRelevantInstagramTraction);
  if (!evidenceItems.length) {
    return {
      evidence: [],
      failures: [
        ...adapterFailures,
        failure(target, "No scored recent Instagram posts found with adapter or browser grid/detail extractor.")
      ],
      needsReview: []
    };
  }

  return {
    evidence: evidenceItems,
    failures: adapterFailures,
    needsReview: []
  };
}

async function fetchXTweets(target, workerIndex) {
  if (!urlMatchesPlatform(target.url, "x")) {
    return { evidence: [], failures: [failure(target, "X/Twitter URL host did not match x.com or twitter.com.")], needsReview: [] };
  }

  const handle = xHandleFromUrl(target.url);
  if (!handle) {
    return { evidence: [], failures: [failure(target, "Could not parse X/Twitter handle.")], needsReview: [] };
  }

  const browserResult = await fetchXTweetsFromBrowser(target, handle, workerIndex).catch((error) => ({
    evidence: [],
    failures: [failure(target, `X browser DOM extractor failed: ${errorMessage(error)}`)],
    needsReview: []
  }));
  if (browserResult.evidence.length) {
    return browserResult;
  }
  if (!allowXAdapterFallback) {
    return browserResult.failures.length
      ? browserResult
      : { evidence: [], failures: [failure(target, "No original visible X posts found; high-level X adapter fallback disabled.")], needsReview: [] };
  }

  const raw = await runOpenCli(
    ["twitter", "tweets", handle, "--limit", String(postLimit), "--top-by-engagement", String(postLimit), ...openCliFormatArgs],
    { timeoutMs: Math.min(perTargetTimeoutMs, 35_000) }
  );
  const tweets = parseJsonOutput(raw)
    .filter((tweet) => includeRetweets || !tweet.is_retweet)
    .slice(0, postLimit);
  if (!tweets.length) {
    return { evidence: [], failures: [failure(target, "No original visible X posts returned by OpenCLI tweets adapter.")], needsReview: [] };
  }

  return {
    evidence: tweets.map((tweet) =>
      socialEvidenceItem({
        target,
        sourceUrl: tweet.url || `https://x.com/${handle}`,
        title: `${tweet.author || target.name} X post`,
        text: tweet.text || "",
        rawVisibleText: JSON.stringify(tweet),
        postedAt: parseXDateLabel(tweet.created_at) ?? parseDateOrNull(tweet.created_at),
        metrics: {
          likes: numberOrNull(tweet.likes),
          reposts: numberOrNull(tweet.retweets),
          comments: numberOrNull(tweet.replies),
          views: numberOrNull(tweet.views)
        },
        mediaUrls: [...(tweet.media_urls ?? []), ...(tweet.media_posters ?? [])].filter(Boolean),
        contributionScore: scoreMetrics("x", {
          likes: numberOrNull(tweet.likes),
          reposts: numberOrNull(tweet.retweets),
          comments: numberOrNull(tweet.replies),
          views: numberOrNull(tweet.views)
        }),
        matchReason: `Opt-in logged-in X profile timeline read for @${handle}.`
      })
    ),
    failures: [],
    needsReview: []
  };
}

async function fetchInstagramGridUrls(handle, workerIndex, desiredCount) {
  const session = `yc-ig-${workerIndex}-${slugify(handle)}-${Date.now()}`;
  await runOpenCli(["browser", session, "open", `https://www.instagram.com/${handle}/`], { timeoutMs: perTargetTimeoutMs });
  await runOpenCli(["browser", session, "wait", "time", "4"], { timeoutMs: 10_000 }).catch(() => null);
  const byUrl = new Map();
  for (let index = 0; index <= scrollPasses && byUrl.size < desiredCount; index += 1) {
    const raw = await runOpenCli(["browser", session, "eval", instagramGridExtractJs()], { timeoutMs: perTargetTimeoutMs });
    for (const item of parseJsonOutput(raw)) {
      if (item?.href) byUrl.set(item.href, item);
    }
    if (byUrl.size >= desiredCount || index === scrollPasses) break;
    await runOpenCli(["browser", session, "scroll", "down", "--amount", "1100"], { timeoutMs: 10_000 }).catch(() => null);
    await runOpenCli(["browser", session, "eval", instagramProfileScrollJs(index)], { timeoutMs: 10_000 }).catch(() => null);
    await runOpenCli(["browser", session, "wait", "time", "1.5"], { timeoutMs: 8_000 }).catch(() => null);
  }
  return [...byUrl.values()].slice(0, desiredCount);
}

async function fetchInstagramPostDetails(handle, gridUrls, workerIndex) {
  const session = `yc-ig-detail-${workerIndex}-${slugify(handle)}-${Date.now()}`;
  const details = [];
  const urls = gridUrls
    .map((item) => canonicalInstagramPostUrl(item.href))
    .filter(Boolean)
    .slice(0, postLimit);

  for (const url of urls) {
    await runOpenCli(["browser", session, "open", url], { timeoutMs: perTargetTimeoutMs }).catch(() => null);
    await runOpenCli(["browser", session, "wait", "time", "2.5"], { timeoutMs: 8_000 }).catch(() => null);
    const raw = await runOpenCli(["browser", session, "eval", instagramPostDetailExtractJs()], {
      timeoutMs: perTargetTimeoutMs
    }).catch(() => "[]");
    const parsed = parseJsonOutput(raw)[0] ?? parseJsonOutput(raw);
    if (parsed?.url || parsed?.description || parsed?.caption) {
      details.push({
        url,
        caption: parsed.caption ?? null,
        rawText: parsed.text ?? parsed.description ?? "",
        description: parsed.description ?? null,
        postedAt: parseInstagramDateOrNull(parsed.dateLabel),
        likes: numberOrNull(parsed.likes),
        comments: numberOrNull(parsed.comments),
        views: numberOrNull(parsed.views),
        mediaUrls: parsed.mediaUrls ?? []
      });
    }
    await delay(Math.min(delayMs, 1200));
  }

  return details;
}

async function fetchXTweetsFromBrowser(target, handle, workerIndex) {
  const session = `yc-x-${workerIndex}`;
  await runOpenCli(["browser", session, "open", `https://x.com/${handle}`], { timeoutMs: perTargetTimeoutMs });
  await runOpenCli(["browser", session, "wait", "time", "5"], { timeoutMs: 12_000 }).catch(() => null);
  const byId = new Map();
  for (let index = 0; index <= scrollPasses && byId.size < postLimit; index += 1) {
    const raw = await runOpenCli(["browser", session, "eval", xTimelineExtractJs()], { timeoutMs: perTargetTimeoutMs });
    for (const item of parseJsonOutput(raw)) {
      if (item?.id) byId.set(item.id, item);
    }
    if (byId.size >= postLimit || index === scrollPasses) break;
    await runOpenCli(["browser", session, "scroll", "down", "--amount", "900"], { timeoutMs: 10_000 }).catch(() => null);
    await runOpenCli(["browser", session, "wait", "time", "2"], { timeoutMs: 8_000 }).catch(() => null);
  }
  const tweets = [...byId.values()]
    .filter((tweet) => includeRetweets || !tweet.is_retweet)
    .slice(0, postLimit);
  if (!tweets.length) {
    return { evidence: [], failures: [failure(target, "No original visible X posts found with browser DOM extractor.")], needsReview: [] };
  }

  return {
    evidence: tweets.map((tweet) =>
      socialEvidenceItem({
        target,
        sourceUrl: tweet.url || `https://x.com/${handle}`,
        platformPostId: tweet.id ?? null,
        title: `${tweet.author || target.name} X post`,
        text: tweet.text || "",
        rawVisibleText: JSON.stringify(tweet),
        postedAt: parseXDateLabel(tweet.created_at) ?? parseDateOrNull(tweet.created_at),
        metrics: {
          likes: numberOrNull(tweet.likes),
          reposts: numberOrNull(tweet.retweets),
          comments: numberOrNull(tweet.replies),
          views: numberOrNull(tweet.views)
        },
        mediaUrls: tweet.media_urls ?? [],
        contributionScore: scoreMetrics("x", {
          likes: numberOrNull(tweet.likes),
          reposts: numberOrNull(tweet.retweets),
          comments: numberOrNull(tweet.replies),
          views: numberOrNull(tweet.views)
        }),
        matchReason:
          target.matchReason ??
          `Opt-in read-only X browser timeline scrape for @${handle}; metrics came from visible aria-label post controls.`
      })
    ),
    failures: [],
    needsReview: []
  };
}

function linkedInActivityUrl(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] === "in" && parts[1]) {
      return `https://www.linkedin.com/in/${parts[1]}/recent-activity/all/`;
    }
    if (parts[0] === "company" && parts[1]) {
      return `https://www.linkedin.com/company/${parts[1]}/posts/`;
    }
  } catch {
    return null;
  }
  return null;
}

function xHandleFromUrl(url) {
  try {
    const parsed = new URL(url);
    const [handle] = parsed.pathname.split("/").filter(Boolean);
    return handle?.replace(/^@/, "") ?? null;
  } catch {
    return null;
  }
}

function instagramHandleFromUrl(url) {
  try {
    const parsed = new URL(url);
    const [handle] = parsed.pathname.split("/").filter(Boolean);
    return handle?.replace(/^@/, "") ?? null;
  } catch {
    return null;
  }
}

function instagramGridItemForPost(gridUrls, post, fallbackIndex) {
  const postUrl = canonicalInstagramPostUrl(post?.url);
  const postId = instagramPostIdFromUrl(postUrl);
  const byPostId = postId
    ? gridUrls.find((item) => instagramPostIdFromUrl(item.href) === postId)
    : null;
  return byPostId ?? gridUrls[fallbackIndex] ?? null;
}

function socialEvidenceItem(input) {
  const metrics = removeNullish(input.metrics ?? {});
  const textValue =
    input.target.platform === "linkedin" ? cleanLinkedInPostText(input.text, input.target.name) : input.text;
  const rawVisibleText = sanitizePublicText(input.rawVisibleText || textValue);
  return {
    id: stableId(`${input.target.platform}:${input.target.entityId}:${input.sourceUrl}:${input.text}`),
    entityType: input.target.entityType,
    entityId: input.target.entityId,
    companySlug: input.target.companySlug,
    companyName: input.target.companyName,
    platform: input.target.platform,
    title: sanitizePublicText(input.title),
    sourceUrl: input.sourceUrl,
    platformPostId: input.platformPostId ?? null,
    text: sanitizePublicText(textValue).slice(0, 900),
    rawVisibleText: rawVisibleText.slice(0, 8000),
    postedAt: input.postedAt ?? null,
    metrics,
    mediaUrls: input.mediaUrls ?? [],
    contributionScore: input.contributionScore ?? scoreMetrics(input.target.platform, metrics),
    review_state: "verified",
    matchReason: input.matchReason,
    first_seen_at: now,
    last_checked_at: now,
    last_updated_at: input.postedAt ?? now
  };
}

function cleanLinkedInPostText(text, authorName) {
  let value = cleanText(text)
    .replace(/^Feed post number\s+\d+\s+/i, "")
    .replace(/\bVisible to anyone on or off LinkedIn\b/gi, "")
    .replace(/\bOpen reactions menu\b/gi, "")
    .replace(/\b(Like|Comment|Repost|Send)\b\s*$/gi, "")
    .trim();
  const relativeTime = value.match(/\b(?:\d+\s+(?:week|month|year|day|hour)s?\s+ago|\d+[wdhmy]|1yr|2yr|3yr)\s*•?\s*/i);
  if (relativeTime && relativeTime.index !== undefined && relativeTime.index < 360) {
    value = value.slice(relativeTime.index + relativeTime[0].length).trim();
  }
  if (authorName) {
    const escaped = escapeRegExp(authorName);
    value = value.replace(new RegExp(`^(?:${escaped}\\s*){1,4}`, "i"), "").trim();
  }
  return value || text;
}

function isLinkedInRepost(post, authorName) {
  const value = cleanText(`${post?.body ?? ""} ${post?.rawText ?? ""}`);
  const firstChunk = value.slice(0, 700);
  if (/\breposted this\b/i.test(firstChunk)) {
    return true;
  }

  if (authorName) {
    return new RegExp(`\\b${escapeRegExp(authorName)}\\s+reposted\\b`, "i").test(firstChunk);
  }

  return false;
}

function failure(target, message, sourceUrl = target.url) {
  return {
    id: stableId(`failure:${target.platform}:${target.entityId}:${sourceUrl}:${message}`),
    platform: target.platform,
    companySlug: target.companySlug,
    companyName: target.companyName,
    entityType: target.entityType,
    entityName: target.name,
    sourceUrl,
    message,
    checkedAt: now
  };
}

async function runOpenCli(args, options = {}) {
  try {
    const command = process.platform === "win32" ? process.execPath : "opencli";
    const commandArgs = process.platform === "win32" ? [openCliMain, ...args] : args;
    const result = await execFileAsync(command, commandArgs, {
      cwd: root,
      timeout: options.timeoutMs ?? perTargetTimeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true
    });
    return result.stdout;
  } catch (error) {
    const stdout = error.stdout ? String(error.stdout) : "";
    const stderr = error.stderr ? String(error.stderr) : "";
    throw new Error(cleanText(`${stdout}\n${stderr}\n${error.message}`));
  }
}

function parseJsonOutput(raw) {
  const value = String(raw ?? "").trim();
  const start = Math.min(
    ...[value.indexOf("{"), value.indexOf("[")].filter((index) => index >= 0)
  );
  if (!Number.isFinite(start)) return [];
  return JSON.parse(value.slice(start));
}

async function runWorkerPool(items, concurrency, fn) {
  let nextIndex = 0;
  const runners = Array.from({ length: concurrency }, async (_, workerIndex) => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await fn(item, workerIndex);
    }
  });
  await Promise.all(runners);
}

function scoreMetrics(platform, metrics) {
  const likes = metrics.likes ?? 0;
  const comments = metrics.comments ?? 0;
  const shares = metrics.shares ?? metrics.reposts ?? 0;
  const views = metrics.views ?? 0;
  const upvotes = metrics.upvotes ?? 0;
  if (![likes, comments, shares, views, upvotes].some((value) => value > 0)) {
    return 0;
  }
  const viewWeight = platform === "x" || platform === "linkedin" ? 0.06 : platform === "instagram" ? 0.05 : 0.02;
  const commentWeight = platform === "x" || platform === "linkedin" ? 5.5 : platform === "instagram" ? 5 : 3;
  const shareWeight = platform === "x" || platform === "linkedin" ? 8 : 4;
  const likeWeight = platform === "x" || platform === "linkedin" ? 1.5 : platform === "instagram" ? 1.1 : 1;
  const raw = likes * likeWeight + comments * commentWeight + shares * shareWeight + upvotes * 2.5 + views * viewWeight;
  const platformBoost = platform === "linkedin" || platform === "x" ? 1.1 : 1;
  const saturationPoint = platform === "linkedin" || platform === "x" ? 160_000 : 120_000;
  return Math.max(1, Math.min(100, Math.round((Math.log1p(raw * platformBoost) / Math.log1p(saturationPoint)) * 100)));
}

function parseCompactNumber(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/,/g, "").trim();
  const match = cleaned.match(/([\d.]+)\s*([KMB])?/i);
  if (!match) return null;
  const number = Number(match[1]);
  const suffix = match[2]?.toUpperCase();
  const multiplier = suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : suffix === "B" ? 1_000_000_000 : 1;
  return Number.isFinite(number) ? Math.round(number * multiplier) : null;
}

function numberOrNull(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return parseCompactNumber(value);
}

function maxMetric(...values) {
  const parsed = values.map(numberOrNull).filter((value) => Number.isFinite(value) && value > 0);
  return parsed.length ? Math.max(...parsed) : null;
}

function hasScoredTraction(item) {
  return Number(item?.contributionScore ?? 0) > 0 && Object.values(item?.metrics ?? {}).some((value) => Number(value) > 0);
}

function isRelevantInstagramTraction(item) {
  if (item?.platform !== "instagram" || !item.postedAt) return true;
  const postedAtMs = Date.parse(item.postedAt);
  return !Number.isFinite(postedAtMs) || postedAtMs >= instagramTractionCutoffMs;
}

function instagramProfileMatchesTarget(target, handle, profile) {
  const displayName = normalizeIdentityText(profile?.name);
  const externalText = normalizeIdentityText([profile?.externalUrl, profile?.website].filter(Boolean).join(" "));
  const bioText = normalizeIdentityText(profile?.bio);
  const entityName = normalizeIdentityText(target.entityType === "company" ? target.companyName : target.name);
  const companyName = normalizeIdentityText(target.companyName);
  const domainToken = normalizeIdentityText(domainIdentityToken(target.companyWebsiteUrl));

  const externalTokens = [companyName, domainToken].filter((token) => token.length >= 4);
  if (externalText && externalTokens.some((token) => externalText.includes(token))) return true;

  const exactDisplayName = displayName && (displayName === entityName || displayName === companyName);
  if (!exactDisplayName) return false;

  const officialSiteDiscovered = /official company website|official website outbound|source chain starts/i.test(
    target.matchReason ?? ""
  );
  const validatedOverride = /live instagram identity validation|manual verified|visible read-only social profiles/i.test(
    target.matchReason ?? ""
  );
  const searchDerived = /(?:Web Instagram search|OpenCLI Instagram search)/i.test(target.matchReason ?? "");
  if (searchDerived && !validatedOverride) {
    return false;
  }
  if (target.entityType === "company" && officialSiteDiscovered) {
    return true;
  }

  const rawName = target.entityType === "company" ? target.companyName : target.name;
  const wordCount = String(rawName ?? "").trim().split(/\s+/).filter(Boolean).length;
  if (target.entityType === "company") {
    const followerCount = numberOrNull(profile?.followers);
    return wordCount >= 2 && (followerCount === null || followerCount >= 100);
  }

  const founderContextTokens = [companyName, domainToken].filter((token) => token.length >= 4);
  return wordCount >= 2 || founderContextTokens.some((token) => bioText.includes(token));
}

function instagramOverrideIsVerifiedForIngestion(override) {
  if (override?.instagramValidation?.review_state === "verified") return true;
  return instagramMatchReasonIsVerifiedForIngestion(override?.matchReason);
}

function instagramMatchReasonIsVerifiedForIngestion(matchReason) {
  const reason = String(matchReason ?? "");
  if (/official company website|official website outbound|source chain starts/i.test(reason)) return true;
  if (/live instagram identity validation|manual verified|visible read-only social profiles/i.test(reason)) return true;
  return !/(?:Web Instagram search|OpenCLI Instagram search)/i.test(reason);
}

function normalizeIdentityText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");
}

function domainIdentityToken(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    const parts = host.split(".");
    if (parts.length >= 2 && parts.at(-2) === "co" && parts.at(-1)?.length === 2) return parts.at(-3) ?? parts[0];
    return parts[0] ?? "";
  } catch {
    return "";
  }
}

function bestInstagramCaption(...values) {
  return (
    values
      .map((value) => cleanText(value))
      .find((value) => value && !isGenericInstagramAlt(value)) ?? ""
  );
}

function isGenericInstagramAlt(value) {
  return (
    /\bprofile picture\b/i.test(value) ||
    /^user avatar$/i.test(value) ||
    /^photo by @?[a-z0-9_.]+ on [a-z]+ \d{1,2}, \d{4}\.?$/i.test(value)
  );
}

function parseDateOrNull(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function parseInstagramDateOrNull(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function parseXDateLabel(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const relative = text.match(/^(\d+)\s*(m|h|d|minutes?|hours?|days?)\s*(?:ago)?$/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase()[0];
    const ms = unit === "m" ? amount * 60_000 : unit === "h" ? amount * 3_600_000 : amount * 86_400_000;
    return new Date(Date.now() - ms).toISOString();
  }

  const monthDay = text.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})$/i);
  if (monthDay) {
    const currentYear = new Date().getUTCFullYear();
    const parsed = Date.parse(`${monthDay[1]} ${monthDay[2]}, ${currentYear} UTC`);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }

  return parseDateOrNull(text);
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

function normalizeComparableUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    parsed.hostname = parsed.hostname.replace(/^www\./, "").toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/$/, "");
    return parsed.toString().toLowerCase();
  } catch {
    return String(url ?? "").toLowerCase();
  }
}

function canonicalInstagramPostUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const postIndex = parts.findIndex((part) => /^(p|reel|tv)$/i.test(part));
    if (postIndex < 0 || !parts[postIndex + 1]) return null;
    return `https://www.instagram.com/${parts[postIndex].toLowerCase()}/${parts[postIndex + 1]}/`;
  } catch {
    return null;
  }
}

function instagramPostIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const postIndex = parts.findIndex((part) => /^(p|reel|tv)$/i.test(part));
    return postIndex >= 0 ? parts[postIndex + 1] ?? null : null;
  } catch {
    return null;
  }
}

async function writeCheckpoint() {
  const snapshot = {
    attempts: Object.fromEntries(attemptMap),
    evidence: sanitizeStoredRows(dedupeById(evidence)),
    failures: sanitizeStoredRows(dedupeById(failures)),
    needsReview: sanitizeStoredRows(dedupeById(needsReview))
  };
  checkpointWriteChain = checkpointWriteChain.catch(() => undefined).then(() => writeJson(checkpointPath, snapshot));
  await checkpointWriteChain;
}

function sanitizeStoredRows(rows) {
  if (allowLinkedIn) return rows;
  return rows.filter((row) => row?.platform !== "linkedin");
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
  const tempPath = `${path}.${process.pid}.${Date.now()}.${++writeSequence}.tmp`;
  await writeFile(tempPath, `${serializeJson(value)}\n`);
  await rename(tempPath, path);
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
    .replace(/\bJSESSIONID=\"[^\"]+\"/gi, "JSESSIONID=\"[redacted-cookie]\"")
    .replace(/\bli_at=[A-Za-z0-9%._/-]{16,}/gi, "li_at=[redacted-cookie]")
    .replace(/\b[A-Za-z0-9_-]{3,}=[A-Za-z0-9%._/-]{16,}/g, (match) => {
      const key = match.split("=")[0];
      return `${key}=[redacted-public-param]`;
    });
}

function cleanText(value) {
  return String(value ?? "").replace(/\\u0026/g, "&").replace(/\s+/g, " ").trim();
}

function sanitizePublicText(value) {
  return redactTokenLikeStrings(cleanText(value));
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
    .replace(/sk-/g, "s-k-")
    .slice(0, 180);
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function companyId(company) {
  return `company-${company.slug}`;
}

function addItems(items = [], target) {
  for (const item of items) target.push(item);
}

function removeTargetEvidence(target) {
  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const item = evidence[index];
    if (item.platform === target.platform && item.entityId === target.entityId) {
      evidence.splice(index, 1);
    }
  }
}

function removeTargetFailures(target) {
  for (let index = failures.length - 1; index >= 0; index -= 1) {
    const item = failures[index];
    if (item.platform === target.platform && item.entityType === target.entityType && item.entityName === target.name) {
      failures.splice(index, 1);
    }
  }
}

function dedupeById(items) {
  const byId = new Map();
  for (const item of items) {
    if (!item?.id) continue;
    byId.set(item.id, mergeEvidenceLikeRows(byId.get(item.id), item));
  }
  return [...byId.values()];
}

function mergeEvidenceLikeRows(existing, incoming) {
  if (!existing) return incoming;
  const merged = { ...existing, ...incoming };
  for (const field of [
    "thumbnailUrl",
    "thumbnailSource",
    "mediaUrl",
    "mediaUrls",
    "linkStatus",
    "linkCheckedAt",
    "linkFailureReason"
  ]) {
    if (isEmptyValue(incoming[field]) && !isEmptyValue(existing[field])) {
      merged[field] = existing[field];
    }
  }
  return merged;
}

function isEmptyValue(value) {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

function attemptKeyFor(target) {
  return `${target.platform}:${target.entityId}:${target.url}`;
}

function isObsoleteToolFailure(message) {
  return /spawn opencli ENOENT|powershell\.exe|LINKEDIN_EXTRACT_JS|Unexpected token '\)'/i.test(message ?? "");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function booleanArg(name) {
  return process.argv.includes(name);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function instagramGridExtractJs() {
  return `(() => {
  const parseNumber = (value) => {
    const match = String(value || "").replace(/,/g, "").match(/([0-9]+(?:\\.[0-9]+)?)\\s*([KMB])?/i);
    if (!match) return null;
    const suffix = (match[2] || "").toUpperCase();
    const mult = suffix === "K" ? 1000 : suffix === "M" ? 1000000 : suffix === "B" ? 1000000000 : 1;
    return Math.round(Number(match[1]) * mult);
  };
  const metricFromText = (value, word) => {
    const match = String(value || "").match(new RegExp("([0-9,.]+\\\\s*[KMB]?)\\\\s+" + word, "i"));
    return match ? parseNumber(match[1]) : null;
  };
  const overlayMetric = (anchor, labels, href) => {
    const labelText = labels.join(" ");
    const rawText = anchor.innerText || anchor.textContent || "";
    const explicitViews = metricFromText(labelText + " " + rawText, "views?|plays?");
    const explicitLikes = metricFromText(labelText + " " + rawText, "likes?");
    const explicitComments = metricFromText(labelText + " " + rawText, "comments?");
    const compactLines = rawText
      .split(/\\n+/)
      .map((line) => line.trim())
      .filter((line) => /^[0-9,.]+\\s*[KMB]?$/i.test(line));
    const firstCompact = compactLines.map(parseNumber).find((value) => value && value > 0) || null;
    const isVideo = /\\/(?:reel|tv)\\//i.test(href) || /reel|video|play/i.test(labelText + " " + rawText);
    return {
      rawText: rawText.slice(0, 500),
      views: explicitViews ?? (isVideo ? firstCompact : null),
      likes: explicitLikes ?? (!isVideo ? firstCompact : null),
      comments: explicitComments
    };
  };
  const links = Array.from(document.querySelectorAll("a"))
    .filter((anchor) => /\\/(?:[^/]+\\/)?(?:reel|p|tv)\\//i.test(anchor.href || ""));
  const seen = new Set();
  return links
    .map((anchor) => {
      try {
        const href = anchor.href;
        const url = new URL(href, location.origin);
        const parts = url.pathname.split("/").filter(Boolean);
        const postIndex = parts.findIndex((part) => /^(reel|p|tv)$/i.test(part));
        if (postIndex < 0 || !parts[postIndex + 1]) return null;
        const canonical = "https://www.instagram.com/" + parts[postIndex].toLowerCase() + "/" + parts[postIndex + 1] + "/";
        if (seen.has(canonical)) return null;
        seen.add(canonical);
        const images = Array.from(anchor.querySelectorAll("img[src]"));
        const captions = images.map((img) => img.alt).filter(Boolean);
        const labels = Array.from(anchor.querySelectorAll("[aria-label]")).map((node) => node.getAttribute("aria-label")).filter(Boolean);
        const metrics = overlayMetric(anchor, labels, canonical);
        return {
          href: canonical,
          rawHref: href,
          platformPostId: parts[postIndex + 1],
          caption: captions[0] || "",
          mediaUrls: images.map((img) => img.src).filter(Boolean).slice(0, 2),
          labels,
          rawText: metrics.rawText,
          views: metrics.views,
          likes: metrics.likes,
          comments: metrics.comments
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .slice(0, 60);
})()`;
}

function instagramProfileScrollJs(index) {
  const amount = 1600 + index * 600;
  return `(() => {
  window.scrollBy(0, ${amount});
  document.documentElement.scrollTop = Math.max(document.documentElement.scrollTop, window.scrollY);
  document.body.scrollTop = Math.max(document.body.scrollTop || 0, window.scrollY);
  return { y: window.scrollY, body: document.body.scrollHeight, doc: document.documentElement.scrollHeight };
})()`;
}

function instagramPostDetailExtractJs() {
  return `(() => {
  const parseNumber = (value) => {
    if (value === null || /^null$/i.test(String(value))) return null;
    const match = String(value || "").replace(/,/g, "").match(/([0-9]+(?:\\.[0-9]+)?)\\s*([KMB])?/i);
    if (!match) return null;
    const suffix = (match[2] || "").toUpperCase();
    const mult = suffix === "K" ? 1000 : suffix === "M" ? 1000000 : suffix === "B" ? 1000000000 : 1;
    return Math.round(Number(match[1]) * mult);
  };
  const shortcode = location.pathname.split("/").filter(Boolean).pop() || "";
  const html = document.documentElement.innerHTML || "";
  const mediaIndex = shortcode ? html.indexOf('"code":"' + shortcode + '"') : -1;
  const mediaBlob = mediaIndex >= 0 ? html.slice(Math.max(0, mediaIndex - 1000), mediaIndex + 12000) : "";
  const jsonNumber = (key) => {
    const match = mediaBlob.match(new RegExp('"' + key + '"\\\\s*:\\\\s*(null|[0-9]+)', "i"));
    return match ? parseNumber(match[1]) : null;
  };
  const jsonString = (key) => {
    const match = mediaBlob.match(new RegExp('"' + key + '"\\\\s*:\\\\s*"([\\\\s\\\\S]*?)"', "i"));
    return match ? match[1].replace(/\\\\n/g, "\\n").replace(/\\\\u0026/g, "&") : null;
  };
  const meta = (selector) => document.querySelector(selector)?.getAttribute("content") || "";
  const usefulImageSrc = (img) => {
    const src = img?.src || "";
    const alt = img?.alt || "";
    if (!src) return null;
    if (/profile picture|^user avatar$/i.test(alt)) return null;
    if(/\\/t51\\.[0-9-]+-19\\//i.test(src) || /profile_images|profile-displayphoto|_normal\\./i.test(src)) return null;
    return src;
  };
  const description = meta('meta[name="description"]') || meta('meta[property="og:description"]') || "";
  const text = document.body?.innerText || "";
  const metricText = description || text;
  const likes = jsonNumber("like_count") ?? parseNumber((metricText.match(/([0-9,.]+\\s*[KMB]?)\\s+likes?/i) || [])[1]);
  const comments = jsonNumber("comment_count") ?? parseNumber((metricText.match(/([0-9,.]+\\s*[KMB]?)\\s+comments?/i) || [])[1]);
  const views =
    jsonNumber("view_count") ??
    jsonNumber("play_count") ??
    jsonNumber("video_view_count") ??
    parseNumber((metricText.match(/([0-9,.]+\\s*[KMB]?)\\s+views?/i) || [])[1]);
  const dateLabel = (description.match(/\\bon\\s+([^:]+):\\s*"/i) || [])[1] || null;
  const takenAt = jsonNumber("taken_at");
  const caption =
    jsonString("text") ||
    (description.match(/:\\s*"([\\s\\S]*?)"\\.?\\s*$/) || [])[1] ||
    Array.from(document.querySelectorAll('img[alt]')).map((img) => img.alt).find((alt) => alt && !/profile picture|^user avatar$/i.test(alt)) ||
    "";
  const mediaUrls = [
    meta('meta[property="og:image"]'),
    meta('meta[name="twitter:image"]'),
    ...Array.from(document.querySelectorAll("img[src]")).map(usefulImageSrc)
  ].filter(Boolean);
  return {
    url: location.href,
    description,
    text: text.slice(0, 3000),
    caption,
    dateLabel: takenAt ? new Date(takenAt * 1000).toISOString() : dateLabel,
    likes,
    comments,
    views,
    mediaUrls: Array.from(new Set(mediaUrls)).slice(0, 4)
  };
})()`;
}

function xTimelineExtractJs() {
  return `(() => {
  const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const parseNumber = (value) => {
    const match = String(value || "").replace(/,/g, "").match(/([0-9]+(?:\\.[0-9]+)?)\\s*([KMB])?/i);
    if (!match) return null;
    const suffix = (match[2] || "").toUpperCase();
    const mult = suffix === "K" ? 1000 : suffix === "M" ? 1000000 : suffix === "B" ? 1000000000 : 1;
    return Math.round(Number(match[1]) * mult);
  };
  const metricFromLabels = (labels, word) => {
    for (const label of labels) {
      const match = label.match(new RegExp("([0-9,.]+\\\\s*[KMB]?)\\\\s+" + word, "i"));
      if (match) return parseNumber(match[1]);
    }
    return null;
  };
  const metricFallbackFromLines = (lines, metricIndex) => {
    const compact = lines
      .filter((line) => /^[0-9,.]+\\s*[KMB]?$/i.test(line))
      .map(parseNumber)
      .filter((value) => value !== null);
    if (compact.length < 4) return null;
    return compact.slice(-4)[metricIndex] ?? null;
  };
  const bodyFromLines = (lines, handle) => {
    const marker = lines.findIndex((line) => line === "·");
    const start = marker >= 0 ? marker + 2 : Math.min(lines.findIndex((line) => /^@/.test(line)) + 3, lines.length);
    const content = [];
    for (const line of lines.slice(Math.max(0, start))) {
      if (/^\\d+[,.]?[0-9]*\\s*[KMB]?$/.test(line)) break;
      if (/^\\d+:\\d{2}$/.test(line)) continue;
      if (/^Show this thread$/i.test(line)) continue;
      content.push(line);
    }
    return content.join("\\n").trim();
  };
  const seen = new Set();
  return Array.from(document.querySelectorAll("article"))
    .map((article, index) => {
      const labels = Array.from(article.querySelectorAll("[aria-label]"))
        .map((node) => node.getAttribute("aria-label") || "")
        .filter(Boolean);
      const links = Array.from(article.querySelectorAll("a"))
        .map((anchor) => anchor.href)
        .filter((href) => /\\/status\\/\\d+/.test(href || ""));
      const statusUrl = links.find((href) => !/\\/analytics$|\\/photo\\//.test(href)) || links[0] || null;
      if (!statusUrl) return null;
      const url = new URL(statusUrl);
      const match = url.pathname.match(/\\/([^/]+)\\/status\\/(\\d+)/);
      if (!match) return null;
      const id = match[2];
      if (seen.has(id)) return null;
      seen.add(id);

      const rawText = article.innerText || "";
      const lines = rawText.split(/\\n+/).map((line) => line.trim()).filter(Boolean);
      const authorHandle = match[1];
      const isRetweet = /reposted$/i.test(lines[0] || "") || /\\breposted\\b/i.test(lines.slice(0, 2).join(" "));
      const author = lines.find((line) => /^@/.test(line))?.replace(/^@/, "") || authorHandle;
      const dateLabel = labels.find((label) => /\\b(?:ago|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\\d+h|\\d+m|\\d+d)\\b/i.test(label));
      return {
        id,
        author: authorHandle,
        name: lines[0] || authorHandle,
        text: bodyFromLines(lines, author),
        rawText,
        likes: metricFromLabels(labels, "likes?") ?? metricFallbackFromLines(lines, 2),
        retweets: metricFromLabels(labels, "reposts?|retweets?") ?? metricFallbackFromLines(lines, 1),
        replies: metricFromLabels(labels, "replies?") ?? metricFallbackFromLines(lines, 0),
        views: metricFromLabels(labels, "views?") ?? metricFallbackFromLines(lines, 3),
        is_retweet: isRetweet,
        created_at: dateLabel || lines.find((line) => /^\\d+[mhd]$|^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\b/i.test(line)) || null,
        url: "https://x.com/" + authorHandle + "/status/" + id,
        has_media: /Embedded video|Image|Play Video/i.test(labels.join(" ")),
        media_urls: Array.from(article.querySelectorAll("img[src]")).map((img) => img.src).filter((src) => /twimg\\.com/i.test(src)).slice(0, 4)
      };
    })
    .filter((tweet) => tweet && clean(tweet.text).length > 0)
    .slice(0, 40);
})()`;
}

function linkedInExtractJs() {
  return `(() => {
  const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const parseNumber = (value) => {
    const match = String(value || "").replace(/,/g, "").match(/([0-9]+(?:\\.[0-9]+)?)\\s*([KMB])?/i);
    if (!match) return null;
    const suffix = (match[2] || "").toUpperCase();
    const mult = suffix === "K" ? 1000 : suffix === "M" ? 1000000 : suffix === "B" ? 1000000000 : 1;
    return Math.round(Number(match[1]) * mult);
  };
  const absolute = (href) => {
    if (!href) return null;
    try { return new URL(href, location.origin).toString(); } catch { return href || null; }
  };
  const metricFrom = (card, word) => {
    const buttons = Array.from(card.querySelectorAll("button[aria-label], a[aria-label]"));
    for (const button of buttons) {
      const label = button.getAttribute("aria-label") || "";
      if (new RegExp(word, "i").test(label)) return parseNumber(label);
    }
    const text = card.innerText || "";
    const match = text.match(new RegExp("([0-9,.]+\\\\s*[KMB]?)\\\\s+" + word, "i"));
    return match ? parseNumber(match[1]) : null;
  };
  const bodyFrom = (text) => {
    const lines = String(text || "")
      .split(/\\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^(Feed post number|Loaded \\d+|Follow|Like|Comment|Repost|Send|Open reactions menu)$/i.test(line))
      .filter((line) => !/^\\d+[wdhmy]\\s*•?$/.test(line))
      .filter((line) => !/^(\\d+[,.]?[0-9]*\\s*)?(reactions?|comments?|reposts?)$/i.test(line))
      .filter((line) => !/Visible to anyone on or off LinkedIn/i.test(line));
    const timeIndex = lines.findIndex((line) => /ago\\s*•|ago$|Edited\\s*•/i.test(line));
    const content = lines.slice(Math.max(0, timeIndex + 1)).join("\\n").trim() || lines.slice(3).join("\\n").trim();
    return content.replace(/\\n{3,}/g, "\\n\\n").slice(0, 4000);
  };
  const bestBodyFromCard = (card, rawText) => {
    const selector = [
      ".update-components-text",
      ".feed-shared-update-v2__description",
      ".feed-shared-inline-show-more-text",
      ".update-components-update-v2__commentary",
      "[data-test-id='main-feed-activity-card__commentary']"
    ].join(",");
    const candidates = Array.from(card.querySelectorAll(selector))
      .map((node) => clean(node.innerText))
      .filter((value) => value.length > 24)
      .filter((value) => !/^(Feed post number|Premium|Verified|Builder|Follow)$/i.test(value));
    const best = candidates.sort((a, b) => b.length - a.length)[0];
    return best || bodyFrom(rawText);
  };
  const exactCards = Array.from(document.querySelectorAll(".scaffold-finite-scroll__content > ul > li, ul.display-flex.flex-wrap.list-style-none.justify-center > li"))
    .filter((card) => /Feed post number|Visible to anyone|reactions?|comments?|reposts?/i.test(card.innerText || ""));
  const linkCards = Array.from(document.querySelectorAll("a[href*='/feed/update/urn:li:activity:']"))
    .map((link) => {
      let card = link.closest("li") || link.closest("article") || link.closest(".relative.artdeco-card") || link.parentElement;
      for (let depth = 0; depth < 4 && card && !/reactions?|comments?|reposts?|Feed post number/i.test(card.innerText || ""); depth += 1) {
        card = card.parentElement;
      }
      return { link, card };
    })
    .filter((item) => item.card);
  const metricCards = Array.from(document.querySelectorAll("li"))
    .filter((card) => /Feed post number|Visible to anyone|reactions?|comments?|reposts?/i.test(card.innerText || ""));
  const fallbackCards = [...new Set([...linkCards.map((item) => item.card), ...metricCards])]
    .filter((card) => clean(card.innerText).length > 80)
    .filter((card, index, list) => !list.some((other, otherIndex) => otherIndex !== index && other.contains(card) && clean(other.innerText).length < clean(card.innerText).length * 1.8))
    .slice(0, 40);
  const cards = (exactCards.length ? exactCards : fallbackCards).slice(0, 40);
  const seen = new Set();
  return cards.map((card, index) => {
    const links = Array.from(card.querySelectorAll("a[href*='/feed/update/urn:li:activity:']"));
    const updateUrl = absolute(links[0]?.getAttribute("href")) || null;
    const rawText = card.innerText || "";
    const body = bestBodyFromCard(card, rawText);
    const key = updateUrl || body.slice(0, 120) || String(index);
    if (seen.has(key)) return null;
    seen.add(key);
    return {
      rank: index + 1,
      url: updateUrl,
      body,
      rawText,
      reactions: metricFrom(card, "reactions?"),
      comments: metricFrom(card, "comments?"),
      reposts: metricFrom(card, "reposts?"),
      impressions: metricFrom(card, "impressions?"),
      mediaUrls: Array.from(card.querySelectorAll("img[src]")).map((img) => img.src).filter((src) => /media\\.licdn\\.com/i.test(src)).slice(0, 4)
    };
  }).filter((post) => post && clean(post.body).length > 20);
})()`;
}
