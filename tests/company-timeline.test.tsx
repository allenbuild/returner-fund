import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodePanel } from "@/components/NodePanel";
import { CompanyTimeline } from "@/components/timeline/CompanyTimeline";
import { clearTimelineClientCache, companyTimelineUrl } from "@/components/timeline/client";
import type { GraphNode } from "@/lib/graph/types";
import {
  TIMELINE_ARTIFACT_SCHEMA_VERSION,
  TIMELINE_EVENT_DETAIL_SCHEMA_VERSION,
  type CompanyTimelineEventDetailArtifact,
  type PublishedTimelineEvent,
} from "@/lib/timeline/contracts";
import { parseCompanyTimelineQuery } from "@/lib/timeline/http";

const fundingEvent: PublishedTimelineEvent = {
  id: "event-funding",
  eventDate: "2026-03-18",
  eventDateType: "announcement_date",
  title: "Announced $3.5 million seed round",
  summary: "The company announced new capital to expand its engineering team.",
  category: "funding",
  isMajor: true,
  hasConflict: false,
  conflictSummary: null,
  evidenceCount: 2,
  sourcePreview: [{
    id: "source-company-blog",
    title: "Our seed round",
    publisher: "Conifer",
    domain: "conifer.build",
    sourceType: "company_blog",
    publishedAt: "2026-03-18T14:00:00.000Z",
    evidenceRole: "primary",
    url: "https://conifer.build/blog/seed-round",
  }],
};

const launchEvent: PublishedTimelineEvent = {
  id: "event-launch",
  eventDate: "2025-11-02",
  eventDateType: "occurrence_date",
  title: "Launched public beta",
  summary: "The first public beta made the routing product available to outside teams.",
  category: "product_launch",
  isMajor: false,
  hasConflict: true,
  conflictSummary: "Sources disagree on whether access opened one day earlier.",
  evidenceCount: 1,
  sourcePreview: [{
    id: "source-launch",
    title: "Public beta launch",
    publisher: null,
    domain: "example.com",
    sourceType: "news_article",
    publishedAt: "2025-11-02T09:00:00.000Z",
    evidenceRole: "conflicting",
    url: "https://example.com/conifer-launch",
  }],
};

const timelinePage = {
  schemaVersion: TIMELINE_ARTIFACT_SCHEMA_VERSION,
  company: { id: "company-conifer", slug: "conifer", name: "Conifer" },
  generatedAt: "2026-08-02T12:00:00.000Z",
  lastModifiedAt: "2026-08-02T12:00:00.000Z",
  events: [launchEvent, fundingEvent],
  groups: [
    { year: 2026, months: [{ month: "2026-03", count: 1 }] },
    { year: 2025, months: [{ month: "2025-11", count: 1 }] },
  ],
  coverage: {
    status: "complete" as const,
    publishedEventCount: 2,
    lastSuccessfulArtifactAt: "2026-08-02T12:00:00.000Z",
  },
  nextCursor: null,
};

const eventDetail: CompanyTimelineEventDetailArtifact = {
  schemaVersion: TIMELINE_EVENT_DETAIL_SCHEMA_VERSION,
  company: timelinePage.company,
  generatedAt: timelinePage.generatedAt,
  lastModifiedAt: timelinePage.lastModifiedAt,
  event: {
    ...fundingEvent,
    evidence: [{
      ...fundingEvent.sourcePreview[0],
      publicationDate: "2026-03-18",
      excerpt: "We raised a $3.5 million seed round.",
      sourceEventDate: "2026-03-18",
      isConflicting: false,
      conflictDescription: null,
    }],
    posts: [{
      id: "post-funding",
      platform: "x",
      account: "@coniferbuild",
      postDate: "2026-03-18",
      excerpt: "We raised our seed round.",
      url: "https://x.com/coniferbuild/status/123",
      metrics: { likes: 421, comments: 17 },
      evidenceRole: "supporting",
    }],
  },
};

const conflictEventDetail: CompanyTimelineEventDetailArtifact = {
  schemaVersion: TIMELINE_EVENT_DETAIL_SCHEMA_VERSION,
  company: timelinePage.company,
  generatedAt: timelinePage.generatedAt,
  lastModifiedAt: timelinePage.lastModifiedAt,
  event: {
    ...launchEvent,
    evidence: [{
      ...launchEvent.sourcePreview[0],
      publicationDate: "2025-11-02T09:00:00.000Z",
      excerpt: "The beta opened on November 1.",
      sourceEventDate: "2025-11-01",
      isConflicting: true,
      conflictDescription: "This source gives a different event occurrence date.",
    }],
    posts: [],
  },
};

describe("Company Timeline", () => {
  beforeEach(() => {
    clearTimelineClientCache();
    window.history.replaceState({}, "", "/");
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      writable: true,
      value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0),
    });
    Object.defineProperty(window, "requestIdleCallback", {
      configurable: true,
      writable: true,
      value: vi.fn(() => 1),
    });
    Object.defineProperty(window, "cancelIdleCallback", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    clearTimelineClientCache();
    vi.restoreAllMocks();
  });

  it("keeps the client page size within the server's validated request contract", () => {
    const url = new URL(companyTimelineUrl("conifer", { from: null, to: null, categories: [] }), "https://returner.fund");
    expect(parseCompanyTimelineQuery(url.searchParams).limit).toBe(100);
  });

  it("renders exact-date events newest first with month headings and no date or event-type navigation", async () => {
    mockTimelineFetch();
    render(<CompanyTimeline companySlug="conifer" companyName="Conifer" />);

    expect(screen.getByLabelText("Loading company timeline")).toBeInTheDocument();
    const eventHeadings = await screen.findAllByRole("heading", { level: 5 });
    expect(eventHeadings.map((heading) => heading.textContent)).toEqual([
      fundingEvent.title,
      launchEvent.title,
    ]);
    expect(screen.getByText("March 18, 2026").closest("time")).toHaveAttribute("datetime", "2026-03-18");
    expect(screen.getByText("Major event")).toBeVisible();
    expect(screen.getAllByText("Funding").some((element) => element.className.includes("category"))).toBe(true);
    expect(screen.getByText(launchEvent.conflictSummary!)).toBeVisible();
    expect(screen.getByRole("heading", { name: "2026", level: 3 })).toBeVisible();
    expect(screen.getByRole("heading", { name: "March", level: 4 })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "Timeline dates" })).not.toBeInTheDocument();
    expect(screen.queryByText("Event type")).not.toBeInTheDocument();
    expect(screen.queryByText("All types")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("loads complete web and post evidence only when an event expands", async () => {
    const fetchMock = mockTimelineFetch();
    render(<CompanyTimeline companySlug="conifer" companyName="Conifer" />);

    const expandButton = await screen.findByRole("button", { name: fundingEvent.title });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/timeline/events/"))).toBe(false);
    fireEvent.click(expandButton);

    expect(expandButton).toHaveAttribute("aria-expanded", "true");
    const evidenceRegion = await screen.findByRole("region", { name: `Evidence for ${fundingEvent.title}` });
    expect(within(evidenceRegion).getByRole("heading", { name: "Web evidence" })).toBeVisible();
    expect(within(evidenceRegion).getByText("We raised a $3.5 million seed round.")).toBeVisible();
    const sourceLink = within(evidenceRegion).getByRole("link", { name: /Our seed round/i });
    expect(sourceLink).toHaveAttribute("href", "https://conifer.build/blog/seed-round");
    expect(sourceLink).toHaveAttribute("target", "_blank");
    expect(sourceLink).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(within(evidenceRegion).getByText("@coniferbuild")).toBeVisible();
    expect(within(evidenceRegion).getByText("421")).toBeVisible();
  });

  it("renders a social source once when legacy detail contains both source and post records", async () => {
    const duplicateUrl = "https://x.com/coniferbuild/status/123";
    const duplicateDetail: CompanyTimelineEventDetailArtifact = {
      ...eventDetail,
      event: {
        ...eventDetail.event,
        evidence: [{
          ...eventDetail.event.evidence[0],
          id: "source-social-launch",
          title: "Conifer seed announcement",
          domain: "x.com",
          sourceType: "company_post",
          url: duplicateUrl,
        }],
        posts: [{ ...eventDetail.event.posts[0], url: `${duplicateUrl}?utm_source=timeline` }],
      },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => (
      String(input).includes("/api/timeline/events/")
        ? jsonResponse(duplicateDetail)
        : jsonResponse(timelinePage)
    ));

    render(<CompanyTimeline companySlug="conifer" companyName="Conifer" />);
    fireEvent.click(await screen.findByRole("button", { name: fundingEvent.title }));
    const evidenceRegion = await screen.findByRole("region", { name: `Evidence for ${fundingEvent.title}` });

    expect(within(evidenceRegion).queryByRole("heading", { name: "Web evidence" })).not.toBeInTheDocument();
    expect(within(evidenceRegion).getByRole("heading", { name: "Related posts" })).toBeVisible();
    expect(within(evidenceRegion).getAllByRole("link")).toHaveLength(1);
  });

  it("does not render an unloaded month beyond the 100-event cursor page", async () => {
    const firstPageEvents = Array.from({ length: 100 }, (_, index): PublishedTimelineEvent => ({
      ...fundingEvent,
      id: `event-current-${index}`,
      title: `Current event ${index + 1}`,
    }));
    const olderEvent: PublishedTimelineEvent = {
      ...launchEvent,
      id: "event-older-101",
      eventDate: "2024-01-05",
      title: "Older event 101",
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("cursor=")) {
        return jsonResponse({
          ...timelinePage,
          events: [olderEvent],
          groups: [{ year: 2024, months: [{ month: "2024-01", count: 1 }] }],
          nextCursor: null,
        });
      }
      return jsonResponse({
        ...timelinePage,
        events: firstPageEvents,
        groups: [
          { year: 2026, months: [{ month: "2026-03", count: 100 }] },
          { year: 2024, months: [{ month: "2024-01", count: 1 }] },
        ],
        coverage: { ...timelinePage.coverage, publishedEventCount: 101 },
        nextCursor: "older-page-cursor",
      });
    });

    render(<CompanyTimeline companySlug="conifer" companyName="Conifer" />);
    await screen.findByRole("heading", { name: "Current event 1" });
    expect(screen.getByRole("heading", { name: "March", level: 4 })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "January", level: 4 })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: olderEvent.title })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show older events" }));
    expect(await screen.findByRole("heading", { name: olderEvent.title })).toBeVisible();
    expect(screen.getByRole("heading", { name: "January", level: 4 })).toBeVisible();
  });

  it("identifies the selected conflict date, rationale, and alternate exact date accessibly", async () => {
    mockTimelineFetch();
    render(<CompanyTimeline companySlug="conifer" companyName="Conifer" />);

    fireEvent.click(await screen.findByRole("button", { name: launchEvent.title }));
    const evidenceRegion = await screen.findByRole("region", { name: `Evidence for ${launchEvent.title}` });
    const selectedDateRow = within(evidenceRegion).getByText("Selected date").closest("div");
    expect(selectedDateRow).not.toBeNull();
    expect(within(selectedDateRow!).getByText("November 2, 2025")).toHaveAttribute("datetime", "2025-11-02");
    expect(within(evidenceRegion).getByText("Why selected")).toBeVisible();
    expect(within(evidenceRegion).getByText(/reviewed exact date selected/i)).toBeVisible();
    expect(within(evidenceRegion).getByText("Alternate event date")).toBeVisible();
    expect(within(evidenceRegion).getByText("November 1, 2025")).toHaveAttribute("datetime", "2025-11-01");
  });

  it("backs filters with timeline-specific URL keys while sending canonical API parameters", async () => {
    window.history.replaceState({}, "", "/?timelineCategories=funding");
    const fetchMock = mockTimelineFetch();
    render(<CompanyTimeline companySlug="conifer" companyName="Conifer" />);
    await screen.findByRole("heading", { name: fundingEvent.title });
    await waitFor(() => expect(window.location.search).not.toContain("timelineCategories"));
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes("categories="))).toBe(true);
    expect(screen.queryByText("Event type")).not.toBeInTheDocument();
    expect(screen.queryByText("All types")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-01-01" } });
    await waitFor(() => expect(window.location.search).toContain("timelineFrom=2026-01-01"));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => {
      const request = String(url);
      return request.includes("from=2026-01-01") && !request.includes("timelineFrom");
    })).toBe(true));

    expect(screen.getByRole("button", { name: "Clear timeline filters" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Clear timeline filters" }));
    await waitFor(() => expect(window.location.search).not.toContain("timelineFrom"));
    expect(window.location.search).not.toContain("timelineCategories");
  });

  it("deep-links the NodePanel view and restores the unchanged Posts interface through popstate", async () => {
    mockTimelineFetch();
    const node = timelineGraphNode();
    window.history.replaceState({}, "", `/?node=${encodeURIComponent(node.id)}&view=timeline`);

    render(<NodePanel node={node} relatedNodes={[]} evidence={[]} />);

    expect(screen.getByRole("heading", { name: "Conifer" })).toBeVisible();
    expect(screen.getByLabelText("Score 44")).toBeVisible();
    expect(await screen.findByRole("button", { name: "Show Conifer posts" })).toHaveTextContent("Posts");
    expect(screen.queryByRole("heading", { name: "Platform contributions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Top Posts" })).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: fundingEvent.title })).toBeVisible();

    act(() => {
      window.history.replaceState({}, "", `/?node=${encodeURIComponent(node.id)}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(await screen.findByRole("button", { name: "Show Conifer timeline" })).toHaveTextContent("Timeline");
    const platformSection = screen.getByRole("heading", { name: "Platform contributions" }).closest("section");
    expect(platformSection).not.toBeNull();
    expect(within(platformSection!).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Top Posts" })).toBeVisible();
  });

  it("switches views without reload and pushes a shareable timeline URL", async () => {
    mockTimelineFetch();
    const node = timelineGraphNode();
    const pushState = vi.spyOn(window.history, "pushState");
    render(<NodePanel node={node} relatedNodes={[]} evidence={[]} />);

    const timelineButton = screen.getByRole("button", { name: "Show Conifer timeline" });
    fireEvent.click(timelineButton);
    expect(pushState).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toContain("view=timeline");
    expect(screen.getByRole("heading", { name: "Conifer" })).toBeVisible();
    expect(screen.getByLabelText("Score 44")).toBeVisible();
    const postsButton = await screen.findByRole("button", { name: "Show Conifer posts" });
    expect(postsButton).toBe(timelineButton);
    expect(postsButton).toHaveAttribute("aria-pressed", "true");
    expect(postsButton.className).toBe(timelineButton.className);

    fireEvent.click(postsButton);
    expect(pushState).toHaveBeenCalledTimes(2);
    expect(window.location.search).not.toContain("view=timeline");
    expect(screen.getByRole("heading", { name: "Top Posts" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Show Conifer timeline" })).toBe(timelineButton);
  });

  it("shows useful API error and filtered-empty states", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503));
    const { unmount } = render(<CompanyTimeline companySlug="conifer" companyName="Conifer" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Timeline request failed with 503");
    unmount();

    clearTimelineClientCache();
    window.history.replaceState({}, "", "/?timelineFrom=2026-01-01");
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({
      ...timelinePage,
      events: [],
      groups: [],
      coverage: { ...timelinePage.coverage, publishedEventCount: 0 },
    }));
    render(<CompanyTimeline companySlug="conifer" companyName="Conifer" />);
    expect(await screen.findByText("No timeline events found")).toBeVisible();
    expect(screen.getByText(/match the selected date range/i)).toBeVisible();
  });

  it("aborts collapsed detail loads and can fetch cleanly when reopened", async () => {
    let detailRequests = 0;
    let firstDetailSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.includes("/api/timeline/events/")) return jsonResponse(timelinePage);
      detailRequests += 1;
      if (detailRequests > 1) return jsonResponse(eventDetail);
      firstDetailSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        firstDetailSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });

    render(<CompanyTimeline companySlug="conifer" companyName="Conifer" />);
    const toggle = await screen.findByRole("button", { name: fundingEvent.title });
    fireEvent.click(toggle);
    await waitFor(() => expect(detailRequests).toBe(1));
    fireEvent.click(toggle);
    expect(firstDetailSignal?.aborted).toBe(true);
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);
    expect(await screen.findByRole("region", { name: `Evidence for ${fundingEvent.title}` })).toHaveTextContent(
      "We raised a $3.5 million seed round.",
    );
    expect(detailRequests).toBe(2);
  });

  it("never appends a stale older page after filters change", async () => {
    let resolveOlder!: (response: Response) => void;
    const olderResponse = new Promise<Response>((resolve) => { resolveOlder = resolve; });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("cursor=")) return olderResponse;
      return jsonResponse({
        ...timelinePage,
        events: [fundingEvent],
        groups: [{ year: 2026, months: [{ month: "2026-03", count: 1 }] }],
        nextCursor: url.includes("from=2026-01-01") ? null : "older-page-cursor",
      });
    });

    render(<CompanyTimeline companySlug="conifer" companyName="Conifer" />);
    await screen.findByRole("heading", { name: fundingEvent.title });
    fireEvent.click(screen.getByRole("button", { name: "Show older events" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("cursor="))).toBe(true));

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-01-01" } });
    resolveOlder(jsonResponse({ ...timelinePage, events: [launchEvent], nextCursor: null }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("from=2026-01-01"))).toBe(true));
    expect(screen.queryByRole("heading", { name: launchEvent.title })).not.toBeInTheDocument();
  });
});

function mockTimelineFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes(`/api/timeline/events/${launchEvent.id}`)) return jsonResponse(conflictEventDetail);
    return url.includes("/api/timeline/events/") ? jsonResponse(eventDetail) : jsonResponse(timelinePage);
  });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function timelineGraphNode(): GraphNode {
  return {
    id: "company:company-conifer",
    entityType: "company",
    entityId: "company-conifer",
    label: "Conifer",
    batchSlug: "S26",
    score: 44,
    previousScore: 44,
    scoreDelta: 0,
    radius: 12,
    topPlatform: "x",
    platformScores: { x: 46 },
    scoreBreakdown: {
      modelId: "returner-traction",
      modelVersion: "4.3.0",
      modelName: "returner-traction-v4-bounded-primary-signal-global-best",
      totalScore: 44,
      absoluteScore: 44,
      weightedAvailableScore: 46,
      coverageFactor: 0.21,
      platformsWithEvidence: 1,
      totalSupportedPlatforms: 9,
      platformScores: { x: 46 },
      weightedPlatforms: [{
        platform: "x",
        score: 46,
        configuredWeight: 0.21,
        appliedWeight: 0.9605,
        contribution: 44.18,
        evidenceCount: 2,
      }],
      signalFamilyScores: {
        reach: 46,
        engagement: 46,
        developerAdoption: 0,
        launchAndCommunity: 0,
        momentum: 0,
      },
      confidence: {
        level: "medium",
        value: 0.6,
        reasons: [],
        scoredEvidenceCount: 2,
        datedEvidenceCount: 2,
        verifiedLinkCount: 2,
      },
      calibration: { method: "none", cohortSize: 1, percentile: null, inputScore: 44 },
      limitations: [],
      evidenceAsOf: "2026-08-02T00:00:00.000Z",
      explanation: "Evidence-backed score.",
    },
    socialAccounts: [],
    evidenceIds: [],
    ycProfileUrl: "https://www.ycombinator.com/companies/conifer",
    websiteUrl: "https://conifer.build",
    tagline: "Local-first AI routing",
    description: "Routes model requests.",
    groupPartner: "Example Partner",
    primaryIndustry: "b2b",
    businessModel: "api",
    review_state: "verified",
    sourceUrl: "https://www.ycombinator.com/companies/conifer",
    visual: {
      industryColor: "#f6ca94",
      shape: "ellipse",
      borderStyle: "solid",
      borderColor: "#9a4b00",
      groupRegion: "Example Partner",
    },
    industries: ["b2b"],
    verticals: [],
    relatedEntityIds: [],
    founders: [],
    review_state_counts: { verified: 1, needs_review: 0, rejected: 0 },
  };
}
