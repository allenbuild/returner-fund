import type { EvidenceItem } from "@/lib/graph/types";

const platformNames: Partial<Record<EvidenceItem["platform"], string>> = {
  github: "GitHub",
  hacker_news: "Hacker News",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  product_hunt: "Product Hunt",
  reddit: "Reddit",
  rss: "RSS",
  tiktok: "TikTok",
  web: "Web",
  x: "X",
  youtube: "YouTube",
};

export function EntityEvidenceList({ evidence }: { evidence: EvidenceItem[] }) {
  if (evidence.length === 0) {
    return <p className="entity-empty-state">No public traction evidence is attached to this profile yet.</p>;
  }

  return (
    <ol className="entity-evidence-list">
      {evidence.map((item) => (
        <li key={item.id} className="entity-evidence-item">
          <div className="entity-evidence-heading">
            <span className="platform-badge">{platformNames[item.platform] ?? item.platform}</span>
            <time dateTime={item.postedAt}>{formatDate(item.postedAt)}</time>
          </div>
          <h3>{item.title?.trim() || evidenceTitle(item)}</h3>
          {item.text.trim() ? <p>{shorten(item.text, 280)}</p> : null}
          <div className="entity-evidence-footer">
            <dl aria-label="Public engagement metrics">
              {topMetrics(item).map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{compactNumber(value)}</dd>
                </div>
              ))}
              <div>
                <dt>Signal score</dt>
                <dd>{Math.round(item.contributionScore)}</dd>
              </div>
            </dl>
            <a href={item.sourceUrl} target="_blank" rel="nofollow noopener noreferrer">
              View source
            </a>
          </div>
        </li>
      ))}
    </ol>
  );
}

function evidenceTitle(item: EvidenceItem): string {
  const author = item.authorName.trim() || item.authorHandle?.trim();
  return author ? `${platformNames[item.platform] ?? item.platform} signal from ${author}` : "Public traction signal";
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(date);
}

function shorten(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).replace(/\s+\S*$/, "")}...`;
}

function topMetrics(item: EvidenceItem): [string, number][] {
  return Object.entries(item.metrics)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([key, value]) => [metricLabel(key), value]);
}

function metricLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}
