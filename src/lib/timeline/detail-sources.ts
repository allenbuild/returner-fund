import type { TimelineEvidenceDetail, TimelinePostEvidence } from "./contracts";

export interface TimelineDetailSources {
  evidence: TimelineEvidenceDetail[];
  posts: TimelinePostEvidence[];
}

/**
 * Assign every public source URL to a single detail section.
 *
 * Social posts are ingested both as source documents (for event
 * classification) and as post evidence (for platform/account/metric display).
 * Showing both records makes one source look like two independent pieces of
 * evidence. Prefer the richer post presentation unless the source document
 * carries conflict/date information that the post contract cannot represent.
 */
export function splitTimelineDetailSources(
  eventDate: string,
  evidence: readonly TimelineEvidenceDetail[],
  posts: readonly TimelinePostEvidence[],
): TimelineDetailSources {
  const postKeys = new Set(posts.map((post) => timelineSourceUrlKey(post.url)));
  const evidenceKeysToPreserve = new Set(
    evidence
      .filter((source) => {
        const key = timelineSourceUrlKey(source.url);
        return postKeys.has(key) && (
          source.isConflicting
          || Boolean(source.sourceEventDate && source.sourceEventDate !== eventDate)
        );
      })
      .map((source) => timelineSourceUrlKey(source.url)),
  );

  return {
    evidence: evidence.filter((source) => {
      const key = timelineSourceUrlKey(source.url);
      return !postKeys.has(key) || evidenceKeysToPreserve.has(key);
    }),
    posts: posts.filter((post) => !evidenceKeysToPreserve.has(timelineSourceUrlKey(post.url))),
  };
}

/**
 * Canonical identity for matching the same public source across ingestion
 * channels. Tracking parameters, fragments, a trailing slash, and common
 * social host aliases do not make a second source.
 */
export function timelineSourceUrlKey(value: string): string {
  try {
    const parsed = new URL(value);
    let hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (hostname === "twitter.com" || hostname === "mobile.twitter.com") hostname = "x.com";

    const pathname = parsed.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
    if (hostname === "youtu.be") {
      hostname = "youtube.com";
      const videoId = pathname.split("/").filter(Boolean)[0] ?? "";
      return `${hostname}/watch?v=${encodeURIComponent(videoId)}`;
    }
    if (hostname === "youtube.com" && pathname === "/watch") {
      return `${hostname}/watch?v=${encodeURIComponent(parsed.searchParams.get("v") ?? "")}`;
    }

    const socialHost = hostname === "x.com"
      || hostname === "linkedin.com"
      || hostname === "instagram.com"
      || hostname === "facebook.com"
      || hostname === "tiktok.com"
      || hostname === "producthunt.com";
    if (socialHost) return `${hostname}${pathname}`.toLowerCase();

    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_.+|ref|ref_|source|si|feature)$/i.test(key)) parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort();
    const search = parsed.searchParams.toString();
    return `${hostname}${pathname}${search ? `?${search}` : ""}`;
  } catch {
    return value.trim().replace(/[#?].*$/, "").replace(/\/$/, "").toLowerCase();
  }
}
