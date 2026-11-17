import { beforeAll, describe, expect, it } from "vitest";
import { createReadStream, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { EvidenceItem } from "@/lib/graph/types";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { canonicalEvidenceUrl, canonicalPostKey, hasEvidenceIdentityConflict } from "@/lib/graph/dedupe";
import {
  isVerifiedOfficialYcLaunchContext,
  isVerifiedOfficialWebsiteArticleContext,
  isVerifiedOfficialGithubReleaseContext,
  isVerifiedOfficialCompanyPublicationContext,
  isVerifiedFallNativeTikTok,
  isVerifiedFallNativeFacebook,
  isVerifiedOfficialYcCompanyPageYouTubeEmbed,
  ycFall2026GraphDataset,
  yc2026GraphDataset
} from "@/lib/graph/yc-spring-2026-dataset";

// Independent public-source projections retain every body checked below while
// excluding production browser receipts and signed-in UI chrome.
function publicFixture(name: string) {
  const bytes = readFileSync(`tests/fixtures/fall-2026/${name}`);
  return JSON.parse((name.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"));
}

/** Read every frozen pretty-JSON row, retaining only canonical receipts used by
 * these assertions. A full duplicate snapshot would exceed the worker budget. */
async function canonicalTestReceipts(): Promise<{ evidence: EvidenceItem[] }> {
  const evidence: EvidenceItem[] = [];
  const firstProvenances = new Set([
    "official_snapshot_native_github_release_v1", "official_company_website_article_v1",
    "official_company_publication_article_v1"
  ]);
  const retainedProvenances = new Set<string>();
  let pending = "", rowLines: string[] | null = null;
  let started = false, ended = false, parsedRows = 0, rowBytes = 0;
  function line(value: string) {
    if (!started) {
      if (value === '  "evidence": [') started = true;
      return;
    }
    if (ended) return;
    if (value === "  ]" || value === "  ],") {
      if (rowLines) throw new Error("Canonical evidence array ended inside a row.");
      ended = true;
      return;
    }
    if (!rowLines) {
      // The frozen append format can preserve a separator on its own line.
      if (/^\s*,?\s*$/.test(value)) return;
      if (value !== "    {") throw new Error("Unexpected canonical evidence row boundary.");
      rowLines = [];
      rowBytes = 0;
    }
    rowBytes += Buffer.byteLength(value, "utf8");
    if (rowBytes > 32 * 1024 * 1024) throw new Error("Canonical test receipt exceeded its bounded row size.");
    rowLines.push(value);
    if (value !== "    }" && value !== "    },") return;
    const row = JSON.parse(rowLines.join("\n").replace(/,$/, "")) as EvidenceItem;
    if (!row || typeof row !== "object" || typeof row.id !== "string") throw new Error("Malformed canonical evidence row.");
    parsedRows++;
    const provenance = row.attributionProvenance;
    const firstReceipt = !!provenance && firstProvenances.has(provenance) && !retainedProvenances.has(provenance);
    if (firstReceipt || (row.batchSlug === "F26" && (row.platform === "tiktok" || row.platform === "facebook"))
      || row.platformPostId === "7518380931548606464" || row.id === "web-f26-yc-launch-125707") {
      evidence.push(row);
      if (firstReceipt) retainedProvenances.add(provenance!);
    }
    rowLines = null;
  }
  for await (const chunk of createReadStream("src/lib/social/targeted-evidence-current.json", { encoding: "utf8", highWaterMark: 64 * 1024 })) {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) {
      line(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
    if (Buffer.byteLength(pending, "utf8") > 32 * 1024 * 1024) throw new Error("Canonical test receipt exceeded its bounded line size.");
  }
  if (pending) line(pending);
  if (!started || !ended || rowLines || parsedRows === 0) throw new Error("Canonical evidence array was not completely read.");
  return { evidence };
}

describe("Fall 2026 official ingestion", () => {
  let graph: ReturnType<typeof buildGraphResponse>;
  let canonical: Awaited<ReturnType<typeof canonicalTestReceipts>>;
  beforeAll(async () => {
    canonical = await canonicalTestReceipts();
    graph = buildGraphResponse({ batchSlug: "F26" }, yc2026GraphDataset);
  }, 90_000);

  it("includes the complete roster and preserves explicit batch ownership", () => {
    expect(ycFall2026GraphDataset.companies).toHaveLength(235);
    expect(ycFall2026GraphDataset.founders).toHaveLength(457);
    expect(ycFall2026GraphDataset.evidence.length).toBeGreaterThan(300);
    expect(ycFall2026GraphDataset.evidence.every((row) => row.batchSlug === "F26")).toBe(true);
    expect(graph.batch.slug).toBe("F26");
    expect(graph.nodes.filter((node) => node.entityType === "company")).toHaveLength(235);
    expect(graph.nodes.every((node) => node.batchSlug === "F26")).toBe(true);
  });

  it("preserves all official launch bodies as context with zero score", () => {
    const launches = ycFall2026GraphDataset.evidence.filter((row) => row.attributionProvenance === "official_yc_launch_context_v1");
    expect(launches).toHaveLength(201);
    expect(new Set(launches.map((row) => row.entityId)).size).toBe(195);
    expect(launches.every((row) => row.contributionScore === 0 && row.originalText && row.sourceUrl.includes("ycombinator.com/launches/"))).toBe(true);
    const archive = publicFixture("official-yc-launches.json");
    const originalBodies = new Map<string, string>(archive.companies.flatMap((company: { launches: Array<{ ycdc_launch_url?: string; url?: string; body: string }> }) =>
      company.launches.map((launch) => [canonicalEvidenceUrl(launch.ycdc_launch_url ?? launch.url ?? ""), launch.body])
    ));
    for (const launch of launches) {
      expect(launch.originalText, launch.id).toBe(originalBodies.get(canonicalEvidenceUrl(launch.sourceUrl)));
      expect(launch.platformPostId, launch.id).toBe(launch.sourceUrl);
      expect(hasEvidenceIdentityConflict(launch), launch.id).toBe(false);
    }
  });

  it("keeps all fetched GitHub repositories and account contexts for Fall", () => {
    const collected = JSON.parse(readFileSync("src/lib/social/github-traction-fall-2026.json", "utf8"));
    const accounts = collected.accounts.filter((account: { fetched: boolean }) => account.fetched);
    const expected = accounts.reduce((count: number, account: { repos: unknown[] }) => count + account.repos.length + 1, 0);
    expect(ycFall2026GraphDataset.evidence.filter((row) => row.platform === "github" && row.attributionProvenance !== "official_snapshot_native_github_release_v1")).toHaveLength(expected);
  });

  it("preserves native release bodies and publication clocks separately from repository traction", () => {
    const archive = publicFixture("official-github-releases.json");
    const originals = new Map<string, { text: string; postedAt: string; entityId: string; authorName: string }>(archive.context.map((row: { platformPostId: string; text: string; postedAt: string; entityId: string; authorName: string }) => [row.platformPostId, row]));
    const releases = ycFall2026GraphDataset.evidence.filter((row) => row.attributionProvenance === "official_snapshot_native_github_release_v1");
    expect(releases).toHaveLength(4215);
    expect(releases.filter((row) => row.captionAbsent)).toHaveLength(2675);
    expect(new Set(releases.map(canonicalPostKey)).size).toBe(releases.length);
    for (const release of releases) {
      const original = originals.get(release.platformPostId!)!;
      expect(release.text, release.id).toBe(original.text);
      expect(release.originalText, release.id).toBe(original.text || undefined);
      expect(release.postedAt, release.id).toBe(original.postedAt);
      expect(release.publishedAtPrecision, release.id).toBe("exact");
      expect(release.entityId, release.id).toBe(original.entityId);
      expect(release.authorName, release.id).toBe(original.authorName);
      expect(release.platformObjectId, release.id).toBeNull();
      expect(release.metrics, release.id).toEqual({});
      expect(release.contributionScore, release.id).toBe(0);
      expect(release.tractionStatus, release.id).toBe("unscored");
      expect(hasEvidenceIdentityConflict(release), release.id).toBe(false);
    }
    const native = canonical.evidence.find((row) => row.attributionProvenance === "official_snapshot_native_github_release_v1");
    expect(isVerifiedOfficialGithubReleaseContext(native)).toBe(true);
    expect(isVerifiedOfficialGithubReleaseContext({ ...native, originalText: "Altered native release body" })).toBe(false);
    expect(isVerifiedOfficialGithubReleaseContext({ ...native, postedAt: "2026-11-15T00:00:00Z" })).toBe(false);
    expect(isVerifiedOfficialGithubReleaseContext({ ...native, metrics: { stars: 1 } })).toBe(false);
  });

  it("resolves only the three explicitly owned repositories from official launch receipts", () => {
    const proofs = JSON.parse(readFileSync("src/lib/social/github-repository-ownership-fall-2026.json", "utf8"));
    expect(proofs.proofs).toHaveLength(3);
    for (const proof of proofs.proofs) {
      const repository = ycFall2026GraphDataset.evidence.find((row) => row.entityId === proof.entityId && row.platformPostId?.toLowerCase() === proof.repositoryFullName.toLowerCase());
      expect(repository, proof.repositoryFullName).toBeDefined();
      expect(repository!.review_state).toBe("verified");
      expect(repository!.attributionProvenance).toBe("official_yc_launch_repository_ownership_v1");
      expect(JSON.parse(repository!.rawVisibleText!).officialRepositoryOwnershipProof).toEqual(proof);
    }
  });

  it("preserves exact official article and release bodies with zero traction", () => {
    const archive = publicFixture("official-website-articles.json.gz");
    const originals = new Map<string, string>(archive.context.map((row: { sourceUrl: string; text: string }) => [canonicalEvidenceUrl(row.sourceUrl), row.text]));
    const contexts = ycFall2026GraphDataset.evidence.filter((row) => row.attributionProvenance === "official_company_website_article_v1");
    expect(contexts).toHaveLength(archive.context.length);
    const review = publicFixture("website-semantic-quarantine.json");
    const excludedUrls = new Set(review.recommendedQuarantineRows.map((row: { sourceUrl: string }) => canonicalEvidenceUrl(row.sourceUrl)));
    expect(contexts.some((row) => excludedUrls.has(canonicalEvidenceUrl(row.sourceUrl)))).toBe(false);
    for (const context of contexts) {
      expect(context.originalText, context.id).toBe(originals.get(canonicalEvidenceUrl(context.sourceUrl)));
      expect(context.contributionScore, context.id).toBe(0);
      expect(context.metrics, context.id).toEqual({});
      expect(context.tractionStatus, context.id).toBe("unscored");
      expect(hasEvidenceIdentityConflict(context), context.id).toBe(false);
    }
    const first = canonical.evidence.find((row) => row.attributionProvenance === "official_company_website_article_v1");
    expect(isVerifiedOfficialWebsiteArticleContext(first)).toBe(true);
    expect(isVerifiedOfficialWebsiteArticleContext({ ...first, originalText: "Altered article body" })).toBe(false);
    expect(isVerifiedOfficialWebsiteArticleContext({ ...first, contributionScore: 1 })).toBe(false);
    expect(isVerifiedOfficialWebsiteArticleContext({ ...first, metrics: { likes: 0 } })).toBe(false);
  });

  it("omits LinkedIn search pages and exposes public account roots", () => {
    const kiwi = ycFall2026GraphDataset.companies.find((company) => company.id === "company-kiwi")!;
    expect(kiwi.socialAccounts.some((account) => account.platform === "linkedin")).toBe(false);
    const kanopy = ycFall2026GraphDataset.companies.find((company) => company.id === "company-kanopy")!;
    expect(kanopy.socialAccounts.find((account) => account.platform === "linkedin")?.url).toBe("https://linkedin.com/company/143631157");
  });

  it("retains exact owned publication originals only through their verified footer and native receipts", () => {
    const archive = publicFixture("official-particularity-publication.json");
    const rows = ycFall2026GraphDataset.evidence.filter((row) => row.attributionProvenance === "official_company_publication_article_v1");
    expect(rows).toHaveLength(2);
    for (const original of archive.context) {
      const row = rows.find((candidate) => candidate.sourceUrl === original.sourceUrl)!;
      expect(row.originalText).toBe(original.text);
      expect(row.contributionScore).toBe(0);
      expect(row.metrics).toEqual({});
      expect(row.tractionStatus).toBe("unscored");
      expect(Date.parse(row.postedAt)).toBe(Date.parse(original.postedAt));
    }
    const row = canonical.evidence.find((candidate) => candidate.attributionProvenance === "official_company_publication_article_v1");
    expect(isVerifiedOfficialCompanyPublicationContext(row)).toBe(true);
    expect(isVerifiedOfficialCompanyPublicationContext({ ...row, originalText: "Changed publication body" })).toBe(false);
    expect(isVerifiedOfficialCompanyPublicationContext({ ...row, entityId: "company-gatherhq" })).toBe(false);
  });

  it("retains native zero and hidden engagement history without a traction score", () => {
    for (const nativeId of ["7518380931548606464", "DfxoSoHqKIT"]) {
      const post = graph.evidence.find((row) => row.platformPostId === nativeId)!;
      expect(post, nativeId).toBeDefined();
      expect(post.contributionScore, nativeId).toBe(0);
      expect(post.tractionStatus, nativeId).toBe("unscored");
    }
    const hiddenMetrics = graph.evidence.find((row) => row.platformPostId === "DfxoSoHqKIT")!;
    expect(hiddenMetrics.metrics).toEqual({});
    const unknownDate = graph.evidence.find((row) => row.platformPostId === "7518380931548606464")!;
    expect(unknownDate.publishedAtPrecision).toBe("unknown");
    expect(canonical.evidence.find((row) => row.platformPostId === "7518380931548606464")!.postedAt).toBeNull();
  });

  it("retains official TikTok captions and native metadata without inventing a publication year", () => {
    const originals = canonical.evidence.filter((row) => row.batchSlug === "F26" && row.platform === "tiktok");
    expect(originals.length).toBeGreaterThanOrEqual(5);
    const rows = graph.evidence.filter((row) => row.platform === "tiktok");
    expect(rows).toHaveLength(originals.length);
    for (const original of originals) {
      expect(isVerifiedFallNativeTikTok(original), original.platformPostId ?? undefined).toBe(true);
      expect(original.postedAt).toBeNull();
      const row = rows.find((candidate) => candidate.platformPostId === original.platformPostId)!;
      expect(row.text).toBe(original.text);
      expect(row.originalText ?? "").toBe(original.originalText);
      expect(row.metrics).toEqual(original.metrics);
      expect(row.publishedAtPrecision).toBe("unknown");
      expect(hasEvidenceIdentityConflict(row)).toBe(false);
      if (row.captionAbsent) {
        expect(row.contributionScore).toBe(0);
        expect(row.tractionStatus).toBe("unscored");
      }
    }
    expect(isVerifiedFallNativeTikTok({ ...originals[0], entityId: "company-other" })).toBe(false);
  });

  it("retains Facebook full captions and typed photo updates unscored with unknown engagement and timezone", () => {
    const originals = canonical.evidence.filter((row) => row.batchSlug === "F26" && row.platform === "facebook");
    expect(originals.length).toBeGreaterThanOrEqual(7);
    const rows = graph.evidence.filter((row) => row.platform === "facebook");
    expect(rows).toHaveLength(originals.length);
    for (const original of originals) {
      expect(isVerifiedFallNativeFacebook(original), original.platformPostId ?? undefined).toBe(true);
      const row = rows.find((candidate) => candidate.platformPostId === original.platformPostId)!;
      expect(row.text).toBe(original.text);
      expect(row.originalText ?? "").toBe(original.originalText);
      expect(row.nativeContentKind).toBe(original.nativeContentKind);
      expect(row.countsAsAuthoredPost).toBe(original.countsAsAuthoredPost);
      expect(original.postedAt).toBeNull();
      expect(row.publishedAtPrecision).toBe("unknown");
      expect(row.metrics).toEqual({});
      expect(row.contributionScore).toBe(0);
      expect(row.tractionStatus).toBe("unscored");
      expect(hasEvidenceIdentityConflict(row)).toBe(false);
    }
    expect(rows.filter((row) => row.nativeContentKind === "profile_photo_update" || row.nativeContentKind === "cover_photo_update").length).toBeGreaterThanOrEqual(3);
    expect(isVerifiedFallNativeFacebook({ ...originals[0], authorName: "Third party" })).toBe(false);
  });

  it("retains captionless native media metadata without creating an original caption", () => {
    const post = graph.evidence.find((row) => row.platformPostId === "Dd2nucIjTDp")!;
    expect(post).toBeDefined();
    expect(post.captionAbsent).toBe(true);
    expect(post.text).toBe("");
    expect(post.originalText).toBeUndefined();
    expect(post.metrics).toEqual({ likes: 15, comments: 2 });
    expect(post.contributionScore).toBe(0);
    expect(post.tractionStatus).toBe("unscored");
  });

  it("preserves explicit attributions of shared native posts in each batch", () => {
    for (const nativeId of ["fQEVpQPYNxg", "jHTzpKbmZa4"]) {
      const rows = yc2026GraphDataset.evidence.filter((row) => row.platform === "youtube" && row.platformPostId === nativeId);
      expect(rows.some((row) => row.batchSlug === "F26"), nativeId).toBe(true);
      expect(rows.some((row) => row.batchSlug === "S26"), nativeId).toBe(true);
      const fall = rows.find((row) => row.batchSlug === "F26")!;
      const summer = rows.find((row) => row.batchSlug === "S26")!;
      expect(canonicalPostKey(fall)).toBe(canonicalPostKey(summer));
    }
  });

  it("trusts original launch prose only when the zero-score official receipt matches", () => {
    const launch = canonical.evidence.find((row) => row.id === "web-f26-yc-launch-125707");
    expect(isVerifiedOfficialYcLaunchContext(launch)).toBe(true);
    expect(isVerifiedOfficialYcLaunchContext({ ...launch, originalText: "Altered body" })).toBe(false);
    expect(isVerifiedOfficialYcLaunchContext({ ...launch, contributionScore: 1 })).toBe(false);
    expect(isVerifiedOfficialYcLaunchContext({ ...launch, entityId: "company-gatherhq" })).toBe(false);
  });

  it("validates omitted YouTube metrics without inventing zeros", () => {
    const metrics = { views: 149, likes: 3 };
    const receipt = {
      source: "official_yc_company_page_embed_v1",
      company: { name: "GatherHQ", slug: "gatherhq", entityId: "company-gatherhq" },
      post: { platformPostId: "PuxzsvVnNGY", publishedAt: "2026-10-24T19:44:17Z" },
      metrics,
      officialYcProfileUrl: "https://www.ycombinator.com/companies/gatherhq"
    };
    const row = {
      batchSlug: "F26", entityType: "company", entityId: "company-gatherhq", companyName: "GatherHQ",
      platform: "youtube", platformPostId: "PuxzsvVnNGY",
      sourceUrl: "https://www.youtube.com/watch?v=PuxzsvVnNGY",
      postedAt: receipt.post.publishedAt, metrics, review_state: "verified", attributionStatus: "verified",
      attributionSignals: ["official_yc_company_page_embed"], rawVisibleText: JSON.stringify(receipt)
    };
    expect(isVerifiedOfficialYcCompanyPageYouTubeEmbed(row)).toBe(true);
    expect(isVerifiedOfficialYcCompanyPageYouTubeEmbed({ ...row, metrics: { ...metrics, comments: 0 } })).toBe(false);
    expect(isVerifiedOfficialYcCompanyPageYouTubeEmbed({ ...row, entityId: "company-jinko" })).toBe(false);
    expect(isVerifiedOfficialYcCompanyPageYouTubeEmbed({ ...row, sourceUrl: "https://youtube.com/watch?v=another" })).toBe(false);
  });
});
