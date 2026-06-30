import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const execFileAsync = promisify(execFile);
const openCliMain = path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@jackwener", "opencli", "dist", "src", "main.js");
const evidenceFiles = [
  "src/lib/social/public-evidence-current.json",
  "src/lib/social/logged-in-evidence-current.json",
  "src/lib/social/targeted-evidence-current.json"
];

const args = parseArgs(process.argv.slice(2));
const write = !args.dryRun;
let cachedInstagramRows = 0;
let cachedXRows = 0;
let xOembedPreviewRows = 0;
let xEmbedScreenshotRows = 0;
let xValidatedRows = 0;
let xInvalidRows = 0;
let xEmbedBrowser = null;
let xEmbedPage = null;
const cacheFailures = [];

let totalRows = 0;
let updatedRows = 0;
let reachedMaxRows = false;
const summaries = [];

for (const relativePath of evidenceFiles) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    continue;
  }

  const snapshot = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  const evidence = Array.isArray(snapshot.evidence) ? snapshot.evidence : [];
  let fileUpdates = 0;
  let fileUpdatesSinceWrite = 0;

  for (const item of evidence) {
    if (Number.isFinite(args.maxRows) && totalRows >= args.maxRows) {
      reachedMaxRows = true;
      break;
    }

    if (!matchesFilters(item, args)) {
      continue;
    }

    if (args.missingOnly && item.thumbnailUrl && !args.force) {
      continue;
    }

    if (args.missingOnly && item.platform === "x" && !isXPostUrl(item.sourceUrl) && !item.platformPostId) {
      continue;
    }

    totalRows += 1;

    const resolved = await resolveThumbnailForItem(item, args);
    const patched = applyResolvedPatch(item, resolved);
    if (!resolved.thumbnailUrl && !patched) {
      continue;
    }

    if (resolved.thumbnailUrl && !args.force && item.thumbnailUrl === resolved.thumbnailUrl && !patched) {
      continue;
    }

    if (resolved.thumbnailUrl) {
      item.thumbnailUrl = resolved.thumbnailUrl;
      item.thumbnailSource = resolved.thumbnailSource ?? item.thumbnailSource;
      if (!item.mediaUrl && resolved.mediaUrl) {
        item.mediaUrl = resolved.mediaUrl;
      }
    }
    fileUpdates += 1;
    fileUpdatesSinceWrite += 1;
    updatedRows += 1;
    if (write && fileUpdatesSinceWrite >= args.checkpointRows) {
      await writeJsonWithRetries(absolutePath, snapshot);
      fileUpdatesSinceWrite = 0;
    }
    if (args.delayMs > 0) {
      await delay(args.delayMs);
    }
  }

  summaries.push({ file: relativePath, scanned: evidence.length, updated: fileUpdates });
  if (fileUpdatesSinceWrite > 0 && write) {
    await writeJsonWithRetries(absolutePath, snapshot);
  }

  if (reachedMaxRows) {
    break;
  }
}

await closeXEmbedBrowser();

console.log(
  JSON.stringify(
    {
      mode: write ? "write" : "dry-run",
      filters: {
        company: args.company ?? null,
        platform: args.platform ?? null,
        thumbnailSource: args.thumbnailSource ?? null,
        missingOnly: args.missingOnly,
        maxRows: Number.isFinite(args.maxRows) ? args.maxRows : null,
        checkpointRows: args.checkpointRows,
        force: args.force
      },
      totalRows,
      updatedRows,
      cachedInstagramRows,
      cachedXRows,
      xOembedPreviewRows,
      xEmbedScreenshotRows,
      xValidatedRows,
      xInvalidRows,
      cacheFailures: cacheFailures.slice(0, 20),
      files: summaries
    },
    null,
    2
  )
);

function parseArgs(argv) {
  const parsed = {
    dryRun: false,
    force: false,
    cacheInstagram: false,
    cacheX: false,
    validateX: false,
    missingOnly: false,
    maxRows: Number.POSITIVE_INFINITY,
    checkpointRows: 25,
    limit: Number.POSITIVE_INFINITY,
    delayMs: 0,
    timeoutMs: 90_000
  };
  for (const arg of argv) {
    if (arg === "--dry-run") parsed.dryRun = true;
    if (arg === "--force") parsed.force = true;
    if (arg === "--cache-instagram") parsed.cacheInstagram = true;
    if (arg === "--cache-x") parsed.cacheX = true;
    if (arg === "--validate-x") parsed.validateX = true;
    if (arg === "--missing-only") parsed.missingOnly = true;
    if (arg.startsWith("--company=")) parsed.company = arg.slice("--company=".length).toLowerCase();
    if (arg.startsWith("--platform=")) parsed.platform = arg.slice("--platform=".length).toLowerCase();
    if (arg.startsWith("--url=")) parsed.url = arg.slice("--url=".length).toLowerCase();
    if (arg.startsWith("--id=")) parsed.id = arg.slice("--id=".length).toLowerCase();
    if (arg.startsWith("--thumbnail-source=")) {
      parsed.thumbnailSource = arg.slice("--thumbnail-source=".length).toLowerCase();
    }
    if (arg.startsWith("--limit=")) parsed.limit = Number(arg.slice("--limit=".length)) || parsed.limit;
    if (arg.startsWith("--max-rows=")) parsed.maxRows = Number(arg.slice("--max-rows=".length)) || parsed.maxRows;
    if (arg.startsWith("--checkpoint-rows=")) parsed.checkpointRows = Number(arg.slice("--checkpoint-rows=".length)) || parsed.checkpointRows;
    if (arg.startsWith("--timeout-ms=")) parsed.timeoutMs = Number(arg.slice("--timeout-ms=".length)) || parsed.timeoutMs;
    if (arg.startsWith("--delay-ms=")) parsed.delayMs = Number(arg.slice("--delay-ms=".length)) || parsed.delayMs;
    if (arg.startsWith("--session=")) parsed.session = arg.slice("--session=".length);
  }
  return parsed;
}

function matchesFilters(item, args) {
  if (args.platform && String(item.platform).toLowerCase() !== args.platform) {
    return false;
  }

  if (args.url && String(item.sourceUrl || "").toLowerCase() !== args.url) {
    return false;
  }

  if (args.id && String(item.id || "").toLowerCase() !== args.id) {
    return false;
  }

  if (args.thumbnailSource && String(item.thumbnailSource || "").toLowerCase() !== args.thumbnailSource) {
    return false;
  }

  if (!args.company) {
    return true;
  }

  return [item.companyName, item.attachedCompanyName, item.entityName, item.title, item.text]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(args.company));
}

async function resolveThumbnailForItem(item, args) {
  if (args.cacheInstagram && item.platform === "instagram") {
    return resolveOrCacheInstagramThumbnail(item, args);
  }

  if ((args.cacheX || args.validateX) && item.platform === "x") {
    return resolveOrCacheXThumbnail(item, args);
  }

  return resolveThumbnail(item);
}

function applyResolvedPatch(item, resolved) {
  if (!resolved.patch) {
    return false;
  }

  let changed = false;
  for (const [key, value] of Object.entries(resolved.patch)) {
    if (item[key] !== value) {
      item[key] = value;
      changed = true;
    }
  }
  return changed;
}

function resolveThumbnail(item) {
  const explicit = sanitizeUrl(item.thumbnailUrl);
  if (explicit) {
    return { thumbnailUrl: explicit, thumbnailSource: item.thumbnailSource ?? "stored", mediaUrl: explicit };
  }

  if (item.platform === "youtube") {
    const youtube = youtubeThumbnailFromUrl(item.sourceUrl) ?? youtubeThumbnailFromRaw(item.rawVisibleText);
    if (youtube) return { thumbnailUrl: youtube, thumbnailSource: "youtube", mediaUrl: item.sourceUrl };
  }

  if (item.platform === "github") {
    const github = githubThumbnailFromUrl(item.sourceUrl, item.id, item.authorHandle);
    if (github) return { thumbnailUrl: github, thumbnailSource: "github", mediaUrl: item.sourceUrl };
  }

  const mediaUrls = [
    ...(Array.isArray(item.mediaUrls) ? item.mediaUrls : []),
    ...(Array.isArray(item.media_posters) ? item.media_posters : []),
    ...(Array.isArray(item.media_urls) ? item.media_urls : []),
    ...thumbnailCandidatesFromRaw(item.rawVisibleText)
  ];
  const selected = choosePlatformThumbnail(item.platform, mediaUrls);
  return {
    thumbnailUrl: selected,
    thumbnailSource: selected ? `${item.platform}-media` : null,
    mediaUrl: selected
  };
}

async function resolveOrCacheInstagramThumbnail(item, args) {
  const existing = localCachedThumbnail(item);
  if (existing && !args.force) {
    return { thumbnailUrl: existing.publicUrl, thumbnailSource: "local-cache", mediaUrl: existing.publicUrl };
  }

  if (cachedInstagramRows < args.limit && isInstagramPostUrl(item.sourceUrl)) {
    const cached = await cacheInstagramScreenshot(item, args);
    if (cached) {
      cachedInstagramRows += 1;
      return { thumbnailUrl: cached.publicUrl, thumbnailSource: "opencli-screenshot", mediaUrl: cached.publicUrl };
    }
  }

  if (args.cacheInstagram) {
    return { thumbnailUrl: null, thumbnailSource: null, mediaUrl: null };
  }

  return resolveThumbnail(item);
}

async function resolveOrCacheXThumbnail(item, args) {
  const existing = localCachedThumbnail(item);
  if (existing && !args.force) {
    const validation = args.validateX ? await validateXEvidenceLink(item) : null;
    return {
      thumbnailUrl: existing.publicUrl,
      thumbnailSource: "local-cache",
      mediaUrl: existing.publicUrl,
      patch: validation?.patch ?? null
    };
  }

  const resolved = resolveThumbnail(item);
  const validation = args.validateX ? await validateXEvidenceLink(item) : null;
  if (validation?.invalid) {
    return {
      thumbnailUrl: null,
      thumbnailSource: null,
      mediaUrl: null,
      patch: validation.patch
    };
  }

  if (resolved.thumbnailUrl && !args.force) {
    return { ...resolved, patch: validation?.patch ?? null };
  }

  const embedScreenshot = await cacheXEmbedScreenshot(item, validation, args);
  if (embedScreenshot) {
    xEmbedScreenshotRows += 1;
    return {
      thumbnailUrl: embedScreenshot.publicUrl,
      thumbnailSource: "x-embed-screenshot",
      mediaUrl: embedScreenshot.publicUrl,
      patch: validation?.patch ?? null
    };
  }

  const oembedPreview = await cacheXOembedPreview(item, validation, args);
  if (oembedPreview) {
    xOembedPreviewRows += 1;
    return {
      thumbnailUrl: oembedPreview.publicUrl,
      thumbnailSource: "x-oembed-preview",
      mediaUrl: oembedPreview.publicUrl,
      patch: validation?.patch ?? null
    };
  }

  if (args.cacheX && cachedXRows < args.limit && isXPostUrl(item.sourceUrl)) {
    const cached = await cacheXPostScreenshot(item, args);
    if (cached) {
      cachedXRows += 1;
      return {
        thumbnailUrl: cached.publicUrl,
        thumbnailSource: "opencli-x-screenshot",
        mediaUrl: cached.publicUrl,
        patch: validation?.patch ?? null
      };
    }
  }

  return { ...resolved, patch: validation?.patch ?? null };
}

function localCachedThumbnail(item) {
  for (const extension of ["png", "svg"]) {
    const output = localThumbnailPaths(item, extension);
    if (fs.existsSync(output.absolutePath)) {
      return output;
    }
  }
  return null;
}

async function cacheInstagramScreenshot(item, args) {
  if (!fs.existsSync(openCliMain)) {
    cacheFailures.push({ id: item.id, reason: "OpenCLI is not installed at the expected path." });
    return null;
  }

  const output = localThumbnailPaths(item);
  if (!write) {
    return output;
  }

  fs.mkdirSync(path.dirname(output.absolutePath), { recursive: true });
  const session = args.session || `yc-thumb-${process.pid}`;

  try {
    const shortcode = instagramShortcodeFromUrl(item.sourceUrl);
    const profileUrl = instagramProfileUrlForItem(item);
    const staged =
      profileUrl && shortcode
        ? await stageInstagramGridCover(session, profileUrl, shortcode, args)
        : await stageInstagramPostCover(session, item.sourceUrl, args);
    if (!/"ok"\s*:\s*true/.test(staged)) {
      const fallback = await stageInstagramPostCover(session, item.sourceUrl, args);
      if (!/"ok"\s*:\s*true/.test(fallback)) {
        cacheFailures.push({ id: item.id, reason: "No exact visible Instagram cover could be staged." });
        return null;
      }
    }

    const verified = await runOpenCli(["browser", session, "eval", instagramStagedCoverStatusJs()], 15_000).catch(() => "");
    if (!/"ok"\s*:\s*true/.test(verified)) {
      cacheFailures.push({ id: item.id, reason: "Instagram cover staging verification failed." });
      return null;
    }

    await runOpenCli(["browser", session, "screenshot", "--width", "640", "--height", "640", output.absolutePath], args.timeoutMs);
    if (!fs.existsSync(output.absolutePath) || fs.statSync(output.absolutePath).size < 5000) {
      cacheFailures.push({ id: item.id, reason: "Screenshot file was missing or too small." });
      return null;
    }
    return output;
  } catch (error) {
    cacheFailures.push({ id: item.id, reason: String(error.message || error).slice(0, 240) });
    return null;
  }
}

async function cacheXPostScreenshot(item, args) {
  if (!fs.existsSync(openCliMain)) {
    cacheFailures.push({ id: item.id, reason: "OpenCLI is not installed at the expected path." });
    return null;
  }

  const output = localThumbnailPaths(item);
  if (!write) {
    return output;
  }

  fs.mkdirSync(path.dirname(output.absolutePath), { recursive: true });
  const session = args.session || `yc-thumb-x-${process.pid}`;

  try {
    await runOpenCli(["browser", session, "open", item.sourceUrl], args.timeoutMs);
    await runOpenCli(["browser", session, "wait", "time", "5"], 20_000).catch(() => null);
    const statusId = xStatusIdFromUrl(item.sourceUrl);
    const staged = await runOpenCli(
      ["browser", session, "eval", xPostCoverStageJs(statusId, item)],
      args.timeoutMs
    ).catch((error) => {
      cacheFailures.push({ id: item.id, reason: `X stage failed: ${error.message}` });
      return "";
    });
    if (!/"ok"\s*:\s*true/.test(staged)) {
      cacheFailures.push({ id: item.id, reason: "No visible X media or tweet card could be staged." });
      return null;
    }

    const verified = await runOpenCli(["browser", session, "eval", stagedCoverStatusJs()], 15_000).catch(() => "");
    if (!/"ok"\s*:\s*true/.test(verified)) {
      cacheFailures.push({ id: item.id, reason: "X cover staging verification failed." });
      return null;
    }

    await runOpenCli(["browser", session, "screenshot", "--width", "960", "--height", "540", output.absolutePath], args.timeoutMs);
    if (!fs.existsSync(output.absolutePath) || fs.statSync(output.absolutePath).size < 5000) {
      cacheFailures.push({ id: item.id, reason: "X screenshot file was missing or too small." });
      return null;
    }
    return output;
  } catch (error) {
    cacheFailures.push({ id: item.id, reason: String(error.message || error).slice(0, 240) });
    return null;
  }
}

async function stageInstagramGridCover(session, profileUrl, shortcode, args) {
  await runOpenCli(["browser", session, "open", profileUrl], args.timeoutMs);
  await runOpenCli(["browser", session, "wait", "time", "4"], 15_000).catch(() => null);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const staged = await runOpenCli(["browser", session, "eval", instagramGridCoverStageJs(shortcode)], args.timeoutMs).catch(
      () => ""
    );
    if (/"ok"\s*:\s*true/.test(staged)) {
      return staged;
    }
    await runOpenCli(["browser", session, "eval", "window.scrollBy(0, Math.round(window.innerHeight * 0.9)); true;"], 15_000).catch(
      () => null
    );
    await runOpenCli(["browser", session, "wait", "time", "1"], 10_000).catch(() => null);
  }

  return "";
}

async function stageInstagramPostCover(session, sourceUrl, args) {
  await runOpenCli(["browser", session, "open", sourceUrl], args.timeoutMs);
  await runOpenCli(["browser", session, "wait", "time", "4"], 15_000).catch(() => null);
  return runOpenCli(["browser", session, "eval", instagramCoverStageJs()], args.timeoutMs).catch(() => "");
}

async function runOpenCli(args, timeoutMs) {
  const result = await execFileAsync(process.execPath, [openCliMain, ...args], {
    cwd: repoRoot,
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true
  });
  return result.stdout;
}

function localThumbnailPaths(item, extension = "png") {
  const platform = String(item.platform || "unknown").replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
  const filename = `${stableId(item.id || item.sourceUrl)}.${extension}`;
  const relativePath = path.join("evidence-thumbnails", platform, filename).replace(/\\/g, "/");
  return {
    absolutePath: path.join(repoRoot, "public", relativePath),
    publicUrl: `/${relativePath}`
  };
}

async function validateXEvidenceLink(item) {
  const statusId = item.platformPostId || xStatusIdFromUrl(item.sourceUrl);
  const postUrl = normalizedXPostUrl(item.sourceUrl, statusId);
  if (!postUrl) {
    return {
      invalid: false,
      patch: xLinkPatch("unchecked", "Skipped X profile or non-post URL during post validation.", sanitizeUrl(item.sourceUrl))
    };
  }

  const result = await fetchXOembed(postUrl);
  xValidatedRows += 1;
  if (result.ok) {
    return {
      invalid: false,
      metadata: result.metadata,
      patch: xLinkPatch("verified", null, result.metadata.canonicalUrl ?? postUrl)
    };
  }

  if (result.invalid) {
    xInvalidRows += 1;
    return {
      invalid: true,
      patch: xLinkPatch("invalid", result.reason, postUrl, { review_state: "rejected", contributionScore: 0 })
    };
  }

  return {
    invalid: false,
    patch: xLinkPatch("blocked", result.reason, postUrl)
  };
}

async function cacheXOembedPreview(item, validation, args) {
  if (!isXPostUrl(item.sourceUrl) && !item.platformPostId) {
    return null;
  }

  if (!write) {
    return localThumbnailPaths(item, "svg");
  }

  const metadata = validation?.metadata ?? (await fetchXOembed(normalizedXPostUrl(item.sourceUrl, item.platformPostId))).metadata;
  if (!metadata?.text && !item.text && !item.title) {
    return null;
  }

  const output = localThumbnailPaths(item, "svg");
  fs.mkdirSync(path.dirname(output.absolutePath), { recursive: true });
  fs.writeFileSync(output.absolutePath, renderXPreviewSvg(item, metadata), "utf8");
  if (!fs.existsSync(output.absolutePath) || fs.statSync(output.absolutePath).size < 1000) {
    cacheFailures.push({ id: item.id, reason: "X oEmbed preview file was missing or too small." });
    return null;
  }
  return output;
}

async function cacheXEmbedScreenshot(item, validation, args) {
  const metadata =
    validation?.metadata ?? (await fetchXOembed(normalizedXPostUrl(item.sourceUrl, item.platformPostId))).metadata;
  if (!metadata?.html) {
    return null;
  }

  const output = localThumbnailPaths(item, "png");
  if (!write) {
    return output;
  }

  try {
    const page = await getXEmbedPage();
    await page.setViewportSize({ width: 760, height: 520 });
    await page.setContent(renderXEmbedScreenshotHtml(metadata.html), { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(document.querySelector("iframe[id^='twitter-widget-']")), null, {
      timeout: Math.min(args.timeoutMs, 6_000)
    }).catch(() => null);
    await page.waitForTimeout(900);

    fs.mkdirSync(path.dirname(output.absolutePath), { recursive: true });
    const target = await firstVisibleScreenshotTarget(page);
    if (!target?.element) {
      cacheFailures.push({ id: item.id, reason: "X embed screenshot had no render target." });
      return null;
    }

    const box = target.box;
    if (box && box.width >= 1 && box.height >= 1) {
      await page.screenshot({
        path: output.absolutePath,
        animations: "disabled",
        timeout: Math.min(args.timeoutMs, 8_000),
        clip: {
          x: Math.max(0, box.x),
          y: Math.max(0, box.y),
          width: Math.min(760, box.width),
          height: Math.min(520, box.height)
        }
      });
    } else {
      await page.screenshot({
        path: output.absolutePath,
        animations: "disabled",
        timeout: Math.min(args.timeoutMs, 8_000)
      });
    }
    if (!fs.existsSync(output.absolutePath) || fs.statSync(output.absolutePath).size < 5000) {
      cacheFailures.push({ id: item.id, reason: "X embed screenshot file was missing or too small." });
      return null;
    }
    return output;
  } catch (error) {
    cacheFailures.push({ id: item.id, reason: `X embed screenshot failed: ${String(error.message || error).slice(0, 180)}` });
    return null;
  }
}

async function firstVisibleScreenshotTarget(page) {
  const selectors = ["iframe[id^='twitter-widget-']", ".tweet-shell", "body"];
  for (const selector of selectors) {
    const element = await page.$(selector);
    if (!element) {
      continue;
    }
    const box = await element.boundingBox();
    if (box && box.width >= 1 && box.height >= 1) {
      return { element, box };
    }
  }
  const element = await page.$("body");
  return element ? { element, box: await element.boundingBox() } : null;
}

async function getXEmbedPage() {
  if (xEmbedPage) {
    return xEmbedPage;
  }

  const { chromium } = await import("playwright");
  xEmbedBrowser = await chromium.launch({ headless: true });
  xEmbedPage = await xEmbedBrowser.newPage({
    viewport: { width: 760, height: 520 },
    deviceScaleFactor: 1
  });
  return xEmbedPage;
}

async function closeXEmbedBrowser() {
  if (!xEmbedBrowser) {
    return;
  }
  await xEmbedBrowser.close().catch(() => null);
  xEmbedBrowser = null;
  xEmbedPage = null;
}

async function fetchXOembed(postUrl) {
  if (!postUrl) {
    return { ok: false, invalid: true, reason: "Missing X post URL.", metadata: null };
  }

  const endpoint = `https://publish.twitter.com/oembed?omit_script=true&dnt=true&url=${encodeURIComponent(postUrl)}`;
  try {
    const response = await fetch(endpoint, {
      headers: {
        "accept": "application/json",
        "user-agent": "YCNetworkMap/1.0 public-link-validator"
      }
    });
    if (!response.ok) {
      return {
        ok: false,
        invalid: response.status === 404 || response.status === 400,
        reason: `X oEmbed returned HTTP ${response.status}.`,
        metadata: null
      };
    }
    const payload = await response.json();
    return {
      ok: true,
      invalid: false,
      reason: null,
      metadata: {
        canonicalUrl: sanitizeUrl(payload.url) ?? postUrl,
        authorName: htmlDecode(payload.author_name || ""),
        authorUrl: sanitizeUrl(payload.author_url),
        authorHandle: xHandleFromUrl(payload.author_url) ?? xHandleFromUrl(postUrl),
        text: tweetTextFromOembedHtml(payload.html),
        dateLabel: tweetDateFromOembedHtml(payload.html),
        html: String(payload.html || "")
      }
    };
  } catch (error) {
    return {
      ok: false,
      invalid: false,
      reason: `X oEmbed check failed: ${String(error.message || error).slice(0, 160)}`,
      metadata: null
    };
  }
}

function xLinkPatch(status, reason, canonicalUrl, extra = {}) {
  return {
    linkStatus: status,
    linkCheckedAt: new Date().toISOString(),
    linkFailureReason: reason,
    ...(canonicalUrl ? { sourceUrl: canonicalUrl } : {}),
    ...extra
  };
}

function renderXEmbedScreenshotHtml(oembedHtml) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      html,
      body {
        margin: 0;
        min-width: 760px;
        min-height: 520px;
        background: #fff6ef;
        font-family: Arial, sans-serif;
      }

      body {
        display: grid;
        place-items: center;
        overflow: hidden;
      }

      .tweet-shell {
        display: grid;
        place-items: center;
        width: 720px;
        min-height: 480px;
        padding: 18px;
        box-sizing: border-box;
        background: #fff6ef;
      }

      .twitter-tweet,
      iframe[id^="twitter-widget-"] {
        max-width: 680px !important;
      }
    </style>
  </head>
  <body>
    <main class="tweet-shell">
      ${oembedHtml}
    </main>
    <script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>
  </body>
</html>`;
}

function normalizedXPostUrl(rawUrl, statusId) {
  try {
    const url = new URL(rawUrl);
    const id = statusId || url.pathname.match(/\/status\/(\d+)/i)?.[1];
    if (!id) return null;
    const handle = url.pathname.match(/^\/([^/]+)\/status\//i)?.[1];
    return handle && !/^i$/i.test(handle) ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/status/${id}`;
  } catch {
    return statusId ? `https://x.com/i/status/${statusId}` : null;
  }
}

function xHandleFromUrl(rawUrl) {
  try {
    const match = new URL(rawUrl).pathname.match(/^\/([^/]+)(?:\/status\/\d+)?/i);
    const handle = match?.[1] ?? null;
    return handle && !/^i$/i.test(handle) ? handle.replace(/^@/, "") : null;
  } catch {
    return null;
  }
}

function tweetTextFromOembedHtml(html) {
  const paragraph = String(html || "").match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "";
  return htmlDecode(stripTags(paragraph)).replace(/\s+/g, " ").trim();
}

function tweetDateFromOembedHtml(html) {
  const links = [...String(html || "").matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)];
  return htmlDecode(stripTags(links.at(-1)?.[1] ?? "")).replace(/\s+/g, " ").trim();
}

function stripTags(value) {
  return String(value).replace(/<[^>]*>/g, "");
}

function htmlDecode(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, "-")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)));
}

function renderXPreviewSvg(item, metadata = {}) {
  metadata = metadata ?? {};
  const authorName = metadata.authorName || item.authorName || item.title || "X post";
  const handle = metadata.authorHandle || item.authorHandle || authorHandleFromRaw(item.rawVisibleText) || "x";
  const text = metadata.text || item.text || item.title || "X post";
  const date = metadata.dateLabel || xDateFromRaw(item.rawVisibleText) || "";
  const metrics = compactMetricText(item.metrics || {});
  const textLines = wrapText(text, 70, 7);
  const titleLines = wrapText(authorName, 42, 1);
  const tspans = textLines
    .map((line, index) => `<tspan x="92" y="${178 + index * 38}">${escapeXml(line)}</tspan>`)
    .join("");
  const metricLine = metrics ? `<text x="92" y="476" class="metrics">${escapeXml(metrics)}</text>` : "";
  const dateLine = date ? `<text x="92" y="113" class="date">${escapeXml(date)}</text>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540" role="img" aria-label="X post preview">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#fffaf6"/>
      <stop offset="1" stop-color="#eef5fb"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%">
      <feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#7c2d12" flood-opacity=".16"/>
    </filter>
    <style>
      .label { font-family: Inter, Arial, sans-serif; fill:#111827; }
      .author { font: 800 34px Inter, Arial, sans-serif; fill:#111827; }
      .handle { font: 700 24px Inter, Arial, sans-serif; fill:#536471; }
      .date { font: 700 22px Inter, Arial, sans-serif; fill:#536471; }
      .body { font: 700 29px Inter, Arial, sans-serif; fill:#111827; }
      .metrics { font: 800 24px Inter, Arial, sans-serif; fill:#ff6600; }
    </style>
  </defs>
  <rect width="960" height="540" fill="url(#bg)"/>
  <rect x="42" y="42" width="876" height="456" rx="28" fill="#ffffff" filter="url(#shadow)"/>
  <rect x="72" y="72" width="54" height="54" rx="14" fill="#111827"/>
  <text x="99" y="110" text-anchor="middle" font-family="Arial, sans-serif" font-size="31" font-weight="900" fill="#ffffff">X</text>
  <text x="146" y="94" class="author">${escapeXml(titleLines[0] ?? "X post")}</text>
  <text x="146" y="128" class="handle">@${escapeXml(handle.replace(/^@/, ""))}</text>
  ${dateLine}
  <text class="body">${tspans}</text>
  ${metricLine}
  <text x="826" y="476" text-anchor="end" font-family="Arial, sans-serif" font-size="25" font-weight="900" fill="#111827">X</text>
</svg>`;
}

function authorHandleFromRaw(rawVisibleText) {
  try {
    return JSON.parse(rawVisibleText || "{}")?.author ?? null;
  } catch {
    return null;
  }
}

function xDateFromRaw(rawVisibleText) {
  try {
    return JSON.parse(rawVisibleText || "{}")?.created_at ?? "";
  } catch {
    return "";
  }
}

function wrapText(value, maxChars, maxLines) {
  const words = String(value || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/\s+$/, "").slice(0, Math.max(0, maxChars - 3))}...`;
  }
  return lines.length ? lines : ["X post"];
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function writeJsonWithRetries(absolutePath, value, attempts = 6) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.writeFileSync(absolutePath, payload);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
    }
  }
  throw lastError;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isInstagramPostUrl(url) {
  try {
    return /(^|\.)instagram\.com$/i.test(new URL(url).hostname) && /\/(?:p|reel|tv)\//i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function isXPostUrl(url) {
  try {
    const parsed = new URL(url);
    return /(^|\.)x\.com$|(^|\.)twitter\.com$/i.test(parsed.hostname) && /\/status\/\d+/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function xStatusIdFromUrl(url) {
  try {
    return new URL(url).pathname.match(/\/status\/(\d+)/i)?.[1] ?? null;
  } catch {
    return null;
  }
}

function instagramShortcodeFromUrl(url) {
  try {
    return new URL(url).pathname.match(/\/(?:p|reel|tv)\/([^/?#]+)/i)?.[1] ?? null;
  } catch {
    return null;
  }
}

function instagramProfileUrlForItem(item) {
  const raw = parseRawObject(item.rawVisibleText);
  const profileUrl = sanitizeUrl(raw?.profile?.url);
  if (profileUrl && /(^|\.)instagram\.com$/i.test(new URL(profileUrl).hostname)) {
    return normalizeInstagramProfileUrl(profileUrl);
  }

  const username =
    raw?.profile?.username ??
    item.authorHandle ??
    String(item.authorName || "").match(/^@?([A-Za-z0-9._]{2,30})$/)?.[1] ??
    null;
  return username ? `https://www.instagram.com/${String(username).replace(/^@/, "")}/` : null;
}

function normalizeInstagramProfileUrl(profileUrl) {
  const url = new URL(profileUrl);
  const username = url.pathname.split("/").filter(Boolean)[0];
  return username ? `https://www.instagram.com/${username}/` : null;
}

function parseRawObject(rawVisibleText) {
  try {
    return rawVisibleText ? JSON.parse(rawVisibleText) : null;
  } catch {
    return null;
  }
}

function xPostCoverStageJs(statusId, item) {
  const title = item.text || item.title || "X post";
  const author = item.authorHandle || item.authorName || "X";
  const metrics = compactMetricText(item.metrics || {}) || "Public X evidence";
  return `(() => {
  const statusId = ${JSON.stringify(statusId)};
  const reject = /profile_images|profile_banners|emoji\\/v2|abs\\.twimg\\.com|avatar|profile/i;
  const stageImage = ${stageImageHelperJs()};
  const stageElement = ${stageElementHelperJs()};
  const fallback = () => stageElement(document.querySelector("main") || document.body, { mode: "x-page-preview", statusId });
  const articles = Array.from(document.querySelectorAll("article"));
  const article = articles.find((candidate) => {
    if (!statusId) return false;
    return Array.from(candidate.querySelectorAll("a[href]")).some((link) => {
      try {
        return new URL(link.href, location.href).pathname.includes("/status/" + statusId);
      } catch {
        return false;
      }
    });
  }) || articles[0];
  if (!article) return fallback();

  const images = Array.from(article.querySelectorAll("img[src]"))
    .map((image) => {
      const rect = image.getBoundingClientRect();
      const src = image.currentSrc || image.src;
      const width = image.naturalWidth || rect.width || 0;
      const height = image.naturalHeight || rect.height || 0;
      return { image, src, width, height, area: width * height };
    })
    .filter((candidate) => candidate.src && candidate.width >= 160 && candidate.height >= 120 && !reject.test(candidate.src))
    .sort((a, b) => {
      const aPriority = /amplify_video_thumb|tweet_video_thumb|pbs\\.twimg\\.com\\/media|card_img/i.test(a.src) ? 1 : 0;
      const bPriority = /amplify_video_thumb|tweet_video_thumb|pbs\\.twimg\\.com\\/media|card_img/i.test(b.src) ? 1 : 0;
      return bPriority - aPriority || b.area - a.area;
    });
  if (images[0]) return stageImage(images[0].image, { mode: "x-image", statusId });

  const video = article.querySelector("video");
  if (video?.poster) {
    return stageImage({
      currentSrc: video.poster,
      src: video.poster,
      alt: "X video cover",
      naturalWidth: 960,
      naturalHeight: 540,
      getBoundingClientRect: () => ({ width: 960, height: 540 })
    }, { mode: "x-video-poster", statusId });
  }

  const mediaElement =
    article.querySelector('[data-testid="tweetPhoto"], [data-testid="videoPlayer"], [aria-label*="Image"], [aria-label*="Video"], [aria-label*="Embedded video"]') ||
    article;
  if (mediaElement) return stageElement(mediaElement, { mode: "x-tweet-card", statusId });
  return fallback();
})()`;
}

function compactMetricText(metrics) {
  const order = ["views", "likes", "comments", "reposts", "quotes", "replies"];
  return order
    .filter((key) => Number(metrics[key]) > 0)
    .slice(0, 4)
    .map((key) => `${formatCompactNumber(Number(metrics[key]))} ${key}`)
    .join(" / ");
}

function formatCompactNumber(value) {
  if (value >= 1_000_000) return `${round(value / 1_000_000, 1)}M`;
  if (value >= 1_000) return `${round(value / 1_000, 1)}K`;
  return String(Math.round(value));
}

function round(value, decimals = 0) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function stageImageHelperJs() {
  return `((image, meta = {}) => {
  const src = image.currentSrc || image.src;
  const rect = image.getBoundingClientRect();
  if (!src) return { ok: false, reason: "image has no src" };
  document.documentElement.style.background = "#fff6ef";
  document.body.innerHTML = "";
  document.body.style.margin = "0";
  document.body.style.background = "#fff6ef";
  const stage = document.createElement("main");
  stage.dataset.ycCoverStaged = "true";
  stage.style.cssText = "width:960px;height:540px;display:grid;place-items:center;background:#fff6ef;overflow:hidden;";
  const img = document.createElement("img");
  img.src = src;
  img.alt = image.alt || "";
  img.dataset.ycCoverImage = "true";
  img.style.cssText = "width:920px;height:500px;object-fit:cover;border-radius:22px;box-shadow:0 18px 48px rgba(15,23,42,.18);background:#eaf2fb;";
  stage.appendChild(img);
  document.body.appendChild(stage);
  return { ok: true, src, width: image.naturalWidth || rect.width || 0, height: image.naturalHeight || rect.height || 0, ...meta };
})`;
}

function stageElementHelperJs() {
  return `((element, meta = {}) => {
  document.documentElement.style.background = "#fff6ef";
  document.body.innerHTML = "";
  document.body.style.margin = "0";
  document.body.style.background = "#fff6ef";
  const stage = document.createElement("main");
  stage.dataset.ycCoverStaged = "true";
  stage.style.cssText = "width:960px;height:540px;display:grid;place-items:center;background:#fff6ef;overflow:hidden;padding:20px;";
  const shell = document.createElement("section");
  shell.dataset.ycCoverImage = "true";
  shell.style.cssText = "width:880px;max-height:500px;overflow:hidden;border-radius:22px;background:#fff;box-shadow:0 18px 48px rgba(15,23,42,.18);";
  shell.appendChild(element.cloneNode(true));
  stage.appendChild(shell);
  document.body.appendChild(stage);
  return { ok: true, mode: "element", ...meta };
})`;
}

function stagedCoverStatusJs() {
  return `(() => {
  const stage = document.querySelector("[data-yc-cover-staged='true']");
  const image = document.querySelector("[data-yc-cover-image='true']");
  return { ok: Boolean(stage && image), src: image?.getAttribute("src") || null };
})()`;
}

function instagramGridCoverStageJs(shortcode) {
  return `(() => {
  const shortcode = ${JSON.stringify(shortcode)};
  const anchors = Array.from(document.querySelectorAll("a[href]"))
    .filter((anchor) => {
      try {
        const path = new URL(anchor.href, location.href).pathname;
        return new RegExp("/(?:p|reel|tv)/" + shortcode + "(?:/|$)", "i").test(path);
      } catch {
        return false;
      }
    });
  const link = anchors[0];
  if (!link) return { ok: false, reason: "matching grid anchor not found", shortcode };
  const image = link.querySelector("img[src]");
  if (!image) return { ok: false, reason: "matching grid image not found", shortcode };
  return window.__ycStageInstagramCover ? window.__ycStageInstagramCover(image, { shortcode, mode: "profile-grid" }) : (${instagramStageHelperJs()})(image, { shortcode, mode: "profile-grid" });
})()`;
}

function instagramCoverStageJs() {
  return `(() => {
  const reject = /profile|avatar|s150x150|static|emoji|suggested|recommended/i;
  const stage = ${instagramStageHelperJs()};
  const candidates = Array.from(document.querySelectorAll("article img[src], main img[src], img[src]"))
    .map((image) => {
      const rect = image.getBoundingClientRect();
      const src = image.currentSrc || image.src;
      const alt = image.alt || "";
      const width = image.naturalWidth || rect.width || 0;
      const height = image.naturalHeight || rect.height || 0;
      const distanceFromCenter = Math.abs(rect.left + rect.width / 2 - window.innerWidth / 2) + Math.abs(rect.top + rect.height / 2 - window.innerHeight / 2);
      const inArticle = image.closest("article") ? 1 : 0;
      return { image, src, alt, width, height, area: width * height, distanceFromCenter, inArticle };
    })
    .filter((candidate) => candidate.src && candidate.width >= 180 && candidate.height >= 180 && !reject.test(candidate.src) && !reject.test(candidate.alt))
    .sort((a, b) => b.inArticle - a.inArticle || a.distanceFromCenter - b.distanceFromCenter || b.area - a.area);
  const chosen = candidates.find((candidate) => /t51\\.(?:71878|2885)-15|cdninstagram|fbcdn/i.test(candidate.src)) || candidates[0];
  if (!chosen) return { ok: false, reason: "no candidate images" };
  return stage(chosen.image, { mode: "post-page" });
})()`;
}

function instagramStageHelperJs() {
  return `((image, meta = {}) => {
  const src = image.currentSrc || image.src;
  const rect = image.getBoundingClientRect();
  if (!src) return { ok: false, reason: "image has no src" };
  document.documentElement.style.background = "#fff6ef";
  document.body.innerHTML = "";
  document.body.style.margin = "0";
  document.body.style.background = "#fff6ef";
  const stage = document.createElement("main");
  stage.dataset.ycCoverStaged = "true";
  stage.style.cssText = "width:640px;height:640px;display:grid;place-items:center;background:#fff6ef;overflow:hidden;";
  const img = document.createElement("img");
  img.src = src;
  img.alt = image.alt || "";
  img.dataset.ycCoverImage = "true";
  img.style.cssText = "width:600px;height:600px;object-fit:cover;border-radius:18px;box-shadow:0 18px 48px rgba(124,45,18,.18);background:#fff0e6;";
  stage.appendChild(img);
  document.body.appendChild(stage);
  return { ok: true, src, width: image.naturalWidth || rect.width || 0, height: image.naturalHeight || rect.height || 0, ...meta };
})`;
}

function instagramStagedCoverStatusJs() {
  return `(() => {
  const stage = document.querySelector("[data-yc-cover-staged='true']");
  const image = document.querySelector("img[data-yc-cover-image='true']");
  return { ok: Boolean(stage && image && image.getAttribute("src")), src: image?.getAttribute("src") || null };
})()`;
}

function thumbnailCandidatesFromRaw(rawVisibleText) {
  if (!rawVisibleText) return [];
  const candidates = [];
  try {
    collectUrls(JSON.parse(rawVisibleText), candidates);
  } catch {
    // Plain text rows are handled by regex below.
  }
  for (const match of rawVisibleText.matchAll(/!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/gi)) {
    candidates.push(match[1]);
  }
  for (const match of rawVisibleText.matchAll(/https?:\/\/[^\s"'()<>\\]+/gi)) {
    candidates.push(match[0]);
  }
  return cleanUrls(candidates);
}

function collectUrls(value, output, key = "") {
  if (!value) return;
  if (typeof value === "string") {
    if (/(thumbnail|poster|image|media|cover|og:image|twitter:image)/i.test(key) || isLikelyImage(value)) {
      output.push(value);
    }
    for (const match of value.matchAll(/https?:\/\/[^\s"'()<>\\]+/gi)) output.push(match[0]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectUrls(item, output, key));
    return;
  }
  if (typeof value === "object") {
    Object.entries(value).forEach(([childKey, childValue]) => collectUrls(childValue, output, childKey));
  }
}

function choosePlatformThumbnail(platform, candidates) {
  const clean = cleanUrls(candidates).filter((url) => isUsefulThumbnail(platform, url));
  if (platform === "instagram") {
    return clean.find((url) => /t51\.(?:71878|2885)-15/i.test(url)) ?? clean[0] ?? null;
  }
  if (platform === "x") {
    return (
      clean.find((url) => /amplify_video_thumb|tweet_video_thumb/i.test(url)) ??
      clean.find((url) => /pbs\.twimg\.com\/media\//i.test(url)) ??
      clean.find((url) => /pbs\.twimg\.com\/card_img\//i.test(url)) ??
      clean[0] ??
      null
    );
  }
  return clean[0] ?? null;
}

function isUsefulThumbnail(platform, url) {
  if (!isLikelyImage(url)) return false;
  if (
    /profile_images|profile_banners|emoji\/v2|abs\.twimg\.com|static\.licdn\.com|favicon|apple-touch-icon|sprite|\[redacted/i.test(
      url
    )
  ) {
    return false;
  }
  if (platform === "instagram" && /profile_pic|s150x150|t51\.82787-19/i.test(url)) return false;
  if (platform === "linkedin" && /profile-displayphoto|company-logo/i.test(url)) return false;
  if ((platform === "web" || platform === "rss") && /logo(?:[-_./]|$)|icon(?:[-_./]|$)/i.test(url)) return false;
  return true;
}

function isLikelyImage(url) {
  return (
    /\.(?:png|jpe?g|webp|gif)(?:$|[?#])/i.test(url) ||
    /[?&]format=(?:jpg|jpeg|png|webp|gif)\b/i.test(url) ||
    /i\.ytimg\.com\/vi\//i.test(url) ||
    /pbs\.twimg\.com\/(?:media|amplify_video_thumb|tweet_video_thumb|card_img)\//i.test(url) ||
    /media\.licdn\.com|cdninstagram\.com|ph-files\.imgix\.net/i.test(url)
  );
}

function youtubeThumbnailFromUrl(sourceUrl) {
  const id = youtubeVideoId(sourceUrl);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}

function youtubeThumbnailFromRaw(rawVisibleText) {
  if (!rawVisibleText) return null;
  const direct = thumbnailCandidatesFromRaw(rawVisibleText).find((url) => /i\.ytimg\.com\/vi\//i.test(url));
  if (direct) return direct;
  try {
    const parsed = JSON.parse(rawVisibleText);
    const id = parsed.videoId ?? parsed.id;
    return id && /^[A-Za-z0-9_-]{6,}$/.test(id) ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
  } catch {
    const id = youtubeVideoId(rawVisibleText);
    return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
  }
}

function youtubeVideoId(value) {
  try {
    const url = new URL(value);
    const queryId = url.searchParams.get("v");
    if (queryId) return queryId;
  } catch {
    // continue
  }
  return (
    String(value).match(/(?:youtube\.com\/watch\?[^#\s]*\bv=|youtu\.be\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{6,})/i)?.[1] ??
    null
  );
}

function githubThumbnailFromUrl(sourceUrl, itemId, authorHandle) {
  const match = String(sourceUrl).match(/github\.com\/([^/\s?#]+)(?:\/([^/\s?#]+))?/i);
  if (!match) return authorHandle ? `https://github.com/${encodeURIComponent(authorHandle)}.png?size=240` : null;
  const owner = match[1];
  const repo = match[2]?.replace(/\.git$/i, "");
  return repo ? `https://opengraph.githubassets.com/${encodeURIComponent(itemId)}/${owner}/${repo}` : `https://github.com/${owner}.png?size=240`;
}

function cleanUrls(urls) {
  const seen = new Set();
  const clean = [];
  for (const url of urls) {
    const sanitized = sanitizeUrl(url);
    if (sanitized && !seen.has(sanitized)) {
      seen.add(sanitized);
      clean.push(sanitized);
    }
  }
  return clean;
}

function sanitizeUrl(value) {
  if (!value) return null;
  const trimmed = String(value)
    .replace(/\\\//g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/&amp;/g, "&")
    .replace(/[)\].,;]+$/g, "")
    .trim();
  try {
    const url = new URL(trimmed);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (/\[redacted/i.test(trimmed)) {
      for (const [key, value] of [...url.searchParams.entries()]) {
        if (/\[redacted/i.test(value)) url.searchParams.delete(key);
      }
      url.hash = "";
    }
    return url.toString();
  } catch {
    return null;
  }
}

function stableId(value) {
  return String(value || "thumbnail")
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 160);
}
