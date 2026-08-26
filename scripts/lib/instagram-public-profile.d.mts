export interface InstagramNativeFeedRequestResult {
  username: string;
  url: string;
  options: {
    method: "GET";
    credentials: "omit";
    redirect: "error";
    headers: Record<string, string>;
  };
}

export interface InstagramNativeFeedPost {
  shortcode: string;
  nativeMediaId: string;
  url: string;
  mediaType: "reel" | "post";
  authorUsername: string;
  coauthorUsernames: string[];
  profileRole: "primary" | "coauthor" | "surface_only";
  caption: string;
  postedAt: string;
  metrics: {
    likes: number | null;
    comments: number | null;
    plays: number | null;
    videoViews: number | null;
  };
  mediaUrls: string[];
}

export interface InstagramNativeFeedReceipt {
  verified: boolean;
  reason: string;
  username: string | null;
  accountUrl: string | null;
  fetchedAt: string | null;
  receivedItemCount: number;
  processedItemCount: number;
  duplicateItemCount: number;
  moreAvailable: boolean;
  nextMaxId: string | null;
  nestedDataTruncated: boolean;
  truncated: boolean;
  posts: InstagramNativeFeedPost[];
}

export function instagramNativeFeedRequest(input?: {
  accountUrl?: string | null;
  username?: string | null;
  maxId?: string | null;
  appId?: string;
}): InstagramNativeFeedRequestResult;

export function parseInstagramNativeFeedResponse(input?: {
  payload?: unknown;
  requestedUsername?: string | null;
  fetchedAt?: string | null;
}): InstagramNativeFeedReceipt;
