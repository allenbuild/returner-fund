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
