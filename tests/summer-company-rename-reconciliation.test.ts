import { describe, expect, it } from "vitest";
import summerCompaniesJson from "@/lib/yc/summer-2026-companies.json";
import {
  reconcileLegacySummerEvidenceEntity,
  reconcileLegacySummerGithubAccount,
  SUMMER_COMPANY_ALIAS_LEDGER
} from "@/lib/graph/summer-company-rename-reconciliation";

describe("Summer 2026 company rename reconciliation", () => {
  it("pins every alias chain to the immutable current YC company ID", () => {
    const catalog = summerCompaniesJson as {
      companies: Array<{
        id: string;
        slug: string;
        name: string;
        founders: Array<{ id: string; name: string }>;
      }>;
    };

    for (const alias of SUMMER_COMPANY_ALIAS_LEDGER.aliases) {
      let terminal = alias;
      const seen = new Set<string>();
      while (true) {
        const state = `${terminal.companyId}:${terminal.toSlug}:${terminal.toName}`;
        expect(seen.has(state)).toBe(false);
        seen.add(state);
        const next = SUMMER_COMPANY_ALIAS_LEDGER.aliases.find(
          (candidate) =>
            candidate.companyId === terminal.companyId &&
            candidate.fromSlug === terminal.toSlug &&
            candidate.fromName === terminal.toName
        );
        if (!next) break;
        terminal = next;
      }
      const current = catalog.companies.find((company) => company.id === alias.companyId);
      expect(current).toMatchObject({ slug: terminal.toSlug, name: terminal.toName });
    }
  });

  it("remaps a founder X post only with the immutable founder ID and exact account lineage", () => {
    const decision = reconcileLegacySummerEvidenceEntity({
      batchSlug: "S26",
      entityType: "founder",
      entityId: "founder-blueprints-bence-redmond-2614746",
      companySlug: "blueprints",
      companyName: "Blueprints",
      platform: "x",
      sourceUrl: "https://x.com/BenceRedmond/status/2072886786578321500",
      platformPostId: "2072886786578321500"
    });

    expect(decision.status).toBe("remapped");
    if (decision.status !== "remapped") return;
    expect(decision.physicalId).toBe("x:2072886786578321500");
    expect(decision.row).toMatchObject({
      entityId: "founder-hoplite-bence-redmond-2614746",
      companySlug: "hoplite",
      companyName: "Hoplite"
    });
  });

  it("remaps a historical company X post through the explicit account alias", () => {
    const decision = reconcileLegacySummerEvidenceEntity({
      batchSlug: "S26",
      entityType: "company",
      entityId: "company-bylaw",
      companySlug: "bylaw",
      companyName: "Bylaw",
      platform: "x",
      sourceUrl: "https://x.com/UseBylaw/status/2051128240303955982",
      platformPostId: "2051128240303955982"
    });

    expect(decision.status).toBe("remapped");
    if (decision.status !== "remapped") return;
    expect(decision.row).toMatchObject({
      entityId: "company-definite",
      companySlug: "definite",
      companyName: "Definite"
    });
  });

  it.each([
    {
      label: "wrong immutable founder ID",
      patch: { entityId: "founder-blueprints-bence-redmond-9999999" },
      reason: "legacy_entity_identity_mismatch"
    },
    {
      label: "wrong account",
      patch: { sourceUrl: "https://x.com/not_bence/status/2072886786578321500" },
      reason: "owner_account_lineage_mismatch"
    },
    {
      label: "URL and explicit native IDs disagree",
      patch: { platformPostId: "9999999999999999999" },
      reason: "missing_stable_native_physical_id"
    },
    {
      label: "wrong batch",
      patch: { batchSlug: "S2026" },
      reason: "batch_scope_mismatch"
    }
  ])("quarantines $label instead of name-only remapping", ({ patch, reason }) => {
    const decision = reconcileLegacySummerEvidenceEntity({
      batchSlug: "S26",
      entityType: "founder",
      entityId: "founder-blueprints-bence-redmond-2614746",
      companySlug: "blueprints",
      companyName: "Blueprints",
      platform: "x",
      sourceUrl: "https://x.com/BenceRedmond/status/2072886786578321500",
      platformPostId: "2072886786578321500",
      ...patch
    });

    expect(decision).toMatchObject({ status: "quarantined", reason });
  });

  it("quarantines LinkedIn profile-fragment synthetic post IDs", () => {
    const decision = reconcileLegacySummerEvidenceEntity({
      batchSlug: "S26",
      entityType: "founder",
      entityId: "founder-blueprints-ryan-morrissey-2563241",
      companySlug: "blueprints",
      companyName: "Blueprints",
      platform: "linkedin",
      sourceUrl:
        "https://www.linkedin.com/in/ryan-morrissey-834256271/recent-activity/all/#post-1",
      rawVisibleText:
        "Feed post number 1 Ryan Morrissey • 3rd+ Visible to anyone on or off LinkedIn Follow Original body"
    });

    expect(decision).toMatchObject({
      status: "quarantined",
      reason: "synthetic_linkedin_profile_fragment"
    });
  });

  it("quarantines a stable LinkedIn URL when its body comes from an embedded second card", () => {
    const decision = reconcileLegacySummerEvidenceEntity({
      batchSlug: "S26",
      entityType: "founder",
      entityId: "founder-bylaw-farhan-ur-rehman-1563459",
      companySlug: "bylaw",
      companyName: "Bylaw",
      platform: "linkedin",
      sourceUrl:
        "https://www.linkedin.com/feed/update/urn:li:activity:6924821470124650496/",
      text: "I am happy to announce that my team placed second.",
      rawVisibleText:
        "Feed post number 1 Farhan Ur Rehman • 3rd+ Visible to anyone on or off LinkedIn Follow Great work Brandon D • 3rd+ Visible to anyone on or off LinkedIn Follow I am happy to announce that my team placed second."
    });

    expect(decision).toMatchObject({
      status: "quarantined",
      reason: "embedded_linkedin_body_mismatch"
    });
  });

  it("allows a single-card stable LinkedIn activity for the exact immutable founder", () => {
    const decision = reconcileLegacySummerEvidenceEntity({
      batchSlug: "S26",
      entityType: "founder",
      entityId: "founder-bylaw-farhan-ur-rehman-1563459",
      companySlug: "bylaw",
      companyName: "Bylaw",
      platform: "linkedin",
      sourceUrl:
        "https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/",
      text: "A native founder post.",
      rawVisibleText:
        "Feed post number 1 Farhan Ur Rehman • 3rd+ Visible to anyone on or off LinkedIn Follow A native founder post."
    });

    expect(decision.status).toBe("remapped");
    if (decision.status !== "remapped") return;
    expect(decision.physicalId).toBe("linkedin:7123456789012345678");
    expect(decision.row.entityId).toBe(
      "founder-definite-farhan-ur-rehman-1563459"
    );
  });

  it("remaps historical GitHub account snapshots only for the exact organization", () => {
    const exact = reconcileLegacySummerGithubAccount({
      entityType: "company",
      entityId: "company-bylaw",
      companySlug: "bylaw",
      companyName: "Bylaw",
      githubUrl: "https://github.com/UseBylaw"
    });
    const impostor = reconcileLegacySummerGithubAccount({
      entityType: "company",
      entityId: "company-bylaw",
      companySlug: "bylaw",
      companyName: "Bylaw",
      githubUrl: "https://github.com/not-usebylaw"
    });

    expect(exact).toMatchObject({
      entityId: "company-definite",
      companySlug: "definite",
      companyName: "Definite"
    });
    expect(impostor).toMatchObject({
      entityId: "company-bylaw",
      companySlug: "bylaw",
      companyName: "Bylaw"
    });
  });

  it.each([
    {
      fromSlug: "justinian",
      fromName: "Justinian",
      toSlug: "locke",
      toName: "Locke",
      platform: "linkedin",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/",
      accountUrl: "https://www.linkedin.com/company/justinianai/?viewAsMember=true",
      platformPostId: "7123456789012345678"
    },
    {
      fromSlug: "notyfi",
      fromName: "Notyfi",
      toSlug: "perceptron-ml",
      toName: "Perceptron ML",
      platform: "x",
      sourceUrl: "https://x.com/PerceptronML/status/2070000000000000001",
      accountUrl: "https://x.com/PerceptronML",
      platformPostId: "2070000000000000001"
    },
    {
      fromSlug: "truffle",
      fromName: "Truffle",
      toSlug: "joinmarble",
      toName: "Marble",
      platform: "x",
      sourceUrl: "https://x.com/PinchOfTruffle/status/2070000000000000002",
      accountUrl: "https://x.com/PinchOfTruffle",
      platformPostId: "2070000000000000002"
    }
  ])("remaps the current $fromSlug rename through immutable lineage", (fixture) => {
    const decision = reconcileLegacySummerEvidenceEntity({
      batchSlug: "S26",
      entityType: "company",
      entityId: `company-${fixture.fromSlug}`,
      companySlug: fixture.fromSlug,
      companyName: fixture.fromName,
      platform: fixture.platform,
      sourceUrl: fixture.sourceUrl,
      accountUrl: fixture.accountUrl,
      platformPostId: fixture.platformPostId
    });

    expect(decision.status).toBe("remapped");
    if (decision.status !== "remapped") return;
    expect(decision.row).toMatchObject({
      entityId: `company-${fixture.toSlug}`,
      companySlug: fixture.toSlug,
      companyName: fixture.toName
    });
  });

  it.each(["locke", "perceptron-ml", "joinmarble"])(
    "does not treat the current %s slug as legacy",
    (companySlug) => {
      expect(reconcileLegacySummerEvidenceEntity({
        batchSlug: "S26",
        entityType: "company",
        entityId: `company-${companySlug}`,
        companySlug,
        companyName: companySlug,
        platform: "x"
      }).status).toBe("not_legacy");
    }
  );
});
