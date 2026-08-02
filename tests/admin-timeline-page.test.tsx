import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AdminTimelinePage from "@/app/admin/timeline/page";

describe("AdminTimelinePage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders coverage, review controls, and event actions without storing the secret", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/coverage")) {
        return Response.json({
          generatedAt: "2026-08-02T10:00:00.000Z",
          nextCursor: null,
          items: [{
            company: { id: "company-acme", slug: "acme", name: "Acme" },
            historicalBackfillStatus: "partial",
            historicalBackfillStartedAt: "2026-08-01T00:00:00.000Z",
            historicalBackfillCompletedAt: null,
            lastIncrementalScanAt: "2026-08-02T09:00:00.000Z",
            lastDeepScanAt: "2026-08-01T09:00:00.000Z",
            publishedEventCount: 4,
            candidateEventCount: 2,
            unresolvedConflictCount: 1,
            unresolvedDateCount: 1,
            failedSourceCount: 2,
            deadLetterTaskCount: 1,
            cacheStatus: "pending",
            sourceCoverage: { official_site: "completed", news: "retry_pending" },
            lastSuccessfulArtifactAt: "2026-08-02T09:05:00.000Z",
            lastError: null,
          }],
        });
      }
      if (url.includes("/review")) {
        return Response.json({
          generatedAt: "2026-08-02T10:00:00.000Z",
          nextCursor: null,
          items: [{
            id: "candidate-1",
            companyId: "company-acme",
            status: "needs_review",
            proposedDate: "2026-03-18",
            proposedCategory: "funding",
            proposedTitle: "Announced seed round",
            proposedSummary: "The company announced new seed financing for product development.",
            sourceIds: ["source-1"],
            rejectionReason: null,
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-02T00:00:00.000Z",
          }],
        });
      }
      return Response.json({
        status: "completed",
        result: { auditId: "audit-1", cacheInvalidated: true },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminTimelinePage />);
    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(screen.getAllByText("4").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Open Acme public timeline" })).toHaveAttribute(
      "href",
      "/?node=company%3Acompany-acme&view=timeline",
    );
    expect(screen.getByRole("button", { name: "Re-run source" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reclassify" })).toBeEnabled();
    expect(screen.getByText("Failed sources")).toBeVisible();
    expect(screen.getByText("Dead-letter tasks")).toBeVisible();
    expect(screen.getByText("Caches needing attention")).toBeVisible();
    expect(screen.getByText("2 failed sources")).toBeVisible();
    expect(screen.getByText("1 dead-letter task")).toBeVisible();
    expect(screen.getByLabelText("Cache status: Pending")).toBeVisible();
    expect(document.querySelector('time[datetime="2026-08-02T09:00:00.000Z"]')).toBeInTheDocument();
    expect(document.querySelector('time[datetime="2026-08-01T09:00:00.000Z"]')).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Review queue" }));
    expect(await screen.findByText("Announced seed round")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();
    expect(screen.getByText("1", { selector: "dd" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Event actions" }));
    expect(screen.getByRole("heading", { name: "Apply an event-level action" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply audited action" })).toBeDisabled();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls.every((call) => !String(call[0]).includes("secret="))).toBe(true);
  });

  it("paginates coverage with the opaque server cursor and retains earlier rows", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const isNextPage = url.includes("cursor=MQ");
      return Response.json({
        generatedAt: "2026-08-02T10:00:00.000Z",
        nextCursor: isNextPage ? null : "MQ",
        items: [{
          company: {
            id: isNextPage ? "company-beta" : "company-alpha",
            slug: isNextPage ? "beta" : "alpha",
            name: isNextPage ? "Beta" : "Alpha",
          },
          historicalBackfillStatus: "completed",
          historicalBackfillStartedAt: null,
          historicalBackfillCompletedAt: "2026-08-02T09:00:00.000Z",
          lastIncrementalScanAt: null,
          lastDeepScanAt: null,
          publishedEventCount: 1,
          candidateEventCount: 0,
          unresolvedConflictCount: 0,
          unresolvedDateCount: 0,
          failedSourceCount: 0,
          deadLetterTaskCount: 0,
          cacheStatus: "current",
          sourceCoverage: {},
          lastSuccessfulArtifactAt: "2026-08-02T09:00:00.000Z",
          lastError: null,
        }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminTimelinePage />);
    expect(await screen.findByText("Alpha")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load more companies" }));
    expect(await screen.findByText("Beta")).toBeVisible();
    expect(screen.getByText("Alpha")).toBeVisible();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("cursor=MQ"))).toBe(true);
    expect(screen.queryByRole("button", { name: "Load more companies" })).not.toBeInTheDocument();
  });

  it("requires event inspection and submits a fully audited public-field edit", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/coverage")) {
        return Response.json({ generatedAt: "2026-08-02T10:00:00.000Z", nextCursor: null, items: [] });
      }
      if (url.includes("/events/event-1")) {
        return Response.json({
          generatedAt: "2026-08-02T10:00:00.000Z",
          eventDetail: {
            event: {
              id: "event-1", companyId: "company-acme", eventDate: "2026-03-18",
              eventDateType: "announcement_date", title: "Original launch", summary: "Acme launched its public product.",
              category: "product_launch", isMajor: false, hasConflict: false, conflictSummary: null,
              evidenceCount: 1, sourcePreview: [], status: "needs_review", importanceScore: 70,
              eventKey: "product-launch-acme", publishedAt: null, classifierVersion: "rules-v1", extractionVersion: "extract-v1",
            },
            evidence: [], posts: [], auditHistory: [],
          },
        });
      }
      if (url.endsWith("/actions") && init?.method === "POST") {
        return Response.json({ status: "completed", result: { auditId: "audit-edit", cacheInvalidated: true } });
      }
      return Response.json({ generatedAt: "2026-08-02T10:00:00.000Z", nextCursor: null, items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminTimelinePage />);

    fireEvent.click(screen.getByRole("tab", { name: "Event actions" }));
    fireEvent.change(screen.getByLabelText("Event ID"), { target: { value: "event-1" } });
    expect(screen.getByRole("button", { name: "Apply audited action" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Inspect event before editing" }));
    expect(await screen.findByRole("heading", { name: "Original launch" })).toBeVisible();

    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "edit" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Updated public launch" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Primary source confirms the corrected title." } });
    const apply = screen.getByRole("button", { name: "Apply audited action" });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);

    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => {
      if (!String(url).endsWith("/actions") || init?.method !== "POST") return false;
      const body = JSON.parse(String(init.body));
      return body.scope === "event"
        && body.action.type === "edit"
        && body.action.patch.title === "Updated public launch"
        && body.action.reason === "Primary source confirms the corrected title.";
    })).toBe(true));
    expect(await screen.findByText(/audit audit-edit/i)).toBeVisible();
  });
});
