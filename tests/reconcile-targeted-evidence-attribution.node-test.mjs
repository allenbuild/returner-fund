import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const script = resolve(root, "scripts/reconcile-targeted-evidence-attribution.mjs");
const realInstructions = resolve(
  root,
  "work/targeted-source-hunt-2026-07-24-zero-coverage/company-to-founder-reconciliation-candidates.json"
);
const observedAt = "2026-07-24T12:30:00.000Z";

test("dry-runs all nine company-to-founder reassignments and four comment retirements without writing", async () => {
  const fixture = await fixtureFromRealInstructions();
  const before = await readFile(fixture.target, "utf8");
  const result = run(fixture, "--dry-run");

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const audit = JSON.parse(result.stdout);
  assert.equal(audit.requestedReassignments, 9);
  assert.equal(audit.requestedRetirements, 4);
  assert.equal(audit.reassigned, 9);
  assert.equal(audit.retired, 4);
  assert.equal(audit.errors.length, 0);
  assert.equal(audit.before, 13);
  assert.equal(audit.after, 9);
  assert.equal(await readFile(fixture.target, "utf8"), before);
});

test("write mode reassigns exact native posts, removes comment receipts, and records a deterministic audit", async () => {
  const fixture = await fixtureFromRealInstructions();
  const result = run(fixture, "--write");

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const target = JSON.parse(await readFile(fixture.target, "utf8"));
  assert.equal(target.evidence.length, 9);
  assert.equal(target.source.attributionReconciledAt, observedAt);
  assert.equal(target.source.evidenceCount, 9);
  assert.equal(target.evidence.every((row) => row.entityType === "founder"), true);
  assert.equal(
    target.evidence.every((row) => row.attributionReconciliation?.action === "company_to_founder"),
    true
  );
  assert.equal(
    target.evidence.some((row) => /commenturn|urn%3ali%3acomment/i.test(row.sourceUrl)),
    false
  );

  const instructions = JSON.parse(await readFile(realInstructions, "utf8"));
  for (const instruction of instructions.reassign) {
    const row = target.evidence.find((candidate) =>
      candidate.platformPostId === instruction.platformPostId
    );
    assert.ok(row, instruction.platformPostId);
    assert.equal(row.entityId, instruction.toEntityId);
    assert.equal(row.entityName, instruction.founderName);
    assert.equal(row.last_updated_at, observedAt);
  }
});

test("refuses to write when the source attribution has changed", async () => {
  const fixture = await fixtureFromRealInstructions();
  const target = JSON.parse(await readFile(fixture.target, "utf8"));
  target.evidence[0].entityId = "company-someone-else";
  await writeFile(fixture.target, `${JSON.stringify(target, null, 2)}\n`);
  const before = await readFile(fixture.target, "utf8");

  const result = run(fixture, "--write");
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /source_attribution_changed/);
  assert.equal(await readFile(fixture.target, "utf8"), before);
});

test("refuses to retire an ordinary native post", async () => {
  const folder = await mkdtemp(join(tmpdir(), "reconcile-attribution-"));
  const target = join(folder, "target.json");
  const input = join(folder, "instructions.json");
  const sourceUrl = "https://www.linkedin.com/posts/example_activity-123-example";
  await writeFile(target, `${JSON.stringify({
    source: {},
    evidence: [{
      entityType: "company",
      entityId: "company-lato",
      platform: "linkedin",
      platformPostId: "123",
      sourceUrl
    }]
  }, null, 2)}\n`);
  await writeFile(input, `${JSON.stringify({
    retire: [{
      currentEntityId: "company-lato",
      sourceUrl,
      reason: "not actually a comment"
    }]
  }, null, 2)}\n`);

  const result = run({ target, input }, "--write");
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /retirement_requires_comment_receipt/);
});

async function fixtureFromRealInstructions() {
  const folder = await mkdtemp(join(tmpdir(), "reconcile-attribution-"));
  const target = join(folder, "target.json");
  const input = join(folder, "instructions.json");
  const instructions = JSON.parse(await readFile(realInstructions, "utf8"));
  const evidence = [
    ...instructions.reassign.map((instruction, index) => ({
      id: `native-${index}`,
      entityType: "company",
      entityId: instruction.fromEntityId,
      entityName: instruction.companyName,
      companyName: instruction.companyName,
      platform: instruction.platform,
      platformPostId: instruction.platformPostId,
      sourceUrl: instruction.sourceUrl,
      metrics: instruction.metrics,
      first_seen_at: "2026-07-20T00:00:00.000Z",
      last_updated_at: "2026-07-20T00:00:00.000Z"
    })),
    ...instructions.retire.map((instruction, index) => ({
      id: `comment-${index}`,
      entityType: "company",
      entityId: instruction.currentEntityId,
      entityName: instruction.companyName,
      companyName: instruction.companyName,
      platform: "linkedin",
      platformPostId: `comment-${index}`,
      sourceUrl: instruction.sourceUrl,
      metrics: { reactions: index + 1 },
      first_seen_at: "2026-07-20T00:00:00.000Z",
      last_updated_at: "2026-07-20T00:00:00.000Z"
    }))
  ];
  await writeFile(target, `${JSON.stringify({ source: { label: "fixture" }, evidence }, null, 2)}\n`);
  await writeFile(input, `${JSON.stringify(instructions, null, 2)}\n`);
  return { target, input };
}

function run(fixture, mode) {
  return spawnSync(process.execPath, [
    script,
    `--target=${fixture.target}`,
    `--input=${fixture.input}`,
    `--observed-at=${observedAt}`,
    mode
  ], {
    cwd: root,
    encoding: "utf8"
  });
}
