"use client";

import { useState } from "react";
import {
  generatedEvidenceThumbnailDataUri,
  generatedEvidenceThumbnailUrl
} from "@/lib/graph/generated-evidence-thumbnail";
import { evidenceDisplayText } from "@/lib/graph/evidence-display";
import { resolveEvidenceThumbnail } from "@/lib/graph/evidence-thumbnails";
import { normalizeMetricsForScoring } from "@/lib/graph/traction-scoring-config";
import type { EvidenceItem } from "@/lib/graph/types";
import { formatPlatform, PlatformLogo } from "./PlatformLogo";

interface EvidenceMediaCardProps {
  item: EvidenceItem;
  compact?: boolean;
}

export function EvidenceMediaCard({ item, compact = false }: EvidenceMediaCardProps) {
  return (
    <EvidenceMediaCardContent
      key={`${item.id}:${item.thumbnailUrl ?? ""}`}
      item={item}
      compact={compact}
    />
  );
}

function EvidenceMediaCardContent({ item, compact = false }: EvidenceMediaCardProps) {
  const [failedThumbnailUrls, setFailedThumbnailUrls] = useState<string[]>([]);
  const snippet = evidenceSnippet(item);
  const metrics = compactMetrics(item).join(" / ");
  const thumbnailCandidates = thumbnailUrlCandidates(item);
  const thumbnailUrl = thumbnailCandidates.find((candidate) => !failedThumbnailUrls.includes(candidate)) ?? null;
  const postDate = formatPostDate(item.postedAt);
  const isUnscored = item.tractionStatus === "unscored";

  function handleThumbnailError(url: string) {
    setFailedThumbnailUrls((current) => (current.includes(url) ? current : [...current, url]));
  }

  return (
    <a
      className={compact ? "top-post-card evidence-media-card compact" : "top-post-card evidence-media-card"}
      href={item.sourceUrl}
      target="_blank"
      rel="noreferrer"
    >
      <div className="evidence-thumbnail" aria-label={`${formatPlatform(item.platform)} thumbnail`}>
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => handleThumbnailError(thumbnailUrl)}
          />
        ) : (
          <div className={`evidence-thumbnail-fallback evidence-thumbnail-${item.platform}`}>
            <span className="fallback-platform">
              <PlatformLogo platform={item.platform} decorative={false} />
            </span>
            <strong>{snippet}</strong>
            {metrics && <small>{metrics}</small>}
          </div>
        )}
        <div className={isUnscored ? "contribution-pill unscored" : "contribution-pill"}>
          <strong>{isUnscored ? "Unscored" : item.contributionScore}</strong>
        </div>
      </div>

      <div className="evidence-card-body">
        <div className="evidence-card-meta">
          <span className={`platform-badge platform-badge-${item.platform}`}>
            <PlatformLogo platform={item.platform} />
            <span>{formatPlatform(item.platform)}</span>
          </span>
          <time dateTime={item.postedAt}>{postDate}</time>
        </div>
        <h4>{snippet}</h4>
        {metrics && <p className="evidence-card-stats">{metrics}</p>}
      </div>
    </a>
  );
}

function thumbnailUrlCandidates(item: EvidenceItem): string[] {
  const resolved = resolveEvidenceThumbnail(item).thumbnailUrl;
  const generatedDataUri = generatedEvidenceThumbnailDataUri(item);
  const generatedUrl = generatedEvidenceThumbnailUrl(item);
  return uniqueStrings([resolved, item.thumbnailUrl, generatedDataUri, generatedUrl]);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return values.filter((value, index): value is string => Boolean(value) && values.indexOf(value) === index);
}

function evidenceSnippet(item: EvidenceItem): string {
  const text = evidenceDisplayText(item);
  const compact = text.replace(/\s+/g, " ").replace(/([.!?]){2,}/g, "$1").trim();
  const sentence = compact.match(/^(.+?[.!?])\s/)?.[1] ?? compact;
  return sentence.length > 170 ? `${sentence.slice(0, 167)}...` : sentence;
}

function formatPostDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "Date unavailable";
  }

  const day = date.getUTCDate();
  const month = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(date);
  return `${month} ${day}${ordinalSuffix(day)}, ${date.getUTCFullYear()}`;
}

function ordinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) return "th";
  if (day % 10 === 1) return "st";
  if (day % 10 === 2) return "nd";
  if (day % 10 === 3) return "rd";
  return "th";
}


function compactMetrics(item: EvidenceItem): string[] {
  const metrics = normalizeMetricsForScoring(item.platform, item.metrics);
  const ordered = [
    "views",
    "likes",
    "reactions",
    "comments",
    "replies",
    "reposts",
    "shares",
    "quotes",
    "upvotes",
    "stars",
    "forks",
    "watchers",
    "issues",
    "recent_commits_30d",
    "saves"
  ];

  return ordered
    .map((metric) => [metric, metrics[metric]] as const)
    .filter(([, value]) => Number.isFinite(value) && Number(value) > 0)
    .slice(0, 4)
    .map(([metric, value]) => `${formatNumber(Number(value))} ${metricLabel(item.platform, metric, Number(value))}`);
}

function metricLabel(platform: EvidenceItem["platform"], metric: string, value: number): string {
  const labels: Record<string, [string, string]> = {
    views: ["view", "views"],
    likes: ["like", "likes"],
    reactions: ["reaction", "reactions"],
    comments: ["comment", "comments"],
    replies: ["reply", "replies"],
    reposts: ["repost", "reposts"],
    shares: ["share", "shares"],
    quotes: ["quote", "quotes"],
    upvotes: ["upvote", "upvotes"],
    stars: ["star", "stars"],
    forks: ["fork", "forks"],
    watchers: ["watcher", "watchers"],
    issues: ["issue", "issues"],
    recent_commits_30d: ["recent commit", "recent commits"],
    saves: ["save", "saves"]
  };
  if (platform === "x" && metric === "replies") {
    return value === 1 ? "comment" : "comments";
  }
  const [singular, plural] = labels[metric] ?? [metric, metric];
  return value === 1 ? singular : plural;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: value > 9999 ? "compact" : "standard" }).format(value);
}
