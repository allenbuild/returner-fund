"use client";

import { useState } from "react";
import type { EvidenceItem } from "@/lib/graph/types";
import { formatPlatform, PlatformLogo } from "./PlatformLogo";

interface EvidenceMediaCardProps {
  item: EvidenceItem;
  compact?: boolean;
}

export function EvidenceMediaCard({ item, compact = false }: EvidenceMediaCardProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const snippet = evidenceSnippet(item);
  const metrics = compactMetrics(item.metrics).join(" / ");
  const thumbnailUrl = shouldAttemptThumbnail(item) && !imageFailed ? item.thumbnailUrl : null;

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
            onError={() => setImageFailed(true)}
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

      <div className="contribution-pill">
        <strong>{item.contributionScore}</strong>
        <span>contribution</span>
      </div>
    </a>
  );
}

function shouldAttemptThumbnail(item: EvidenceItem): item is EvidenceItem & { thumbnailUrl: string } {
  if (!item.thumbnailUrl) {
    return false;
  }

  if (item.platform === "instagram" && /(?:cdninstagram|fbcdn)\.com/i.test(item.thumbnailUrl)) {
    return false;
  }

  return true;
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
