export function founderProfileSourceUrl(node: {
  batchSlug?: string; entityType?: string; entityId?: string; review_state?: string;
  ycProfileUrl?: string; sourceUrl?: string;
}, founder: { id?: string; ycProfileUrl?: string }): string | undefined;
