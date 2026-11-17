export function facebookNativeIdentity(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !/^(?:(?:www|m|web)\.)?facebook\.com$/.test(url.hostname.toLowerCase())) return null;
    const path = url.pathname.replace(/\/$/, "");
    if (path === "/permalink.php") {
      const story = url.searchParams.get("story_fbid"), owner = url.searchParams.get("id"), substory = url.searchParams.get("substory_index");
      if (!/^[A-Za-z0-9]+$/.test(story ?? "") || !/^\d+$/.test(owner ?? "") || (substory !== null && !/^\d+$/.test(substory))) return null;
      const canonical = new URL("https://www.facebook.com/permalink.php");
      canonical.searchParams.set("story_fbid", story); canonical.searchParams.set("id", owner);
      if (substory !== null) canonical.searchParams.set("substory_index", substory);
      return { accountKey: `/id/${owner}`, profileUrl: null, postId: `permalink:${owner}:${story}${substory === null ? "" : `:${substory}`}`, sourceUrl: canonical.toString(), kind: "permalink" };
    }
    if (path === "/profile.php") {
      const owner = url.searchParams.get("id");
      if (!/^\d+$/.test(owner ?? "")) return null;
      return { accountKey: `/id/${owner}`, profileUrl: `https://www.facebook.com/profile.php?id=${owner}`, postId: null, sourceUrl: `https://www.facebook.com/profile.php?id=${owner}`, kind: "profile" };
    }
    const reel = path.match(/^\/reel\/(\d+)$/);
    if (reel) return { accountKey: null, profileUrl: null, postId: `reel:${reel[1]}`, sourceUrl: `https://www.facebook.com/reel/${reel[1]}`, kind: "reel" };
    const match = path.match(/^(\/(?:people\/[^/]+\/\d+|[A-Za-z0-9._-]+))(?:\/posts\/([A-Za-z0-9_:]+))?$/);
    if (!match || ["photo", "photos", "watch", "share", "reel", "groups", "login", "sharer.php", "permalink.php"].includes(match[1].slice(1).toLowerCase())) return null;
    const pageId = match[1].match(/^\/people\/[^/]+\/(\d+)$/)?.[1];
    return { accountKey: pageId ? `/id/${pageId}` : match[1].toLowerCase(), profileUrl: `https://www.facebook.com${match[1]}`, postId: match[2] ?? null, sourceUrl: `https://www.facebook.com${path}`, kind: match[2] ? "post" : "profile" };
  } catch { return null; }
}
