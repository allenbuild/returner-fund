# Returner.fund SEO launch checklist

The codebase now exposes crawlable, server-rendered pages for the main search intents. Google still controls discovery, indexing, and ranking, so deployment and Search Console verification are required to complete the launch.

## 1. Deploy one canonical host

- Keep `https://www.returner.fund` as the Vercel primary domain while the apex permanently redirects there.
- Set `NEXT_PUBLIC_SITE_URL=https://www.returner.fund` in the production environment.
- Deploy and confirm that the following URLs return `200` directly, declare themselves canonical, and contain `index, follow`:
  - `https://www.returner.fund/`
  - `https://www.returner.fund/yc-network-map`
  - `https://www.returner.fund/a16z-network-map`
  - `https://www.returner.fund/yc-social-traction`
  - `https://www.returner.fund/a16z-social-traction`
- Confirm that `https://returner.fund/*` performs one permanent redirect to the matching `www` URL.

## 2. Verify Google Search Console

- Create or verify a Domain property for `returner.fund` using the DNS TXT record supplied by Search Console.
- DNS domain verification is preferred because it covers the apex, `www`, HTTP, and HTTPS together.
- If URL-prefix verification is used instead, set `GOOGLE_SITE_VERIFICATION` to the Search Console HTML-tag token before building and deploying.

## 3. Submit the canonical sitemap

- Submit `https://www.returner.fund/sitemap.xml` in the Search Console Sitemaps report.
- Confirm the status is **Success** and that the discovered URL count is non-zero.
- The sitemap is also advertised from `https://www.returner.fund/robots.txt`.

## 4. Request priority indexing

Use URL Inspection, run **Test live URL**, and request indexing for the homepage plus the four intent pages above. Use the sitemap for the remaining company, founder, cohort, industry, platform, partner, and ranking pages.

## 5. Monitor after deployment

- Recheck after at least one week; a successful submission does not imply immediate indexing or ranking.
- In Page indexing, review `Redirect error`, `Duplicate without user-selected canonical`, `Crawled - currently not indexed`, and `Soft 404` groups.
- In Performance, track impressions and clicks for:
  - `yc network map`
  - `y combinator startup map`
  - `yc social traction`
  - `a16z network map`
  - `a16z speedrun startups`
  - `a16z social traction`
  - `startup social traction rankings`
  - `returner.fund`

## 6. Improve discovery beyond technical SEO

Link the canonical intent pages from public profiles and launch announcements that Returner.fund controls. Earned, relevant links and useful original content are ranking inputs that code and sitemap submission cannot manufacture.

## Official Google references

- [Why a page may be missing from Google Search](https://support.google.com/webmasters/answer/7474347)
- [Submit and monitor a sitemap](https://support.google.com/webmasters/answer/7451001)
- [Inspect a URL and request indexing](https://support.google.com/webmasters/answer/12482179)
- [JavaScript SEO basics](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics)
