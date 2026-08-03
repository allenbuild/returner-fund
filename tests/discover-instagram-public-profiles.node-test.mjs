import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assessInstagramPublicProfileOwnership,
  deriveInstagramPublicProfileTargets,
  instagramGlobalCircuitReason,
  mergeVerifiedInstagramOverrides,
  writeVerifiedInstagramOverrides
} from "../scripts/discover-instagram-public-profiles.mjs";

const fetchedAt = "2026-08-02T22:00:00.000Z";

function sampleCatalog() {
  return {
    slug: "S26",
    companies: [
      {
        entityType: "company",
        sourceKey: "company-acme-labs",
        name: "Acme Labs",
        profileUrl: "https://www.ycombinator.com/companies/acme-labs",
        websiteUrl: "https://www.acme.ai/launch?token=discard",
        accounts: [
          {
            platform: "instagram",
            url: "https://www.instagram.com/acme.official/?sessionid=discard",
            discoveredFromUrl: "https://www.acme.ai/?secret=discard",
            reviewState: "verified"
          }
        ],
        founders: [
          {
            entityType: "founder",
            sourceKey: "founder-acme-labs-alice-123",
            name: "Alice Founder",
            websiteUrl: "https://alice.dev/about",
            accounts: [
              {
                platform: "instagram",
                url: "https://instagram.com/alice.builds/",
                discoveredFromUrl: "https://alice.dev/"
              }
            ]
          },
          {
            entityType: "founder",
            sourceKey: "founder-acme-labs-bob-456",
            name: "Bob Name Only",
            websiteUrl: null,
            accounts: []
          }
        ]
      }
    ]
  };
}

function verifiedResult(target, {
  proofKind = "official_external_url_host",
  proofSourceUrl = target.officialWebsiteUrl,
  externalUrl = target.officialWebsiteUrl
} = {}) {
  return {
    target,
    status: "verified",
    reason: "exact_username_and_official_external_url_host",
    fetchedAt,
    ownership: {
      status: "verified",
      externalUrl,
      ownershipProof: {
        kind: proofKind,
        sourceUrl: proofSourceUrl
      }
    },
    profile: {
      verified: true,
      username: target.username,
      accountUrl: target.accountUrl,
      posts: []
    }
  };
}

test("derives at most three exact company candidates and never guesses founder names", () => {
  const withoutFounders = deriveInstagramPublicProfileTargets(sampleCatalog());
  assert.equal(withoutFounders.length, 3);
  assert.deepEqual(
    withoutFounders.map((target) => target.username).sort(),
    ["acme", "acme.official", "acmelabs"]
  );
  assert.ok(withoutFounders.every((target) => target.entityType === "company"));
  assert.doesNotMatch(JSON.stringify(withoutFounders), /discard/);

  const targets = deriveInstagramPublicProfileTargets(sampleCatalog(), {
    includeFounders: true
  });
  const founderTargets = targets.filter((target) => target.entityType === "founder");
  assert.deepEqual(
    founderTargets.map((target) => target.username).sort(),
    ["alice", "alice.builds"]
  );
  assert.ok(founderTargets.every(
    (target) => target.entitySourceKey === "founder-acme-labs-alice-123"
  ));
  assert.equal(targets.some((target) => target.username === "bobnameonly"), false);
  assert.equal(targets.some((target) => target.username === "alicefounder"), false);
});

test("auto-verifies only exact usernames with an existing mapping or exact official host", () => {
  const targets = deriveInstagramPublicProfileTargets(sampleCatalog());
  const mapped = targets.find((target) => target.username === "acme.official");
  const mappedDecision = assessInstagramPublicProfileOwnership({
    target: mapped,
    payload: {
      data: {
        user: {
          username: "ACME.OFFICIAL",
          full_name: "Untrusted display name",
          biography: "Untrusted bio",
          external_url: "https://linktr.ee/acme"
        }
      }
    },
    parsedProfile: { verified: true, username: mapped.username },
    fetchedAt
  });
  assert.equal(mappedDecision.status, "verified");
  assert.equal(mappedDecision.ownershipProof.kind, "existing_snapshot_mapping");

  const domain = targets.find((target) => target.username === "acme");
  const hostDecision = assessInstagramPublicProfileOwnership({
    target: domain,
    payload: {
      data: {
        user: {
          username: "acme",
          external_url: "https://www.acme.ai/pricing?utm_source=instagram"
        }
      }
    },
    parsedProfile: { verified: true, username: domain.username },
    fetchedAt
  });
  assert.equal(hostDecision.status, "verified");
  assert.equal(hostDecision.ownershipProof.kind, "official_external_url_host");
  assert.equal(hostDecision.externalUrl, "https://www.acme.ai/pricing");

  const noOwnership = assessInstagramPublicProfileOwnership({
    target: domain,
    payload: {
      data: {
        user: {
          username: "acme",
          full_name: "Acme Labs",
          biography: "Official Acme account",
          external_url: "https://linktr.ee/acme"
        }
      }
    },
    parsedProfile: { verified: true, username: domain.username },
    fetchedAt
  });
  assert.equal(noOwnership.status, "needs_review");
  assert.equal(noOwnership.reason, "exact_username_without_official_ownership_proof");
  assert.equal(noOwnership.ownershipProof, null);
});

test("opens the global circuit on auth, rate limit, or challenge signals only", () => {
  for (const status of [401, 403, 429]) {
    assert.equal(instagramGlobalCircuitReason({ status }), `http_${status}`);
  }
  assert.equal(
    instagramGlobalCircuitReason({
      status: 200,
      payload: { status: "fail", message: "challenge_required" }
    }),
    "instagram_challenge_or_restriction"
  );
  assert.equal(
    instagramGlobalCircuitReason({
      status: 200,
      payload: { status: "ok", data: { user: { biography: "We challenge assumptions" } } }
    }),
    null
  );
});

test("merges only unambiguous verified ownership while preserving unrelated overrides", () => {
  const targets = deriveInstagramPublicProfileTargets(sampleCatalog());
  const domain = targets.find((target) => target.username === "acme");
  const current = {
    "acme-labs": {
      companySocialLinks: { linkedin: "https://linkedin.com/company/acme" },
      matchReason: "Keep this existing reason.",
      rejectedInstagram: [{ url: "https://instagram.com/wrong/" }]
    },
    untouched: { matchReason: "Do not change." }
  };
  const merged = mergeVerifiedInstagramOverrides(current, [verifiedResult(domain)]);
  assert.equal(merged.promoted.length, 1);
  assert.equal(
    merged.overrides["acme-labs"].companySocialLinks.instagram,
    "https://www.instagram.com/acme/"
  );
  assert.equal(
    merged.overrides["acme-labs"].companySocialLinks.linkedin,
    "https://linkedin.com/company/acme"
  );
  assert.equal(merged.overrides["acme-labs"].matchReason, "Keep this existing reason.");
  assert.deepEqual(merged.overrides.untouched, current.untouched);
  assert.deepEqual(merged.overrides["acme-labs"].rejectedInstagram, current["acme-labs"].rejectedInstagram);

  const alternate = {
    ...domain,
    username: "acmelabs",
    accountUrl: "https://www.instagram.com/acmelabs/"
  };
  const ambiguous = mergeVerifiedInstagramOverrides(current, [
    verifiedResult(domain),
    verifiedResult(alternate)
  ]);
  assert.equal(ambiguous.promoted.length, 0);
  assert.equal(ambiguous.skipped[0].reason, "multiple_verified_instagram_profiles");
  assert.deepEqual(ambiguous.overrides, current);
});

test("hash guard refuses to overwrite a concurrently changed override file", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "instagram-overrides-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "verified-social-overrides.json");
  const original = `${JSON.stringify({ "acme-labs": {} }, null, 2)}\n`;
  await writeFile(path, original);
  const expectedHash = createHash("sha256").update(original).digest("hex");
  const target = deriveInstagramPublicProfileTargets(sampleCatalog())
    .find((candidate) => candidate.username === "acme");

  const concurrent = `${JSON.stringify({ concurrent: { keep: true } }, null, 2)}\n`;
  await writeFile(path, concurrent);
  await assert.rejects(
    writeVerifiedInstagramOverrides({
      overridesPath: path,
      expectedHash,
      results: [verifiedResult(target)]
    }),
    /changed during Instagram discovery/i
  );
  assert.equal(await readFile(path, "utf8"), concurrent);
});
