import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { instagramPublicationFooter } from "./lib/instagram-native-observation.mjs";

const args = process.argv.slice(2);
const value = (name, fallback) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
const write = args.includes("--write");
if (write === args.includes("--dry-run")) throw new Error("Pass exactly one of --write or --dry-run.");
const inputPath = value("--input", "outputs/fall-2026/browser-checkpoints/instagram-all-ui-current.json");
const target = value("--target", "src/lib/social/targeted-evidence-current.json");
const output = value("--output", `outputs/fall-2026/collection/instagram-footer-correction-${Date.now()}`);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const [inputText, beforeText] = await Promise.all([readFile(inputPath, "utf8"), readFile(target, "utf8")]);
const input = JSON.parse(inputText), before = JSON.parse(beforeText);
await mkdir(output, { recursive: false });
await writeFile(resolve(output, "instagram-native-frozen.json"), inputText);
const byId = new Map();
for (const original of input.nativePosts ?? []) {
  const id = String(original.url ?? "").match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)(?:\/|$)/)?.[1];
  const prior = byId.get(id);
  if (id && (!prior || Date.parse(original.observedAt) > Date.parse(prior.observedAt))) byId.set(id, original);
}
const corrections = [], unavailable = [];
const evidence = before.evidence.map((row) => {
  if (row.batchSlug !== "F26" || row.platform !== "instagram") return row;
  const observation = byId.get(row.platformPostId);
  const footer = observation && instagramPublicationFooter(observation);
  if (!footer || !Number.isFinite(Date.parse(observation.observedAt)) || Date.parse(footer.datetime) > Date.parse(observation.observedAt)) {
    unavailable.push({ id: row.id, platformPostId: row.platformPostId, reason: "explicit_native_footer_not_available" }); return row;
  }
  const postedAt = new Date(footer.datetime).toISOString();
  if (Date.parse(row.postedAt) === Date.parse(postedAt)) return row;
  const receipt = {
    source: "authorized_native_instagram_publication_footer_correction_v1",
    sourceArtifact: resolve(output, "instagram-native-frozen.json"), sourceArtifactSha256: sha(inputText),
    observedAt: observation.observedAt, nativePostUrl: observation.url, nativeFooter: footer,
    allNativeTimes: observation.times, nativeObservationSha256: sha(JSON.stringify(observation))
  };
  const raw = JSON.parse(row.rawVisibleText);
  corrections.push({ id: row.id, platformPostId: row.platformPostId, previousPostedAt: row.postedAt, correctedPostedAt: postedAt, receipt });
  return {
    ...row, postedAt, publishedAtPrecision: "exact",
    ...(Date.parse(row.last_updated_at) === Date.parse(row.postedAt) ? { last_updated_at: postedAt } : {}),
    rawVisibleText: JSON.stringify({ ...raw, post: { ...raw.post, postedAt, publicationTimeReceipt: receipt } })
  };
});
const next = { ...before, evidence };
const earlier = (data) => JSON.stringify(data.evidence.filter((row) => row.batchSlug !== "F26"));
if (sha(earlier(before)) !== sha(earlier(next))) throw new Error("Earlier cohort rows changed.");
const audit = { status: write ? "written" : "dry_run", nativeInstagramRows: evidence.filter((row) => row.batchSlug === "F26" && row.platform === "instagram").length, corrected: corrections.length, unavailable: unavailable.length, fullHistoryComplete: false, sourceSha256: sha(inputText), preservedEarlierCohortRows: before.evidence.filter((row) => row.batchSlug !== "F26").length, preservedEarlierCohortSha256: sha(earlier(next)), corrections, unavailableRows: unavailable };
await writeFile(resolve(output, "audit.json"), `${JSON.stringify(audit, null, 2)}\n`);
if (unavailable.length) throw new Error(`Native publication footer unavailable for ${unavailable.length} existing Fall Instagram rows; canonical unchanged.`);
if (write) {
  if (await readFile(target, "utf8") !== beforeText) throw new Error("Canonical evidence changed during preflight.");
  await writeFile(`${target}.tmp`, `${JSON.stringify(next, null, 2)}\n`); await rename(`${target}.tmp`, target);
  await writeFile(resolve(output, "targeted-after.json"), `${JSON.stringify(next, null, 2)}\n`);
  if (target === "src/lib/social/targeted-evidence-current.json") await writeFile("outputs/fall-2026/collection/targeted-evidence-canonical-checkpoint.json", `${JSON.stringify(next, null, 2)}\n`);
}
console.log(JSON.stringify({ ...audit, corrections: undefined, unavailableRows: undefined }));
