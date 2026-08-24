import assert from "node:assert/strict";
import test from "node:test";
import {
  extractEmbeddedYouTubeIds,
  extractProductHuntLinks,
  fetchRecentXPostsForTargets,
  searchExaSourceCandidates,
  xUsernameFromUrl
} from "../scripts/lib/credentialed-source-discovery.mjs";

test("extracts strict native source URLs from escaped official launch-page markup", () => {
  const markup = String.raw`
    <iframe src="https:\/\/www.youtube-nocookie.com\/embed\/GI2HtwWodpc?rel=0"></iframe>
    <a href="https://www.producthunt.com/products/lemonlime/launches/lemonlime?ref=yc">Launch</a>
  `;
  assert.deepEqual(extractEmbeddedYouTubeIds(markup), ["GI2HtwWodpc"]);
  assert.deepEqual(extractProductHuntLinks(markup), [
    "https://www.producthunt.com/products/lemonlime/launches/lemonlime"
  ]);
});

test("normalizes only valid X owner handles", () => {
  assert.equal(xUsernameFromUrl("https://x.com/With_Sherpa"), "with_sherpa");
  assert.equal(xUsernameFromUrl("https://twitter.com/joshwqngsr/status/123"), "joshwqngsr");
  assert.equal(xUsernameFromUrl("https://example.com/joshwqngsr"), null);
});

test("batches exact mapped X owners and returns posts keyed by expanded author", async () => {
  const requests = [];
  const result = await fetchRecentXPostsForTargets({
    targets: [
      { accountUrl: "https://x.com/With_Sherpa" },
      { accountUrl: "https://twitter.com/joshwqngsr" }
    ],
    bearerToken: "test-token",
    now: new Date("2026-07-22T12:00:00.000Z"),
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return new Response(JSON.stringify({
        data: [{
          id: "123",
          author_id: "1",
          text: "Shipping today",
          created_at: "2026-07-22T10:00:00.000Z",
          public_metrics: { like_count: 4, reply_count: 1, retweet_count: 2, quote_count: 0 }
        }],
        includes: { users: [{ id: "1", username: "With_Sherpa", name: "Sherpa" }] },
        meta: { result_count: 1 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /tweets\/search\/recent/);
  assert.match(new URL(requests[0].url).searchParams.get("query"), /from:joshwqngsr OR from:with_sherpa/);
  assert.equal(
    new URL(requests[0].url).searchParams.get("start_time"),
    "2026-07-19T12:00:00.000Z"
  );
  assert.equal(requests[0].options.headers.Authorization, "Bearer test-token");
  assert.equal(result.requestCount, 1);
  assert.equal(result.successfulRequestCount, 1);
  assert.equal(result.postsByHandle.get("with_sherpa")[0].id, "123");
});

test("follows bounded X recent-search pagination and preserves posts from later pages", async () => {
  const requests = [];
  const result = await fetchRecentXPostsForTargets({
    targets: [
      { accountUrl: "https://x.com/with_sherpa" },
      { accountUrl: "https://x.com/joshwqngsr" }
    ],
    bearerToken: "test-token",
    now: new Date("2026-07-22T12:00:00.000Z"),
    fetchImpl: async (url) => {
      const requestUrl = new URL(url);
      requests.push(requestUrl);
      const nextToken = requestUrl.searchParams.get("next_token");
      if (!nextToken) {
        return new Response(JSON.stringify({
          data: [{ id: "page-1", author_id: "1", text: "First page" }],
          includes: { users: [{ id: "1", username: "with_sherpa", name: "Sherpa" }] },
          meta: { result_count: 1, next_token: "page-2-token" }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      assert.equal(nextToken, "page-2-token");
      return new Response(JSON.stringify({
        data: [{ id: "page-2", author_id: "2", text: "Second page" }],
        includes: { users: [{ id: "2", username: "joshwqngsr", name: "Josh" }] },
        meta: { result_count: 1 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].searchParams.has("next_token"), false);
  assert.equal(requests[1].searchParams.get("next_token"), "page-2-token");
  assert.equal(result.requestCount, 2);
  assert.equal(result.successfulRequestCount, 2);
  assert.equal(result.postsByHandle.get("with_sherpa")[0].id, "page-1");
  assert.equal(result.postsByHandle.get("joshwqngsr")[0].id, "page-2");
  assert.deepEqual(result.errors, []);
});

test("stops X pagination at the configured safety limit with an explicit partial receipt", async () => {
  const requests = [];
  const result = await fetchRecentXPostsForTargets({
    targets: [{ accountUrl: "https://x.com/with_sherpa" }],
    bearerToken: "test-token",
    maxPagesPerGroup: 2,
    fetchImpl: async (url) => {
      const requestUrl = new URL(url);
      requests.push(requestUrl);
      const page = requests.length;
      return new Response(JSON.stringify({
        data: [{ id: `page-${page}`, author_id: "1", text: `Page ${page}` }],
        includes: { users: [{ id: "1", username: "with_sherpa", name: "Sherpa" }] },
        meta: { result_count: 1, next_token: `page-${page + 1}-token` }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  assert.equal(requests.length, 2);
  assert.equal(result.requestCount, 2);
  assert.equal(result.successfulRequestCount, 2);
  assert.deepEqual(
    result.postsByHandle.get("with_sherpa").map((post) => post.id),
    ["page-1", "page-2"]
  );
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].status, 206);
  assert.match(result.errors[0].reason, /2-page safety limit/);
});

test("uses the documented Exa search contract and preserves evidence snippets", async () => {
  let request;
  const candidates = await searchExaSourceCandidates({
    query: "Zibra Labs LinkedIn native post",
    platform: "linkedin",
    apiKey: "exa-test",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        results: [{
          title: "Zibra Labs on LinkedIn",
          url: "https://www.linkedin.com/posts/zibra-labs_activity-7466956020221722625-jwKO",
          author: "Zibra Labs",
          highlights: ["42 reactions and 3 comments"]
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  assert.equal(request.url, "https://api.exa.ai/search");
  assert.equal(request.options.headers["x-api-key"], "exa-test");
  const body = JSON.parse(request.options.body);
  assert.deepEqual(body.includeDomains, ["linkedin.com/posts", "linkedin.com/feed/update"]);
  assert.equal(body.contents.highlights, true);
  assert.match(candidates[0].snippet, /42 reactions and 3 comments/);
});

test("searches the open web without imposing a social-domain allowlist", async () => {
  let request;
  await searchExaSourceCandidates({
    query: '"Zibra Labs" startup news',
    platform: "web",
    apiKey: "exa-test",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  const body = JSON.parse(request.options.body);
  assert.equal(request.url, "https://api.exa.ai/search");
  assert.equal("includeDomains" in body, false);
  assert.equal(body.numResults, 8);
});
