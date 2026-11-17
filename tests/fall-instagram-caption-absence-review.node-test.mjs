import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("caption absence requires native empty H1, matching header/footer, and actual post media", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "native-caption-absence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "native.json"), decisions = join(directory, "decisions.json"), output = join(directory, "review.json");
  const header = '<header><a href="https://www.instagram.com/fixture/">fixture</a></header>';
  const native = {
    url: "https://www.instagram.com/p/FixtureID/", caption: "", captionAbsent: true, captionConfirmedVisible: false,
    nativeText: "fixture\nNovember 15", observedAt: "2026-11-16T12:00:00Z",
    nativeAuthorHeader: { mechanism: "native_post_dialog_header_v1", handle: "fixture", profileUrl: "https://www.instagram.com/fixture/", visibleText: "fixture", html: header },
    publicationFooter: { datetime: "2026-11-15T12:00:00Z", href: "https://www.instagram.com/p/FixtureID/" },
    times: [{ datetime: "2026-11-15T12:00:00Z", link: "https://www.instagram.com/p/FixtureID/" }],
    nativeCaptionReceipt: { mechanism: "native_caption_dialog_h1_v1", caption: null, h1Count: 0, unlinkedCaptionTimeCount: 0 },
    dialogHtml: `<div role="dialog">${header}<img src="https://media.example/native.jpg"></div>`,
    controls: [{ icons: ["Like"] }, { icons: ["Comment"] }], media: { images: [{ src: "https://media.example/native.jpg", alt: "Native photo" }], videos: [] }
  };
  await writeFile(decisions, JSON.stringify({ posts: [] }));
  const run = async (post) => {
    await writeFile(input, JSON.stringify({ source: { batchSlug: "F26", platform: "instagram" }, nativePosts: [post] }));
    execFileSync(process.execPath, ["scripts/review-fall-2026-instagram-caption-absence.mjs", `--input=${input}`, `--decisions=${decisions}`, `--output=${output}`], { stdio: "pipe" });
    return JSON.parse(await readFile(output, "utf8"));
  };
  const valid = await run(native);
  assert.equal(valid.accepted.length, 1);
  assert.equal(valid.canonicalOwnerAdmissionNotPerformed, true);
  assert.deepEqual(JSON.parse(await readFile(decisions, "utf8")), { posts: [] });
  for (const post of [
    { ...native, dialogHtml: `${native.dialogHtml}<h1>Hidden original caption</h1>` },
    { ...native, nativeCaptionReceipt: { ...native.nativeCaptionReceipt, unlinkedCaptionTimeCount: 1 } },
    { ...native, media: { images: [{ src: "https://media.example/avatar.jpg", alt: "fixture's profile picture" }], videos: [] } },
    { ...native, publicationFooter: { ...native.publicationFooter, href: "https://www.instagram.com/p/OtherID/" } },
    { ...native, observedAt: "2026-11-14T12:00:00Z" }
  ]) {
    const invalid = await run(post);
    assert.equal(invalid.accepted.length, 0);
    assert.equal(invalid.held.length, 1);
  }
});
