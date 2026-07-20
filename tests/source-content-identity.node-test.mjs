import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  sourceAuthorsCompatible,
  sourceContentIdentity
} from "../scripts/lib/source-content-identity.mjs";

const body = "This is one exact substantive social post body with enough distinct words and characters to qualify for deterministic content identity matching.";

describe("source content author identity precedence", () => {
  it("does not collapse distinct native accounts that share a display name and exact body", () => {
    const first = sourceContentIdentity({
      platform: "x",
      authorName: "John Smith",
      authorHandle: "john_one",
      sourceUrl: "https://x.com/john_one/status/100",
      body,
      postedAt: "2026-07-20T12:00:00Z"
    });
    const second = sourceContentIdentity({
      platform: "x",
      authorName: "John Smith",
      authorHandle: "john_two",
      sourceUrl: "https://twitter.com/john_two/status/101",
      body,
      postedAt: "2026-07-20T12:00:00Z"
    });

    assert.equal(first.authorIdentityStrength, "native_account");
    assert.equal(second.authorIdentityStrength, "native_account");
    assert.equal(sourceAuthorsCompatible(first, second), false);
    assert.ok(first.authorIdentities.includes("name:john smith"));
    assert.ok(second.authorIdentities.includes("name:john smith"));
  });

  it("matches x.com and twitter.com aliases for the same native account", () => {
    const first = sourceContentIdentity({
      platform: "x",
      authorHandle: "same_author",
      sourceUrl: "https://x.com/same_author/status/100",
      body
    });
    const second = sourceContentIdentity({
      platform: "twitter",
      authorHandle: "@same_author",
      sourceUrl: "https://twitter.com/same_author/status/101",
      body
    });

    assert.equal(sourceAuthorsCompatible(first, second), true);
  });

  it("uses an exact display name only when neither row has native account identity", () => {
    const first = sourceContentIdentity({ platform: "linkedin", authorName: "Fallback Person", body });
    const second = sourceContentIdentity({ platform: "linkedin", authorName: "Fallback Person", body });

    assert.equal(first.authorIdentityStrength, "display_name_fallback");
    assert.equal(sourceAuthorsCompatible(first, second), true);
  });

  it("permits exact-name fallback when only one side exposes a native identity", () => {
    const legacy = sourceContentIdentity({
      platform: "linkedin",
      authorName: "Daniela Muñoz",
      authorUrl: "https://linkedin.com/in/daniela-munoz",
      body
    });
    const native = sourceContentIdentity({ platform: "linkedin", authorName: "Daniela Muñoz", body });

    assert.equal(sourceAuthorsCompatible(legacy, native), true);
  });
});
