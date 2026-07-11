"use client";

import { useEffect, useState } from "react";
import {
  generatedEvidenceThumbnailDataUri,
  generatedEvidenceThumbnailUrl
} from "@/lib/graph/generated-evidence-thumbnail";
import type { EvidenceItem } from "@/lib/graph/types";
import { formatPlatform, PlatformLogo } from "./PlatformLogo";

interface EvidenceMediaCardProps {
  item: EvidenceItem;
  compact?: boolean;
}

export function EvidenceMediaCard({ item, compact = false }: EvidenceMediaCardProps) {
  const [failedThumbnailUrls, setFailedThumbnailUrls] = useState<string[]>([]);
  const snippet = evidenceSnippet(item);
  const metrics = compactMetrics(item.metrics).join(" / ");
  const thumbnailCandidates = thumbnailUrlCandidates(item);
  const thumbnailUrl = thumbnailCandidates.find((candidate) => !failedThumbnailUrls.includes(candidate)) ?? null;

  useEffect(() => {
    setFailedThumbnailUrls([]);
  }, [item.id, item.thumbnailUrl]);

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
        <div className="contribution-pill">
          <strong>{item.contributionScore}</strong>
        </div>
      </div>

      <div className="evidence-card-body">
        <div className="evidence-card-meta">
          <span className={`platform-badge platform-badge-${item.platform}`}>
            <PlatformLogo platform={item.platform} />
            <span>{formatPlatform(item.platform)}</span>
          </span>
          <span>{item.entityType === "founder" ? "Founder account" : "Company account"}</span>
        </div>
        <h4>{snippet}</h4>
        {metrics && <p className="evidence-card-stats">{metrics}</p>}
      </div>
    </a>
  );
}

function thumbnailUrlCandidates(item: EvidenceItem): string[] {
  const generatedDataUri = generatedEvidenceThumbnailDataUri(item);
  const generatedUrl = generatedEvidenceThumbnailUrl(item);
  return uniqueStrings(
    isLocalStaticThumbnail(item.thumbnailUrl)
      ? [item.thumbnailUrl, generatedDataUri, generatedUrl]
      : [generatedDataUri, item.thumbnailUrl, generatedUrl]
  );
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return values.filter((value, index): value is string => Boolean(value) && values.indexOf(value) === index);
}

function isLocalStaticThumbnail(value: string | null | undefined): boolean {
  return Boolean(value?.startsWith("/evidence-thumbnails/"));
}

function evidenceSnippet(item: EvidenceItem): string {
  const text = item.title || item.text || "Untitled evidence";
  const compact = text.replace(/\s+/g, " ").replace(/([.!?]){2,}/g, "$1").trim();
  const sentence = compact.match(/^(.+?[.!?])\s/)?.[1] ?? compact;
  return sentence.length > 170 ? `${sentence.slice(0, 167)}...` : sentence;
}


function compactMetrics(metrics: EvidenceItem["metrics"]): string[] {
  const ordered = [
    "views",
    "likes",
    "comments",
    "replies",
    "reposts",
    "quotes",
    "upvotes",
    "stars",
    "forks",
    "watchers"
  ];

  return ordered
    .map((metric) => [metric, metrics[metric]] as const)
    .filter(([, value]) => Number.isFinite(value) && Number(value) > 0)
    .slice(0, 4)
    .map(([metric, value]) => `${formatNumber(Number(value))} ${metric}`);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: value > 9999 ? "compact" : "standard" }).format(value);
}
