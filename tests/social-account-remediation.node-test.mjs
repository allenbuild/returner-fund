import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { preferUniqueSameCompanyFounder } from "../scripts/lib/native-owner-resolution.mjs";
import {
  canonicalSocialAccountUrl,
  socialAccountIdentityKey
} from "../scripts/lib/social-account-url.mjs";

const root = process.cwd();

test("canonical social account identity strips LinkedIn surfaces and rejects wrong hosts", () => {
  assert.equal(
    canonicalSocialAccountUrl("linkedin", "https://www.linkedin.com/company/ConiferBuild/posts/?feedView=all"),
    "https://linkedin.com/company/coniferbuild"
  );
  assert.equal(
    canonicalSocialAccountUrl("linkedin", "https://www.linkedin.com/company/131464079/admin/dashboard/"),
    "https://linkedin.com/company/131464079"
  );
  assert.equal(
    canonicalSocialAccountUrl("linkedin", "https://linkedin.com/in/Safi-Shamsi/recent-activity/all/"),
    "https://linkedin.com/in/safi-shamsi"
  );
  assert.equal(canonicalSocialAccountUrl("linkedin", "https://linked.com/in/openvectorlabs"), null);
  assert.equal(canonicalSocialAccountUrl("linkedin", "https://evillinkedin.com/company/openvectorlabs"), null);
  assert.equal(canonicalSocialAccountUrl("linkedin", "https://linkedin.com/company/posts"), null);
  assert.equal(
    socialAccountIdentityKey("linkedin", "https://www.linkedin.com/company/ConiferBuild/posts/?feedView=all"),
    socialAccountIdentityKey("linkedin", "https://linkedin.com/company/coniferbuild")
  );
});

test("canonical mapped-account URLs preserve identity and reject unsafe hosts", () => {
  assert.equal(
    canonicalSocialAccountUrl("reddit", "https://old.reddit.com/u/Total_Birthday8070/"),
    "https://reddit.com/user/total_birthday8070"
  );
  assert.equal(
    canonicalSocialAccountUrl("reddit", "https://www.reddit.com/r/GrowthHacking/"),
    "https://reddit.com/r/growthhacking"
  );
  for (const url of [
    "https://evilreddit.com/user/a",
    "https://reddit.com.evil.test/user/a",
    "https://reddit.com/r/a/comments/123/post",
    "https://reddit.com/search?q=a",
    "https://redd.it/abc"
  ]) {
    assert.equal(canonicalSocialAccountUrl("reddit", url), null, url);
  }

  assert.equal(
    canonicalSocialAccountUrl("hacker_news", "https://news.ycombinator.com/user?id=Alice"),
    "https://news.ycombinator.com/user?id=Alice"
  );
  assert.notEqual(
    socialAccountIdentityKey("hacker_news", "https://news.ycombinator.com/user?id=Alice"),
    socialAccountIdentityKey("hacker_news", "https://news.ycombinator.com/user?id=Bob")
  );
  assert.equal(canonicalSocialAccountUrl("hacker_news", "https://news.ycombinator.com/item?id=1"), null);
  assert.equal(canonicalSocialAccountUrl("hacker_news", "https://news.ycombinator.com/user"), null);

  assert.equal(
    canonicalSocialAccountUrl("rss", "https://example.com/feed?utm_source=test&feed=rss2"),
    "https://example.com/feed?feed=rss2"
  );
  for (const url of [
    "file:///tmp/feed.xml",
    "https://user:pass@example.com/feed",
    "https://localhost/feed",
    "https://127.0.0.1/feed",
    "https://10.0.0.1/feed",
    "https://example.com:8443/feed"
  ]) {
    assert.equal(canonicalSocialAccountUrl("rss", url), null, url);
  }
});

test("account identities reject encoded delimiters and invalid platform characters", () => {
  const invalidAccounts = [
    ["x", "https://x.com/%2Fsettings"],
    ["x", "https://x.com/foo%3Fadmin"],
    ["x", "https://x.com/foo.bar"],
    ["x", "https://x.com/foo\\bar"],
    ["x", "https://x.com/%2e%2e/settings"],
    ["linkedin", "https://linkedin.com/company/%2Fadmin"],
    ["linkedin", "https://linkedin.com/company/foo%23posts"],
    ["linkedin", "https://linkedin.com/company/foo!bar"],
    ["linkedin", "https://linkedin.com/not-a-namespace/company/acme"],
    ["instagram", "https://instagram.com/%5Cexplore"],
    ["instagram", "https://instagram.com/foo-bar"],
    ["instagram", "https://instagram.com/foo..bar"],
    ["youtube", "https://youtube.com/@foo%2Fvideos"],
    ["youtube", "https://youtube.com/@foo%24bar"],
    ["youtube", "https://youtube.com/channel/%2Fadmin"],
    ["product_hunt", "https://producthunt.com/products/foo%2Fposts"],
    ["product_hunt", "https://producthunt.com/products/foo+bar"],
    ["product_hunt", "https://producthunt.com/posts/not-an-account"],
    ["reddit", "https://reddit.com/user/%2Fcomments"],
    ["reddit", "https://reddit.com/user/foo.bar"],
    ["reddit", "https://reddit.com/%75ser/%2e%2e/comments"],
    ["hacker_news", "https://news.ycombinator.com/user?id=alice%2Fadmin"],
    ["hacker_news", "https://news.ycombinator.com/user?id=alice%3Fadmin"],
    ["hacker_news", "https://news.ycombinator.com/user?id=alice.bob"],
    ["hacker_news", "https://news.ycombinator.com/%75ser%2Fadmin?id=alice"]
  ];

  for (const [platform, url] of invalidAccounts) {
    assert.equal(canonicalSocialAccountUrl(platform, url), null, `${platform}: ${url}`);
  }
});

test("X and Instagram navigation routes are never accepted as account identities", () => {
  const reservedRoutes = [
    ["x", "https://x.com/settings/account"],
    ["x", "https://twitter.com/login?redirect_after_login=%2Fhome"],
    ["x", "https://mobile.twitter.com/messages"],
    ["x", "https://x.com/compose/post"],
    ["x", "https://x.com/Notifications"],
    ["x", "https://x.com/i/flow/login"],
    ["x", "https://x.com/bookmarks"],
    ["x", "https://x.com/communities/explore"],
    ["x", "https://x.com/lists"],
    ["x", "https://x.com/oauth/authorize"],
    ["x", "https://x.com/account/access"],
    ["x", "https://x.com/%73ettings/account"],
    ["instagram", "https://instagram.com/direct/inbox/"],
    ["instagram", "https://www.instagram.com/challenge/"],
    ["instagram", "https://instagram.com/accounts/login/"],
    ["instagram", "https://instagram.com/explore/tags/ai/"],
    ["instagram", "https://instagram.com/reels/"],
    ["instagram", "https://instagram.com/navigation/"],
    ["instagram", "https://instagram.com/settings/"],
    ["instagram", "https://instagram.com/saved/"],
    ["instagram", "https://instagram.com/your_activity/"],
    ["instagram", "https://instagram.com/%64irect/inbox/"],
    ["instagram", "https://instagram.com/p/not-a-profile/"],
    ["instagram", "https://instagram.com/reel/not-a-profile/"],
    ["instagram", "https://instagram.com/stories/not-a-profile/"],
    ["instagram", "https://instagram.com/web/search/topsearch/"]
  ];

  for (const [platform, url] of reservedRoutes) {
    assert.equal(canonicalSocialAccountUrl(platform, url), null, `${platform}: ${url}`);
  }

  assert.equal(
    canonicalSocialAccountUrl("x", "https://x.com/hyperparticle/status/123"),
    "https://x.com/hyperparticle"
  );
  assert.equal(
    canonicalSocialAccountUrl("instagram", "https://instagram.com/tash.cards/reels/"),
    "https://instagram.com/tash.cards"
  );
});

test("canonical account identities are safely encoded while RSS and web semantics remain intact", () => {
  assert.equal(
    canonicalSocialAccountUrl("linkedin", "https://www.linkedin.com/in/PÉTER-Vajda/recent-activity/all/"),
    "https://linkedin.com/in/p%C3%A9ter-vajda"
  );
  assert.equal(
    canonicalSocialAccountUrl("youtube", "https://youtube.com/@Créateur_AI/videos"),
    "https://youtube.com/@cr%C3%A9ateur_ai"
  );
  assert.equal(
    canonicalSocialAccountUrl("product_hunt", "https://producthunt.com/products/ACME-Labs"),
    "https://producthunt.com/products/acme-labs"
  );

  assert.equal(
    canonicalSocialAccountUrl(
      "rss",
      "http://example.com/feed%2Fdaily;v=1/?b=2&a=1&utm_source=x&a=3#fragment"
    ),
    "https://example.com/feed%2Fdaily;v=1/?b=2&a=1&a=3"
  );
  assert.equal(
    canonicalSocialAccountUrl(
      "web",
      "https://example.com/docs%3Farchive/view?cursor=a%2Fb&ref_src=x&cursor=c%2Fd"
    ),
    "https://example.com/docs%3Farchive/view?cursor=a%2Fb&cursor=c%2Fd"
  );
});

test("special-use IP literals are rejected while public IP hosts remain usable", () => {
  const specialUseIpv4 = [
    "0.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "100.127.255.254",
    "127.0.0.1",
    "169.254.1.1",
    "172.31.255.254",
    "192.0.0.1",
    "192.0.2.1",
    "192.31.196.1",
    "192.52.193.1",
    "192.88.99.1",
    "192.168.1.1",
    "192.175.48.1",
    "198.18.0.1",
    "198.19.255.254",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255"
  ];
  for (const host of specialUseIpv4) {
    assert.equal(canonicalSocialAccountUrl("rss", `https://${host}/feed`), null, host);
  }

  for (const host of ["1.1.1.1", "8.8.8.8", "93.184.216.34"]) {
    assert.equal(
      canonicalSocialAccountUrl("rss", `https://${host}/feed`),
      `https://${host}/feed`,
      host
    );
  }
  assert.equal(canonicalSocialAccountUrl("rss", "https://[2001:db8::1]/feed"), null);
  assert.equal(
    canonicalSocialAccountUrl("rss", "https://[2606:4700:4700::1111]/feed"),
    "https://[2606:4700:4700::1111]/feed"
  );
});

test("same-company owner preference selects one explicit founder without weakening ambiguity guards", () => {
  const company = { companySlug: "rekursivai", entityType: "company", entityId: "company-rekursivai" };
  const founder = { companySlug: "rekursivai", entityType: "founder", entityId: "founder-rekursivai-dan" };
  const secondFounder = { companySlug: "rekursivai", entityType: "founder", entityId: "founder-rekursivai-alex" };
  const otherCompany = { companySlug: "other", entityType: "company", entityId: "company-other" };

  assert.deepEqual(preferUniqueSameCompanyFounder([company, founder]), [founder]);
  assert.deepEqual(preferUniqueSameCompanyFounder([company, founder, secondFounder]), [company, founder, secondFounder]);
  assert.deepEqual(preferUniqueSameCompanyFounder([company, founder, otherCompany]), [company, founder, otherCompany]);
});

test("S26 collection plan uses every verified LinkedIn remediation exactly once", () => {
  const plan = JSON.parse(execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S26",
    "--platforms=linkedin",
    "--social=all",
    "--plan"
  ], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));

  const expectedCompanyTargets = new Map([
    ["conifer", "https://linkedin.com/company/coniferbuild"],
    ["egoist-machines", "https://linkedin.com/company/egoistmachines"],
    ["inkbox", "https://linkedin.com/company/inkbox-ai"],
    ["lato", "https://linkedin.com/company/latoio"],
    ["lumeria", "https://linkedin.com/company/lumeriaskin"],
    ["manufacturingintelligence", "https://linkedin.com/company/heraengineer"],
    ["openrelay", "https://linkedin.com/company/131464079"],
    ["openvector", "https://linkedin.com/company/openvectorlabs"],
    ["palette-2", "https://linkedin.com/company/palette-technology"],
    ["praxis-ai-2", "https://linkedin.com/company/130274179"],
    ["stoa", "https://linkedin.com/company/stoaexchange"],
    ["vestris", "https://linkedin.com/company/vestrisai"]
  ]);

  for (const [companySlug, accountUrl] of expectedCompanyTargets) {
    const targets = plan.socialTargets.filter((target) =>
      target.companySlug === companySlug && target.entityType === "company" && target.platform === "linkedin"
    );
    assert.deepEqual(targets.map((target) => target.accountUrl), [accountUrl], companySlug);
  }

  assert.equal(plan.socialTargets.some((target) =>
    /(?:linked\.com|\/admin(?:\/|$)|\/posts(?:\/|$)|company\/(?:107396441|119274035|130104210|latolabs|palette-labs-1|stoamarkets)(?:\/|$))/i
      .test(target.accountUrl)
  ), false);
});

test("Rekursiv collection plan retains only Dan Kondratyuk's explicit X owner mapping", () => {
  const plan = JSON.parse(execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S26",
    "--company=rekursivai",
    "--platforms=x",
    "--social=all",
    "--plan"
  ], { cwd: root, encoding: "utf8" }));

  assert.deepEqual(plan.socialTargets, [{
    companySlug: "rekursivai",
    companyName: "rekursiv.ai",
    entityType: "founder",
    entityId: "founder-rekursivai-dan-kondratyuk-3527564",
    entityName: "Dan Kondratyuk",
    platform: "x",
    accountUrl: "https://x.com/hyperparticle"
  }]);
});

test("S26 X and Instagram routes retain unique targets and required audited mappings", () => {
  const plan = JSON.parse(execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S26",
    "--platforms=x,instagram",
    "--social=all",
    "--plan"
  ], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));

  const targetsByPlatform = Object.groupBy(
    plan.socialTargets,
    (target) => target.platform
  );
  const xTargets = targetsByPlatform.x ?? [];
  const instagramTargets = targetsByPlatform.instagram ?? [];
  assert.ok(xTargets.length > 0);
  assert.ok(instagramTargets.length > 0);
  assert.equal(plan.socialTargets.length, xTargets.length + instagramTargets.length);
  assert.equal(
    new Set(plan.socialTargets.map((target) =>
      `${target.entityType}:${target.entityId}:${target.platform}:${target.accountUrl}`
    )).size,
    plan.socialTargets.length,
    "route hardening must not duplicate an owner/platform/account target"
  );
  const instagramUrls = new Set(instagramTargets.map((target) => target.accountUrl));
  for (const requiredUrl of [
    "https://instagram.com/controlseat",
    "https://instagram.com/egoistmachines",
    "https://instagram.com/gutgutgoose",
    "https://instagram.com/lumeria.skin",
    "https://instagram.com/talentpluto_",
    "https://instagram.com/tash.cards",
    "https://instagram.com/trydockai"
  ]) {
    assert.ok(instagramUrls.has(requiredUrl), `missing audited Instagram route ${requiredUrl}`);
  }
});
