import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopStoriesDashboard } from "@/components/dashboard/TopStoriesDashboard";
import {
  DASHBOARD_SCHEMA_VERSION,
  type DashboardPublicFeedSnapshot,
  type DashboardStoryCard,
  type DashboardStoryPrimarySource,
  type DashboardStorySource,
  type DashboardViewRanking
} from "@/lib/dashboard/contracts";

describe("TopStoriesDashboard", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders one consolidated Top 100 card grid without a separate dashboard hero", () => {
    const fetchSources = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        stableKey: "story-atlas",
        sourceCount: 2,
        truncated: false,
        sources: [
          primarySource(source("atlas-x", "x", "Atlas Runtime launch", "https://example.com/atlas-launch")),
          primarySource(source("atlas-hn", "hacker_news", "Show HN: Atlas Runtime", "https://news.ycombinator.com/item?id=atlas"))
        ]
      })
    });
    vi.stubGlobal("fetch", fetchSources);

    render(<TopStoriesDashboard snapshot={snapshotFixture()} />);

    expect(screen.getByRole("heading", { name: "Top 100 from the last 72 hours" })).toBeInTheDocument();
    expect(screen.getByLabelText("Top 100 eligibility")).toHaveTextContent("Rolling 72 hours");
    expect(screen.getByLabelText("Top 100 eligibility")).toHaveTextContent("1M+ views");
    expect(screen.getByLabelText("2 qualifying results")).toBeInTheDocument();
    expect(screen.getByText("Exactly how stories are surfaced")).toBeInTheDocument();
    expect(screen.getByText("1M+ viral")).toBeInTheDocument();
    expect(screen.getByText("News")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Surfacing score 88 out of 100")).toHaveLength(2);
    expect(screen.getByRole("list", { name: "Top 100 technology stories" })).toBeInTheDocument();
    expect(screen.getByText("Atlas launches an agent runtime")).toBeInTheDocument();
    expect(screen.getByText("Industry research paper rises")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Top 100 in Tech" })).not.toBeInTheDocument();
    expect(screen.queryByText(/single 24-hour index/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Breaking security release accelerates")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hottest" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Breaking" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Emerging" })).not.toBeInTheDocument();
    expect(screen.queryByText("Universe")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Item 4")).toBeInTheDocument();
    expect(screen.getByLabelText("Atlas launches an agent runtime thumbnail")).toBeInTheDocument();
    expect(screen.getAllByText("1.6M views").length).toBeGreaterThan(0);
    expect(screen.getAllByText("12.4K likes").length).toBeGreaterThan(0);
    expect(screen.getAllByText("544 comments").length).toBeGreaterThan(0);
    expect(screen.queryByText("125K views")).not.toBeInTheDocument();
    expect(fetchSources).not.toHaveBeenCalled();
  });

  it("uses the map canvas and detail panel for article selection and sources", async () => {
    const fetchSources = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        stableKey: "story-atlas",
        sourceCount: 2,
        truncated: false,
        sources: [
          primarySource(source("atlas-x", "x", "Atlas Runtime launch", "https://example.com/atlas-launch")),
          primarySource(source("atlas-hn", "hacker_news", "Show HN: Atlas Runtime", "https://news.ycombinator.com/item?id=atlas"))
        ]
      })
    });
    vi.stubGlobal("fetch", fetchSources);

    render(<TopStoriesDashboard snapshot={snapshotFixture()} variant="network-map" />);

    const detail = screen.getByLabelText("Article details");
    expect(detail).toHaveClass("node-panel");
    expect(within(detail).getByRole("heading", { name: "Atlas launches an agent runtime" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show Industry research paper rises" }));
    expect(within(detail).getByRole("heading", { name: "Industry research paper rises" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show Atlas launches an agent runtime" }));
    const details = screen.getByText("View 2 underlying sources").closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    fireEvent.click(within(details).getByText("View 2 underlying sources"));
    expect(details.open).toBe(true);
    await waitFor(() => expect(fetchSources).toHaveBeenCalledWith(
      "/api/dashboard/stories/story-atlas/sources",
      expect.objectContaining({
        headers: { Accept: "application/json" },
        signal: expect.any(AbortSignal)
      })
    ));
    expect(await within(details).findByRole("link", { name: /Atlas Runtime launch/i })).toHaveAttribute(
      "href",
      "https://example.com/atlas-launch"
    );
  });

  it("resets source details and aborts the stale story request when selection changes", async () => {
    let resolveAtlas: ((value: { ok: true; json: () => Promise<unknown> }) => void) | undefined;
    let atlasSignal: AbortSignal | undefined;
    const atlasRequest = new Promise<{ ok: true; json: () => Promise<unknown> }>((resolve) => {
      resolveAtlas = resolve;
    });
    const paperDetail = source("paper-detail", "research", "Current paper source", "https://arxiv.org/abs/9999.9999");
    const fetchSources = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/story-atlas/sources")) {
        atlasSignal = init?.signal ?? undefined;
        return atlasRequest;
      }
      if (url.endsWith("/story-paper/sources")) {
        return Promise.resolve({
          ok: true as const,
          json: async () => ({
            stableKey: "story-paper",
            sourceCount: 1,
            truncated: false,
            sources: [paperDetail]
          })
        });
      }
      return Promise.resolve({ ok: false as const, json: async () => null });
    });
    vi.stubGlobal("fetch", fetchSources);

    render(<TopStoriesDashboard snapshot={snapshotFixture()} variant="network-map" />);

    fireEvent.click(screen.getByText("View 2 underlying sources"));
    await waitFor(() => expect(fetchSources).toHaveBeenCalledTimes(1));
    expect(atlasSignal?.aborted).toBe(false);
    expect(screen.getByText("Loading sources…")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show Industry research paper rises" }));
    expect(atlasSignal?.aborted).toBe(true);
    expect(screen.queryByText("Loading sources…")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("View 1 underlying source"));
    expect(await screen.findByRole("link", { name: /Current paper source/i })).toHaveAttribute(
      "href",
      "https://arxiv.org/abs/9999.9999"
    );

    await act(async () => {
      resolveAtlas?.({
        ok: true,
        json: async () => ({
          stableKey: "story-atlas",
          sourceCount: 1,
          truncated: false,
          sources: [source("stale-atlas", "x", "Stale Atlas source", "https://example.com/stale-atlas")]
        })
      });
      await Promise.resolve();
    });
    expect(screen.queryByText("Stale Atlas source")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Current paper source/i })).toBeInTheDocument();
  });

  it("recovers a stale empty server render with one current public feed request", async () => {
    const emptySnapshot = unavailableSnapshotFixture();
    const fetchDashboard = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => currentSnapshotFixture()
    });
    vi.stubGlobal("fetch", fetchDashboard);

    render(<TopStoriesDashboard snapshot={emptySnapshot} />);

    expect(screen.getByText("Loading articles…")).toBeInTheDocument();
    expect(await screen.findByText("Atlas launches an agent runtime")).toBeInTheDocument();
    expect(fetchDashboard).toHaveBeenCalledTimes(1);
    expect(fetchDashboard).toHaveBeenCalledWith(
      "/api/dashboard",
      expect.objectContaining({
        cache: "no-store",
        headers: { Accept: "application/json" }
      })
    );
    expect(screen.queryByText("Loading articles…")).not.toBeInTheDocument();
  });

  it("rejects a recovery response beyond the retained last-publication window", async () => {
    const emptySnapshot = unavailableSnapshotFixture();
    const staleSnapshot = currentSnapshotFixture(new Date(Date.now() - 49 * 60 * 60 * 1_000));
    const fetchDashboard = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => staleSnapshot
    });
    vi.stubGlobal("fetch", fetchDashboard);

    render(<TopStoriesDashboard snapshot={emptySnapshot} />);

    await waitFor(() => expect(fetchDashboard).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Loading articles…")).toBeInTheDocument();
    expect(screen.queryByText("Atlas launches an agent runtime")).not.toBeInTheDocument();
  });

  it("rejects an unavailable nonempty recovery response", async () => {
    const unavailableSnapshot = currentSnapshotFixture();
    unavailableSnapshot.status = {
      ...unavailableSnapshot.status,
      partialPlatformFailures: ["snapshot_unavailable"]
    };
    const fetchDashboard = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => unavailableSnapshot
    });
    vi.stubGlobal("fetch", fetchDashboard);

    render(<TopStoriesDashboard snapshot={unavailableSnapshotFixture()} />);

    await waitFor(() => expect(fetchDashboard).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Loading articles…")).toBeInTheDocument();
    expect(screen.queryByText("Atlas launches an agent runtime")).not.toBeInTheDocument();
  });

  it("rejects a malformed recovery response", async () => {
    const malformedSnapshot = {
      ...currentSnapshotFixture(),
      sourceSnapshotFingerprint: ""
    };
    const fetchDashboard = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => malformedSnapshot
    });
    vi.stubGlobal("fetch", fetchDashboard);

    render(<TopStoriesDashboard snapshot={unavailableSnapshotFixture()} />);

    await waitFor(() => expect(fetchDashboard).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Loading articles…")).toBeInTheDocument();
    expect(screen.queryByText("Atlas launches an agent runtime")).not.toBeInTheDocument();
  });

  it("keeps the safe empty state when the recovery feed has no published stories", async () => {
    const emptySnapshot = unavailableSnapshotFixture();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => emptySnapshot
    }));

    render(<TopStoriesDashboard snapshot={emptySnapshot} />);

    expect(screen.getByText("Loading articles…")).toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Atlas launches an agent runtime")).not.toBeInTheDocument();
  });

  it("keeps the compact loading state when a stale empty snapshot cannot recover", () => {
    const snapshot = snapshotFixture();
    snapshot.stories = [];
    snapshot.status = {
      ...snapshot.status,
      eligibleCandidateCount: 0,
      storyCount: 0,
      viewStoryCounts: { hottest: 0, breaking: 0, emerging: 0 },
      partialPlatformFailures: ["snapshot_stale"]
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: async () => null
    }));

    render(<TopStoriesDashboard snapshot={snapshot} />);

    expect(screen.getByText("Loading articles…")).toBeInTheDocument();
  });

  it("explains a truthful empty strict-gate result without adding stale filler", () => {
    const snapshot = snapshotFixture();
    snapshot.stories = [];
    snapshot.status = {
      ...snapshot.status,
      eligibleCandidateCount: 0,
      storyCount: 0,
      viewStoryCounts: { hottest: 0, breaking: 0, emerging: 0 },
      partialPlatformFailures: []
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

    render(<TopStoriesDashboard snapshot={snapshot} />);

    expect(screen.getByText("No items clear the strict 72-hour surfacing gates yet.")).toBeInTheDocument();
    expect(screen.getByText(/Older or lower-reach items are deliberately not used as filler/i)).toBeInTheDocument();
  });

  it("keeps a nonempty last publication visible", () => {
    const snapshot = snapshotFixture();
    snapshot.status = {
      ...snapshot.status,
      partialPlatformFailures: ["snapshot_stale"]
    };

    render(<TopStoriesDashboard snapshot={snapshot} />);

    expect(screen.getByText("Atlas launches an agent runtime")).toBeInTheDocument();
  });

  it("recovers an unavailable empty render with a retained nonempty publication", async () => {
    const retainedSnapshot = currentSnapshotFixture();
    retainedSnapshot.status.partialPlatformFailures = ["snapshot_stale"];
    const fetchDashboard = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => retainedSnapshot
    });
    vi.stubGlobal("fetch", fetchDashboard);

    render(<TopStoriesDashboard snapshot={unavailableSnapshotFixture()} />);

    await waitFor(() => expect(fetchDashboard).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Atlas launches an agent runtime")).toBeInTheDocument();
    expect(screen.queryByText("Loading articles…")).not.toBeInTheDocument();
  });

  it("revalidates a visible open dashboard every five minutes and accepts equal or newer publications", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T12:10:00.000Z"));
    const initialSnapshot = titledSnapshot("2026-09-07T12:05:00.000Z", "Initial publication");
    const equalSnapshot = titledSnapshot("2026-09-07T12:05:00.000Z", "Equal-clock publication");
    const newerSnapshot = titledSnapshot("2026-09-07T12:15:00.000Z", "Newer publication");
    const fetchDashboard = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => equalSnapshot })
      .mockResolvedValueOnce({ ok: true, json: async () => newerSnapshot });
    vi.stubGlobal("fetch", fetchDashboard);

    render(<TopStoriesDashboard snapshot={initialSnapshot} />);

    expect(fetchDashboard).not.toHaveBeenCalled();
    expect(screen.getByText("Initial publication")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
    });
    expect(fetchDashboard).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Equal-clock publication")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
    });
    expect(fetchDashboard).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Newer publication")).toBeInTheDocument();
  });

  it("replaces a stale nonempty feed with a newer canonical empty publication", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T12:10:00.000Z"));
    const emptyPublication = emptySnapshotAt("2026-09-07T12:10:00.000Z");
    const fetchDashboard = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => emptyPublication
    });
    vi.stubGlobal("fetch", fetchDashboard);

    render(<TopStoriesDashboard snapshot={titledSnapshot("2026-09-07T12:05:00.000Z", "Stale publication")} />);
    expect(screen.getByText("Stale publication")).toBeInTheDocument();

    window.dispatchEvent(new Event("focus"));
    await act(async () => Promise.resolve());

    expect(fetchDashboard).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Stale publication")).not.toBeInTheDocument();
    expect(screen.getByText("No items clear the strict 72-hour surfacing gates yet.")).toBeInTheDocument();
    expect(screen.queryByText("Loading articles…")).not.toBeInTheDocument();
  });

  it("does not replace a last-good publication with a newer stale empty response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T12:10:00.000Z"));
    const fetchDashboard = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => emptySnapshotAt("2026-09-07T12:10:00.000Z", "snapshot_stale")
    });
    vi.stubGlobal("fetch", fetchDashboard);

    render(<TopStoriesDashboard snapshot={titledSnapshot("2026-09-07T12:05:00.000Z", "Last-good publication")} />);
    window.dispatchEvent(new Event("focus"));
    await act(async () => Promise.resolve());

    expect(fetchDashboard).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Last-good publication")).toBeInTheDocument();
    expect(screen.queryByText("No items clear the strict 72-hour surfacing gates yet.")).not.toBeInTheDocument();
  });

  it("promotes newer supplied publications and never rolls back through unavailable or older props", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T12:20:00.000Z"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => null }));
    const publicationA = titledSnapshot("2026-09-07T12:05:00.000Z", "Publication A");
    const publicationB = titledSnapshot("2026-09-07T12:10:00.000Z", "Publication B");
    const unavailable = emptySnapshotAt("2026-09-07T12:15:00.000Z", "snapshot_unavailable");
    const unavailableWithStories = titledSnapshot("2026-09-07T12:16:00.000Z", "Unavailable publication");
    unavailableWithStories.status.partialPlatformFailures = ["snapshot_unavailable"];
    const emptyPublication = emptySnapshotAt("2026-09-07T12:20:00.000Z");
    const { rerender } = render(<TopStoriesDashboard snapshot={publicationA} />);

    rerender(<TopStoriesDashboard snapshot={publicationB} />);
    expect(screen.getByText("Publication B")).toBeInTheDocument();

    rerender(<TopStoriesDashboard snapshot={unavailable} />);
    await act(async () => Promise.resolve());
    expect(screen.getByText("Publication B")).toBeInTheDocument();

    rerender(<TopStoriesDashboard snapshot={unavailableWithStories} />);
    expect(screen.getByText("Publication B")).toBeInTheDocument();
    expect(screen.queryByText("Unavailable publication")).not.toBeInTheDocument();

    rerender(<TopStoriesDashboard snapshot={publicationA} />);
    expect(screen.getByText("Publication B")).toBeInTheDocument();
    expect(screen.queryByText("Publication A")).not.toBeInTheDocument();

    rerender(<TopStoriesDashboard snapshot={emptyPublication} />);
    expect(screen.queryByText("Publication B")).not.toBeInTheDocument();
    expect(screen.getByText("No items clear the strict 72-hour surfacing gates yet.")).toBeInTheDocument();

    rerender(<TopStoriesDashboard snapshot={unavailable} />);
    expect(screen.queryByText("Publication B")).not.toBeInTheDocument();
    expect(screen.getByText("No items clear the strict 72-hour surfacing gates yet.")).toBeInTheDocument();
  });

  it("refreshes immediately on visible resume, skips hidden work, and deduplicates resume requests for 60 seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T12:10:00.000Z"));
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    const refreshedSnapshot = titledSnapshot("2026-09-07T12:10:00.000Z", "Visible publication");
    const fetchDashboard = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => refreshedSnapshot
    });
    vi.stubGlobal("fetch", fetchDashboard);

    render(<TopStoriesDashboard snapshot={titledSnapshot("2026-09-07T12:05:00.000Z", "Initial publication")} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
    });
    window.dispatchEvent(new Event("focus"));
    await act(async () => Promise.resolve());
    expect(fetchDashboard).not.toHaveBeenCalled();

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => Promise.resolve());
    expect(fetchDashboard).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Visible publication")).toBeInTheDocument();

    window.dispatchEvent(new Event("focus"));
    await act(async () => Promise.resolve());
    expect(fetchDashboard).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999);
    });
    window.dispatchEvent(new Event("focus"));
    await act(async () => Promise.resolve());
    expect(fetchDashboard).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    window.dispatchEvent(new Event("focus"));
    await act(async () => Promise.resolve());
    expect(fetchDashboard).toHaveBeenCalledTimes(2);
  });

  it("keeps the newest last-good publication and aborts an in-flight revalidation on cleanup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T12:10:00.000Z"));
    const initialSnapshot = titledSnapshot("2026-09-07T12:05:00.000Z", "Initial publication");
    const newerSnapshot = titledSnapshot("2026-09-07T12:10:00.000Z", "Newest publication");
    const olderSnapshot = titledSnapshot("2026-09-07T12:04:00.000Z", "Older publication");
    const malformedSnapshot = titledSnapshot("2026-09-07T12:11:00.000Z", "Malformed publication");
    malformedSnapshot.sourceSnapshotFingerprint = "";
    let pendingSignal: AbortSignal | undefined;
    const fetchDashboard = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => newerSnapshot })
      .mockResolvedValueOnce({ ok: true, json: async () => olderSnapshot })
      .mockResolvedValueOnce({ ok: true, json: async () => malformedSnapshot })
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
        pendingSignal = init?.signal ?? undefined;
        return new Promise(() => undefined);
      });
    vi.stubGlobal("fetch", fetchDashboard);

    const { unmount } = render(<TopStoriesDashboard snapshot={initialSnapshot} />);

    window.dispatchEvent(new Event("focus"));
    await act(async () => Promise.resolve());
    expect(screen.getByText("Newest publication")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    window.dispatchEvent(new Event("focus"));
    await act(async () => Promise.resolve());
    expect(fetchDashboard).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Newest publication")).toBeInTheDocument();
    expect(screen.queryByText("Older publication")).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    window.dispatchEvent(new Event("focus"));
    await act(async () => Promise.resolve());
    expect(fetchDashboard).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Newest publication")).toBeInTheDocument();
    expect(screen.queryByText("Malformed publication")).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    window.dispatchEvent(new Event("focus"));
    expect(fetchDashboard).toHaveBeenCalledTimes(4);
    expect(pendingSignal?.aborted).toBe(false);

    window.dispatchEvent(new Event("focus"));
    expect(fetchDashboard).toHaveBeenCalledTimes(4);

    unmount();
    expect(pendingSignal?.aborted).toBe(true);
  });

  it("times out a hung revalidation and permits a later retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T12:10:00.000Z"));
    let hungSignal: AbortSignal | undefined;
    const recoveredSnapshot = titledSnapshot("2026-09-07T12:11:00.000Z", "Recovered publication");
    const fetchDashboard = vi.fn()
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
        hungSignal = init?.signal ?? undefined;
        return new Promise(() => undefined);
      })
      .mockResolvedValueOnce({ ok: true, json: async () => recoveredSnapshot });
    vi.stubGlobal("fetch", fetchDashboard);

    render(<TopStoriesDashboard snapshot={titledSnapshot("2026-09-07T12:05:00.000Z", "Initial publication")} />);

    window.dispatchEvent(new Event("focus"));
    expect(fetchDashboard).toHaveBeenCalledTimes(1);
    expect(hungSignal?.aborted).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(hungSignal?.aborted).toBe(true);

    window.dispatchEvent(new Event("focus"));
    await act(async () => Promise.resolve());

    expect(fetchDashboard).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Recovered publication")).toBeInTheDocument();
  });

  it("uses canonical hottest ranks as the sole Top 100 ordering", () => {
    render(<TopStoriesDashboard snapshot={snapshotFixture()} />);

    expect(screen.getByText("Atlas launches an agent runtime")).toBeInTheDocument();
    expect(screen.getByText("Industry research paper rises")).toBeInTheDocument();
    expect(screen.queryByText("Breaking security release accelerates")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Item 4")).toBeInTheDocument();
    expect(screen.getByLabelText("Item 12")).toBeInTheDocument();
  });

  it("uses source kind, not platform alone, for the Top 100 content label", () => {
    const snapshot = snapshotFixture();
    const articleStory = snapshot.stories[0]!;
    articleStory.primarySource = {
      ...articleStory.primarySource!,
      sourceKind: "article",
      metrics: {}
    };
    snapshot.stories = [articleStory];
    snapshot.status = {
      ...snapshot.status,
      storyCount: 1,
      viewStoryCounts: { hottest: 1, breaking: 0, emerging: 0 }
    };

    render(<TopStoriesDashboard snapshot={snapshot} />);

    const card = screen.getByText("Atlas launches an agent runtime").closest("article");
    expect(card).not.toBeNull();
    expect(within(card!).getByText("News")).toBeInTheDocument();
    expect(within(card!).queryByText("1M+ viral")).not.toBeInTheDocument();
  });
});

function snapshotFixture(): DashboardPublicFeedSnapshot {
  return {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    sourceSnapshotFingerprint: "dsh-test-snapshot",
    generatedAt: "2026-08-15T12:00:00.000Z",
    updatedAt: "2026-08-15T12:00:00.000Z",
    windowStart: "2026-08-12T12:00:00.000Z",
    windowEnd: "2026-08-15T12:00:00.000Z",
    todayInTech: ["A new agent runtime is attracting developer discussion."],
    stories: [
      story({
        id: "atlas",
        rank: 4,
        universe: "returner",
        labels: ["YC S26"],
        title: "Atlas launches an agent runtime",
        summary: "Atlas released an orchestration runtime that is drawing independent discussion across X, Hacker News, and YouTube.",
        topics: ["ai", "launches"],
        platforms: ["x", "hacker_news", "youtube"],
        sourceCount: 2,
        primarySource: primarySource(source("atlas-x", "x", "Atlas Runtime launch", "https://example.com/atlas-launch"))
      }),
      story({
        id: "paper",
        rank: 12,
        universe: "industry",
        title: "Industry research paper rises",
        summary: "A visual world-model paper is gaining attention after researchers shared its robotics results.",
        topics: ["research", "robotics"],
        platforms: ["research", "news"],
        sourceCount: 1,
        primarySource: primarySource(source("paper-source", "research", "Visual world-model paper", "https://arxiv.org/abs/1234.5678"))
      }),
      story({
        id: "breaking-release",
        rank: 56,
        universe: "industry",
        title: "Breaking security release accelerates",
        summary: "A security release is receiving rapid discussion after independent developers flagged its newly published remediation guidance.",
        topics: ["open_source"],
        platforms: ["news", "hacker_news"],
        sourceCount: 1,
        viewRankings: {
          breaking: viewRanking(1, { rankDelta: 9, trendStatus: "rising_fast" })
        },
        primarySource: primarySource(source("breaking-release-source", "news", "Security release", "https://example.com/security-release"))
      })
    ],
    availableFilters: {
      topics: ["ai", "launches", "research", "robotics"],
      platforms: ["x", "hacker_news", "youtube", "research", "news"]
    },
    status: {
      candidateCount: 3,
      eligibleCandidateCount: 3,
      storyCount: 3,
      viewStoryCounts: { hottest: 2, breaking: 1, emerging: 0 },
      partialPlatformFailures: []
    }
  };
}

function unavailableSnapshotFixture(): DashboardPublicFeedSnapshot {
  const snapshot = snapshotFixture();
  snapshot.stories = [];
  snapshot.status = {
    ...snapshot.status,
    storyCount: 0,
    viewStoryCounts: { hottest: 0, breaking: 0, emerging: 0 },
    partialPlatformFailures: ["snapshot_unavailable"]
  };
  return snapshot;
}

function currentSnapshotFixture(now = new Date()): DashboardPublicFeedSnapshot {
  const snapshot = snapshotFixture();
  const windowEnd = now.toISOString();
  snapshot.generatedAt = windowEnd;
  snapshot.updatedAt = windowEnd;
  snapshot.windowEnd = windowEnd;
  snapshot.windowStart = new Date(now.getTime() - 72 * 60 * 60 * 1_000).toISOString();
  return snapshot;
}

function titledSnapshot(windowEnd: string, title: string): DashboardPublicFeedSnapshot {
  const snapshot = currentSnapshotFixture(new Date(windowEnd));
  snapshot.sourceSnapshotFingerprint = `dsh-${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
  snapshot.stories[0]!.title = title;
  return snapshot;
}

function emptySnapshotAt(
  windowEnd: string,
  failure?: "snapshot_stale" | "snapshot_unavailable"
): DashboardPublicFeedSnapshot {
  const snapshot = currentSnapshotFixture(new Date(windowEnd));
  snapshot.sourceSnapshotFingerprint = `dsh-empty-${windowEnd}`;
  snapshot.stories = [];
  snapshot.status = {
    candidateCount: 0,
    eligibleCandidateCount: 0,
    storyCount: 0,
    viewStoryCounts: { hottest: 0, breaking: 0, emerging: 0 },
    partialPlatformFailures: failure ? [failure] : []
  };
  return snapshot;
}

function story(overrides: Pick<DashboardStoryCard, "id" | "rank" | "universe" | "title" | "summary" | "topics" | "platforms" | "sourceCount" | "primarySource"> & {
  labels?: string[];
  viewRankings?: DashboardStoryCard["viewRankings"];
}): DashboardStoryCard {
  return {
    id: overrides.id,
    stableKey: "story-" + overrides.id,
    rank: overrides.rank,
    previousRank: null,
    rankDelta: null,
    trendStatus: "rising",
    viewRankings: overrides.viewRankings ?? { hottest: viewRanking(overrides.rank) },
    title: overrides.title,
    summary: overrides.summary,
    thumbnailUrl: null,
    thumbnailAlt: null,
    universe: overrides.universe,
    labels: overrides.labels ?? [],
    topics: overrides.topics,
    platforms: overrides.platforms,
    publishedAt: "2026-08-15T10:00:00.000Z",
    updatedAt: "2026-08-15T12:00:00.000Z",
    trendScore: 88,
    sourceCount: overrides.sourceCount,
    independentSourceCount: overrides.sourceCount,
    engagement: { views: 125_000, likes: 6_000 },
    primarySource: overrides.primarySource
  };
}

function viewRanking(rank: number, overrides: Partial<DashboardViewRanking> = {}): DashboardViewRanking {
  return {
    rank,
    previousRank: null,
    rankDelta: null,
    trendStatus: "rising",
    ...overrides
  };
}

function primarySource(sourceValue: DashboardStorySource): DashboardStoryPrimarySource {
  return {
    id: sourceValue.id,
    url: sourceValue.url,
    title: sourceValue.title,
    publisher: sourceValue.publisher,
    platform: sourceValue.platform,
    sourceKind: sourceValue.sourceKind,
    publishedAt: sourceValue.publishedAt,
    metrics: sourceValue.metrics
  };
}

function source(
  id: string,
  platform: DashboardStorySource["platform"],
  title: string,
  url: string
): DashboardStorySource {
  return {
    id,
    canonicalKey: platform + ":" + id,
    platform,
    nativePlatform: platform === "research" || platform === "news" ? platform : platform,
    sourceKind: platform === "research" ? "paper" : ["news", "web", "rss"].includes(platform) ? "article" : "post",
    verificationState: "verified",
    url,
    destinationUrl: null,
    title,
    summary: null,
    authorName: null,
    publisher: null,
    publishedAt: "2026-08-15T10:00:00.000Z",
    metrics: { views: 1_600_000, likes: 12_400, comments: 544 },
    thumbnailUrl: null,
    thumbnailAlt: null,
    trackedEntity: null,
    signals: []
  };
}
