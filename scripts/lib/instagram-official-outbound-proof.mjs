export function instagramProfileKey(value) {
  try {
    const url = new URL(value);
    if (!/^(?:www\.)?instagram\.com$/.test(url.hostname) || !/^\/[A-Za-z0-9_.]+\/?$/.test(url.pathname)) return null;
    return url.pathname.replace(/^\/|\/$/g, "").toLowerCase();
  } catch { return null; }
}

export function isOfficialInstagramOutboundReceipt(receipt, company, profileUrl) {
  if (!receipt || receipt.companySlug !== company?.slug || !/^[a-f0-9]{64}$/.test(receipt.htmlSha256 ?? "") || !Number.isFinite(Date.parse(receipt.observedAt))) return false;
  const account = instagramProfileKey(profileUrl);
  if (!account || account !== instagramProfileKey(receipt.instagramUrl) || !/^(?:instagram)?$/i.test(String(receipt.anchorText ?? "").trim())) return false;
  try {
    const hostname = (value) => new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    if (hostname(receipt.officialWebsite) !== hostname(company.websiteUrl)) return false;
    const href = receipt.anchorHtml?.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
    return Boolean(href && instagramProfileKey(new URL(href.replaceAll("&amp;", "&"), receipt.finalWebsiteUrl ?? receipt.officialWebsite).href) === account);
  } catch { return false; }
}
