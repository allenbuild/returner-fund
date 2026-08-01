import type { EvidenceItem } from "./types";

export interface GithubRepositoryTimestamps {
  createdAt?: string | null;
  updatedAt?: string | null;
  pushedAt?: string | null;
}

export interface GithubRepositoryEvidenceTimestamps {
  postedAt: string;
  publishedAtPrecision: EvidenceItem["publishedAtPrecision"];
  lastUpdatedAt: string;
  provenance: {
    createdAt: string | null;
    updatedAt: string | null;
    pushedAt: string | null;
    observedAt: string;
  };
}

/**
 * A GitHub repository is published when the repository is created. A later
 * push, metadata update, or collection refresh is activity on that existing
 * repository, not a new post.
 */
export function githubRepositoryEvidenceTimestamps(
  repository: GithubRepositoryTimestamps,
  observedAt: string
): GithubRepositoryEvidenceTimestamps {
  const createdAt = validTimestamp(repository.createdAt);
  const updatedAt = validTimestamp(repository.updatedAt);
  const pushedAt = validTimestamp(repository.pushedAt);
  const lastUpdatedAt = latestTimestamp([updatedAt, pushedAt]) ?? observedAt;

  return {
    postedAt: createdAt ?? observedAt,
    publishedAtPrecision: createdAt ? publicationTimestampPrecision(createdAt) : "unknown",
    lastUpdatedAt,
    provenance: {
      createdAt,
      updatedAt,
      pushedAt,
      observedAt
    }
  };
}

function validTimestamp(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function latestTimestamp(values: Array<string | null>): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;

  for (const value of values) {
    if (!value) continue;
    const timestampMs = Date.parse(value);
    if (timestampMs > latestMs) {
      latest = value;
      latestMs = timestampMs;
    }
  }

  return latest;
}

function publicationTimestampPrecision(value: string): EvidenceItem["publishedAtPrecision"] {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? "day" : "exact";
}
