export const YC_NETWORK_MAP_TITLE = "YC Network Map";
export const A16Z_NETWORK_MAP_TITLE = "a16z Network Map";

export function networkMapTitle(batchSlug: string | undefined): string {
  return batchSlug === "A16ZSR006"
    ? A16Z_NETWORK_MAP_TITLE
    : YC_NETWORK_MAP_TITLE;
}
