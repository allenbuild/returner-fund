export function nativeThreadsIdentity(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["threads.com", "www.threads.com"].includes(url.hostname) || url.username || url.password || url.port || url.hash || [...url.searchParams.keys()].some((key) => key !== "xmt")) return null;
    const match = url.pathname.match(/^\/@([A-Za-z0-9_.]+)(?:\/post\/([A-Za-z0-9_-]+))?\/?$/);
    if (!match || match[2] && url.search) return null;
    return { handle: match[1].toLowerCase(), postId: match[2] ?? null };
  } catch { return null; }
}
