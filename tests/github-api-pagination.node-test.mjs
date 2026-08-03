import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fetchGithubCollectionPages,
  githubNextLink
} from "../scripts/lib/github-api-pagination.mjs";

describe("GitHub API collection pagination", () => {
  it("extracts the next relation from GitHub's multi-link header", () => {
    const currentUrl = "https://api.github.com/users/acme/repos?per_page=100&page=1";
    const linkHeader = [
      '<https://api.github.com/users/acme/repos?per_page=100&page=2>; rel="next"',
      '<https://api.github.com/users/acme/repos?per_page=100&page=4>; rel="last"'
    ].join(", ");

    assert.equal(
      githubNextLink(linkHeader, currentUrl),
      "https://api.github.com/users/acme/repos?per_page=100&page=2"
    );
  });

  it("follows Link headers to collect repositories beyond the first 100", async () => {
    const requests = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }));
    const secondPage = Array.from({ length: 25 }, (_, index) => ({ id: index + 101 }));

    const result = await fetchGithubCollectionPages(
      "https://api.github.com/users/acme/repos?sort=updated&per_page=100&type=owner",
      {
        maxPages: 5,
        fetchPage: async (url) => {
          requests.push(url);
          if (requests.length === 1) {
            return {
              data: firstPage,
              headers: new Headers({
                link: '<https://api.github.com/users/acme/repos?sort=updated&per_page=100&type=owner&page=2>; rel="next"'
              })
            };
          }
          return { data: secondPage, linkHeader: null };
        }
      }
    );

    assert.equal(requests.length, 2);
    assert.match(requests[1], /[?&]page=2(?:&|$)/);
    assert.equal(result.items.length, 125);
    assert.equal(result.items.at(-1).id, 125);
    assert.equal(result.pagesFetched, 2);
    assert.equal(result.truncated, false);
    assert.equal(result.nextUrl, null);
  });

  it("stops at the configured bound and reports a remaining next page", async () => {
    const requests = [];
    const result = await fetchGithubCollectionPages(
      "https://api.github.com/users/acme/repos?per_page=100&page=1",
      {
        maxPages: 2,
        fetchPage: async (url) => {
          requests.push(url);
          const page = Number(new URL(url).searchParams.get("page"));
          return {
            data: [{ id: page }],
            linkHeader: `<https://api.github.com/users/acme/repos?per_page=100&page=${page + 1}>; rel="next"`
          };
        }
      }
    );

    assert.deepEqual(result.items, [{ id: 1 }, { id: 2 }]);
    assert.equal(requests.length, 2);
    assert.equal(result.pagesFetched, 2);
    assert.equal(result.truncated, true);
    assert.equal(
      result.nextUrl,
      "https://api.github.com/users/acme/repos?per_page=100&page=3"
    );
  });

  it("rejects a cross-origin next link before requesting it", async () => {
    await assert.rejects(
      fetchGithubCollectionPages("https://api.github.com/users/acme/repos?per_page=100", {
        maxPages: 2,
        fetchPage: async () => ({
          data: [],
          linkHeader: '<https://evil.example/repos?page=2>; rel="next"'
        })
      }),
      /outside https:\/\/api\.github\.com/
    );
  });
});
