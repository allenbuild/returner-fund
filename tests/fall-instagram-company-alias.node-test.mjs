import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildInstagramCompanyAliasIdentity, verifyInstagramCompanyAliasArchive } from "../scripts/lib/instagram-company-alias-proof.mjs";

const company = { slug: "antimattr", websiteUrl: "https://www.antimattr.one/project-mnemosyne" };
const native = () => ({ source: { batchSlug: "F26" }, companySlug: company.slug, profile: { url: "https://www.instagram.com/antimattr.in/", observedAt: "2026-11-16T18:14:02.916Z", text: "antimattr.in\nantimattr (YC F26)\nwww.antimattr.one", links: [{ text: "www.antimattr.one", url: "https://l.instagram.com/?u=https%3A%2F%2Fwww.antimattr.one%2F%3Futm_source%3Dig" }] } });
const make = (artifactBytes, artifactPath = "native.json") => buildInstagramCompanyAliasIdentity({ artifactPath, artifactBytes, company, handle: "antimattr.in", primaryHandle: "antimattr.one" });

test("a second native company account resolves to the same existing company through its exact official-domain link", () => {
  const proof = make(Buffer.from(JSON.stringify(native())));
  assert.equal(proof.entityId, "company-antimattr");
  assert.equal(proof.primaryHandle, "antimattr.one");
  for (const mutate of [
    (row) => { row.profile.url = "https://www.instagram.com/unrelated/"; },
    (row) => { row.profile.links[0].url = "https://antimattr.one.example.com/"; },
    (row) => { row.profile.links = []; },
    (row) => { row.companySlug = "unrelated"; }
  ]) { const row = native(); mutate(row); assert.throws(() => make(Buffer.from(JSON.stringify(row))), /exact profile/); }
});

test("alias admission rehashes the exact native artifact and cannot change the company or primary account", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ig-company-alias-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "native.json"), bytes = Buffer.from(JSON.stringify(native())); await writeFile(path, bytes);
  const identity = make(bytes, path), proof = { entityType: "company", companyAlias: true, handle: "antimattr.in", profileUrl: identity.profileUrl, nativeCompanyAliasIdentity: identity };
  assert.equal(await verifyInstagramCompanyAliasArchive(proof, company, "antimattr.one"), true);
  assert.equal(await verifyInstagramCompanyAliasArchive(proof, company, "another"), false);
  await assert.rejects(verifyInstagramCompanyAliasArchive(proof, { ...company, slug: "unrelated" }, "antimattr.one"), /exact profile/);
  await writeFile(path, JSON.stringify({ ...native(), altered: true }));
  await assert.rejects(verifyInstagramCompanyAliasArchive(proof, company, "antimattr.one"), /SHA changed/);
});
