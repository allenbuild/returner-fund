import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonicalGithubTargetUrl,
  parseGithubTargetUrl,
  sameGithubTargetUrl
} from "../scripts/lib/github-url.mjs";

describe("GitHub target URL canonicalization", () => {
  it("strips a terminal repository .git suffix and transport noise", () => {
    for (const url of [
      "http://github.com/fdmtl/machine0-nixos.git",
      "https://github.com/fdmtl/machine0-nixos.git/",
      "https://www.github.com/fdmtl/machine0-nixos?tab=readme#install",
      "https://github.com/fdmtl/machine0-nixos/"
    ]) {
      assert.equal(
        canonicalGithubTargetUrl(url),
        "https://github.com/fdmtl/machine0-nixos"
      );
      assert.deepEqual(parseGithubTargetUrl(url), {
        login: "fdmtl",
        repo: "machine0-nixos"
      });
    }
  });

  it("canonicalizes GitHub organization URLs without retaining the orgs namespace", () => {
    assert.equal(
      canonicalGithubTargetUrl("https://github.com/orgs/ReviewStage"),
      "https://github.com/ReviewStage"
    );
    assert.deepEqual(parseGithubTargetUrl("https://github.com/orgs/ReviewStage"), {
      login: "ReviewStage",
      repo: null
    });
  });

  it("keeps distinct repositories under one organization distinct", () => {
    assert.equal(
      sameGithubTargetUrl(
        "https://github.com/OpenRelayInc/OpenRelay",
        "https://github.com/OpenRelayInc/orl"
      ),
      false
    );
    assert.equal(
      sameGithubTargetUrl(
        "https://github.com/OpenRelayInc/orl.git",
        "https://github.com/openrelayinc/orl"
      ),
      true
    );
  });

  it("fails closed for malformed and non-GitHub targets", () => {
    for (const url of [
      "",
      "not a url",
      "https://gitlab.com/acme/widget",
      "https://github.example.com/acme/widget",
      "https://github.com/"
    ]) {
      assert.equal(parseGithubTargetUrl(url), null);
      assert.equal(canonicalGithubTargetUrl(url), null);
    }
  });
});
