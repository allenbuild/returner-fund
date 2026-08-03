import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  HistoricalDepthPayloadError,
  parseYouTubeFeed
} from "../scripts/lib/historical-depth-sources.mjs";

const target = {
  accountUrl: "https://youtube.com/channel/UCabc123_-",
  accountId: "UCabc123_-",
  batchSlug: "S26",
  entityType: "company",
  entityId: "company-example",
  entityName: "Example",
  companyId: "company-example",
  companyName: "Example"
};

describe("scheduled YouTube Atom collection", () => {
  it("restores the omitted UC prefix before exact verified-channel matching", () => {
    const parsed = parseYouTubeFeed(feedXml("abc123_-"), { target });
    assert.equal(parsed.channelId, "UCabc123_-");
    assert.equal(parsed.sourceExhausted, true);
    assert.equal(parsed.accepted, 1);
    assert.equal(parsed.evidence[0].nativeId, "video_123");
    assert.equal(parsed.evidence[0].publishedAt, "2026-08-01T12:00:00.000Z");
    assert.deepEqual(parsed.evidence[0].metrics, { views: 42 });
  });

  it("still rejects a genuinely different native channel", () => {
    assert.throws(
      () => parseYouTubeFeed(feedXml("different"), { target }),
      (error) => error instanceof HistoricalDepthPayloadError &&
        error.code === "youtube_feed_channel_mismatch"
    );
  });

  it("keeps the scheduled mapped-account lane uncapped and Atom-backed", async () => {
    const collector = await readFile(
      new URL("../scripts/fetch-public-traction.mjs", import.meta.url),
      "utf8"
    );
    assert.match(collector, /parseYouTubeFeed\(feedBody/);
    assert.match(collector, /youtubeFeedUrl\(channelId\)/);
    assert.doesNotMatch(collector, /parseYouTubeResults\(html\)\.slice\(0,\s*5\)/);
    assert.doesNotMatch(collector, /results\.length\s*<\s*20/);
  });
});

function feedXml(channelId) {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom"
          xmlns:yt="http://www.youtube.com/xml/schemas/2015"
          xmlns:media="http://search.yahoo.com/mrss/">
      <yt:channelId>${channelId}</yt:channelId>
      <entry>
        <yt:videoId>video_123</yt:videoId>
        <title>Recovered upload</title>
        <published>2026-08-01T12:00:00+00:00</published>
        <author><name>Example</name></author>
        <media:group>
          <media:description>Recovered description</media:description>
          <media:statistics views="42" />
        </media:group>
      </entry>
    </feed>`;
}
