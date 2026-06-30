"use client";

import { useMemo, useState } from "react";
import type { EvidenceItem, Platform } from "@/lib/graph/types";
import { EvidenceMediaCard } from "./EvidenceMediaCard";

interface EvidenceFeedProps {
  items: EvidenceItem[];
  compact?: boolean;
}

type SortKey = "contribution" | "newest" | "views" | "likes" | "comments" | "platform";

const sortLabels: Record<SortKey, string> = {
  contribution: "Score contribution",
  newest: "Newest",
  views: "Views",
  likes: "Likes",
  comments: "Comments",
  platform: "Platform"
};

export function EvidenceFeed({ items, compact = false }: EvidenceFeedProps) {
  const [sortKey, setSortKey] = useState<SortKey>("contribution");
  const [platform, setPlatform] = useState<Platform | "all">("all");

  const platforms = useMemo(
    () => [...new Set(items.map((item) => item.platform))].sort(),
    [items]
  );

  const visibleItems = useMemo(() => {
    const filtered =
      platform === "all" ? items : items.filter((item) => item.platform === platform);

    return [...filtered].sort((a, b) => {
      if (sortKey === "newest") {
        return new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime();
      }
      if (sortKey === "views") {
        return (b.metrics.views ?? 0) - (a.metrics.views ?? 0);
      }
      if (sortKey === "likes") {
        return (b.metrics.likes ?? 0) - (a.metrics.likes ?? 0);
      }
      if (sortKey === "comments") {
        return (b.metrics.comments ?? 0) - (a.metrics.comments ?? 0);
      }
      if (sortKey === "platform") {
        return a.platform.localeCompare(b.platform);
      }
      return b.contributionScore - a.contributionScore;
    });
  }, [items, platform, sortKey]);

  return (
    <section className={compact ? "evidence evidence-compact" : "evidence"}>
      <div className="feed-controls">
        <label>
          Sort
          <select value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)}>
            {(Object.keys(sortLabels) as SortKey[]).map((key) => (
              <option key={key} value={key}>
                {sortLabels[key]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Platform
          <select
            value={platform}
            onChange={(event) => setPlatform(event.target.value as Platform | "all")}
          >
            <option value="all">All</option>
            {platforms.map((item) => (
              <option key={item} value={item}>
                {formatPlatform(item)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="evidence-list">
        {visibleItems.map((item) => (
          <EvidenceMediaCard item={item} compact={compact} key={item.id} />
        ))}
        {!visibleItems.length && <div className="empty-state">No evidence in this view.</div>}
      </div>
    </section>
  );
}

function formatPlatform(platform: Platform): string {
  const labels: Record<Platform, string> = {
    github: "GitHub",
    x: "X",
    linkedin: "LinkedIn",
    instagram: "Instagram",
    product_hunt: "Product Hunt",
    youtube: "YouTube",
    rss: "RSS",
    web: "Web",
    reddit: "Reddit",
    hacker_news: "Hacker News",
    bilibili: "Bilibili"
  };
  return labels[platform];
}
