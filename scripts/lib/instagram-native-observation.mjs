const nativeShortcode = (value) => String(value ?? "").match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)(?:\/|$)/)?.[1];
const postPermalink = (value, id) => {
  try {
    const url = new URL(value, "https://www.instagram.com");
    return /^(?:www\.)?instagram\.com$/i.test(url.hostname) &&
      new RegExp(`^/(?:[A-Za-z0-9_.]+/)?(?:p|reel)/${id}/?$`).test(url.pathname);
  } catch { return false; }
};

export function instagramNativeAuthorHandle(original) {
  const fullPage = String(original.url ?? "").match(/^https:\/\/(?:www\.)?instagram\.com\/([^/]+)\/(?:reel|p)\/[A-Za-z0-9_-]+\/?/);
  if (fullPage) return fullPage[1];
  let generic;
  try {
    const nativeUrl = new URL(original.url);
    const query = [...nativeUrl.searchParams];
    if (nativeUrl.protocol === "https:" && /^(?:www\.)?instagram\.com$/i.test(nativeUrl.hostname) && !nativeUrl.username && !nativeUrl.password && !nativeUrl.port && !nativeUrl.hash &&
        (query.length === 0 || query.length === 1 && query[0][0] === "img_index" && /^[1-9]\d*$/.test(query[0][1]))) {
      generic = nativeUrl.pathname.match(/^\/(?:reel|p)\/([A-Za-z0-9_-]+)\/?$/);
    }
  } catch { /* Only exact native post URLs can use dialog header attribution. */ }
  const header = original.nativeAuthorHeader;
  if (!generic || header?.mechanism !== "native_post_dialog_header_v1" || !postPermalink(original.publicationFooter?.href, generic[1])) return null;
  try {
    const profile = new URL(header.profileUrl);
    const handle = profile.pathname.replace(/^\/|\/$/g, "");
    const nativeLines = String(original.nativeText ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
    const headerLines = String(header.visibleText ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
    const normalize = (value) => String(value ?? "").replace(/\s+/gu, " ").trim();
    return /^(?:www\.)?instagram\.com$/i.test(profile.hostname) && /^[A-Za-z0-9_.]+$/.test(handle) &&
      handle.toLowerCase() === String(header.handle).toLowerCase() && nativeLines.some((line) => line.toLowerCase() === handle.toLowerCase()) &&
      headerLines[0]?.toLowerCase() === handle.toLowerCase() &&
      normalize(original.nativeText).includes(normalize(header.visibleText)) ? handle : null;
  } catch { return null; }
}

export function isVerifiedInstagramNativeCaption(post, authorHandle) {
  const receipt = post.nativeCaptionReceipt;
  const normalize = (value) => String(value ?? "").replace(/\s+/gu, " ").trim();
  const dialogCaption = receipt?.mechanism === "native_caption_dialog_h1_v1" && instagramNativeAuthorHandle(post)?.toLowerCase() === String(authorHandle).toLowerCase();
  if ((!dialogCaption && receipt?.mechanism !== "native_caption_block_v1") || !normalize(post.text) || normalize(receipt.caption) !== normalize(post.text)) return false;
  if (!dialogCaption && (receipt.captionTime?.link || receipt.captionTime?.href || !Number.isFinite(Date.parse(receipt.captionTime?.datetime)))) return false;
  try {
    const author = new URL(receipt.authorLink);
    const blockLines = String(receipt.blockVisibleText ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
    return /^(?:www\.)?instagram\.com$/i.test(author.hostname) &&
      author.pathname.replace(/^\/|\/$/g, "").toLowerCase() === String(authorHandle).toLowerCase() &&
      receipt.authorName?.toLowerCase() === String(authorHandle).toLowerCase() &&
      (dialogCaption || blockLines[0]?.toLowerCase() === String(authorHandle).toLowerCase()) &&
      normalize(receipt.blockVisibleText).endsWith(normalize(post.text));
  } catch { return false; }
}

export function instagramPublicationFooter(original) {
  const explicit = original.publicationFooter;
  if (explicit) {
    if (!postPermalink(explicit.href, nativeShortcode(original.url)) || !Number.isFinite(Date.parse(explicit.datetime))) return null;
    return { ...explicit, selection: "explicit_native_post_footer" };
  }
  const footer = original.times?.at(-1);
  const label = String(footer?.text ?? "").trim();
  const fullDate = /^(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,\s*\d{4})?$/i;
  const fullRelative = /^(?:\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago|yesterday|today)$/i;
  if (!footer || !Number.isFinite(Date.parse(footer.datetime)) || (!fullDate.test(label) && !fullRelative.test(label))) return null;
  return { ...footer, timeIndex: original.times.length - 1, selection: "final_native_time_element_with_full_footer_label" };
}

/** Normalize only fields present on a saved native detail DOM observation. */
export function normalizeInstagramNativeObservation(original) {
  if (!original.controls || !original.times) return { ...original };
  const match = String(original.url ?? "").match(/^https:\/\/(?:www\.)?instagram\.com\/(?:[^/]+\/)?(reel|p)\/([A-Za-z0-9_-]+)\/?/);
  const controls = original.controls;
  const indices = Object.fromEntries(["Like", "Comment", "Repost", "Share", "Save"].map((icon) =>
    [icon, controls.findLastIndex((control) => control.icons?.includes(icon))]
  ));
  // The final Like immediately preceding the post Comment/Repost controls is
  // the post toolbar. Earlier Like controls belong to individual comments.
  indices.Like = controls.findLastIndex((control, index) => index < indices.Comment && control.icons?.includes("Like"));
  const metrics = {};
  for (const [icon, key, next] of [["Like", "likes", "Comment"], ["Comment", "comments", "Repost"], ["Share", "shares", "Save"]]) {
    const start = indices[icon];
    if (start < 0) continue;
    const end = indices[next] > start ? indices[next] : controls.length;
    const values = controls.slice(start + 1, end).map((control) => String(control.text ?? "").trim()).filter(Boolean);
    if (values.length === 1 && /^\d[\d,]*$/.test(values[0])) metrics[key] = Number(values[0].replace(/,/g, ""));
  }
  const publicationFooter = instagramPublicationFooter(original);
  const caption = original.caption ?? "";
  const metricReceipt = original.nativeMetricReceipt;
  const likeLabel = String(metricReceipt?.likesLabel ?? "");
  const labelCount = likeLabel.match(/^([\d,]+)\s+likes?$/i)?.[1];
  const captionStart = metricReceipt?.captionStartIndex;
  if (metricReceipt?.mechanism === "native_dialog_pre_caption_like_label_v1" &&
      isVerifiedInstagramNativeCaption({ ...original, text: caption }, instagramNativeAuthorHandle(original)) &&
      Number.isSafeInteger(captionStart) && captionStart >= 0 && labelCount &&
      original.nativeText.slice(0, captionStart) === metricReceipt.prefixVisibleText &&
      original.nativeText.slice(captionStart).startsWith(caption) &&
      metricReceipt.prefixVisibleText.split("\n").filter((line) => line.trim() === likeLabel).length === 1 &&
      Number(labelCount.replace(/,/g, "")) === metricReceipt.likes) {
    if (metrics.likes === undefined || metrics.likes === metricReceipt.likes) metrics.likes = metricReceipt.likes;
    else delete metrics.likes;
  }
  if (metricReceipt?.mechanism === "native_post_liked_by_link_v1" && instagramNativeAuthorHandle(original) &&
      labelCount && Number(labelCount.replace(/,/g, "")) === metricReceipt.likes &&
      String(original.nativeText ?? "").split("\n").some((line) => line.trim() === likeLabel)) {
    try {
      const linked = new URL(metricReceipt.href);
      const postUrl = new URL(linked.href);
      postUrl.pathname = postUrl.pathname.replace(/\/liked_by\/?$/, "/");
      if (/\/liked_by\/?$/.test(linked.pathname) && postPermalink(postUrl.href, nativeShortcode(original.url))) {
        if (metrics.likes === undefined || metrics.likes === metricReceipt.likes) metrics.likes = metricReceipt.likes;
        else delete metrics.likes;
      }
    } catch { /* Invalid native metric links stay unknown. */ }
  }
  const visibleText = (value) => String(value).replace(/\s+/gu, " ").trim();
  return {
    ...original,
    id: match?.[2], kind: match?.[1], authorHandle: instagramNativeAuthorHandle(original),
    text: caption,
    postedAt: publicationFooter?.datetime ?? null,
    publicationTimeReceipt: publicationFooter,
    metrics,
    captionConfirmedVisible: original.captionConfirmedVisible === true && Boolean(visibleText(caption)) && visibleText(original.nativeText ?? "").includes(visibleText(caption))
  };
}
