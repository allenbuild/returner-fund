import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InsightsTabs } from "@/components/InsightsTabs";
import type { GraphResponse } from "@/lib/graph/types";

describe("insights tabs", () => {
  it("sorts overview by rank or company and keeps contribution text compact", () => {
    const onSelectNode = vi.fn();
    render(<InsightsTabs graph={graphResponse()} onSelectNode={onSelectNode} />);

    expect(screen.queryByText("Evidence links")).not.toBeInTheDocument();
    expect(screen.getAllByRole("row")[1]).toHaveTextContent("Zeta Labs");
    expect(screen.getByRole("table")).toHaveClass("overview-table");
    expect(screen.getByText("First sentence.")).toBeInTheDocument();
    expect(screen.queryByText(/Second sentence/)).not.toBeInTheDocument();
    expect(screen.getByText("1.2K views / 45 likes / 7 comments")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Company" }));

    expect(screen.getAllByRole("row")[1]).toHaveTextContent("Alpha AI");

    fireEvent.click(screen.getByRole("button", { name: "Company" }));

    expect(screen.getAllByRole("row")[1]).toHaveTextContent("Zeta Labs");

    fireEvent.click(screen.getByRole("button", { name: "Rank" }));
    fireEvent.click(screen.getByRole("button", { name: "Rank" }));

    expect(screen.getAllByRole("row")[1]).toHaveTextContent("Alpha AI");

    expect(screen.getAllByRole("row")[1]).toHaveTextContent("Alpha AI");
    expect(screen.queryByRole("button", { name: "Alpha AI" })).not.toBeInTheDocument();
    expect(onSelectNode).not.toHaveBeenCalled();
  });

  it("shows fastest gaining as DoD/WoW score and rank momentum without evidence columns", () => {
    render(<InsightsTabs graph={graphResponse()} onSelectNode={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Fastest gaining" }));

    expect(screen.getByRole("button", { name: "Day over day" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Week over week" })).toBeInTheDocument();
    expect(screen.getByText("Score delta")).toBeInTheDocument();
    expect(screen.getByText("Rank delta")).toBeInTheDocument();
    expect(screen.queryByText("Platform")).not.toBeInTheDocument();
    expect(screen.queryByText("New high-performing evidence")).not.toBeInTheDocument();
    expect(screen.getByText("+5 pts (+10%)")).toBeInTheDocument();
    expect(screen.getByText("+3 ranks")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Week over week" }));

    const table = screen.getByRole("table");
    expect(within(table).getByText("+9 pts (+18%)")).toBeInTheDocument();
    expect(within(table).getByText("+7 ranks")).toBeInTheDocument();
  });
});

function graphResponse(): GraphResponse {
  return {
    batch: { slug: "S2026", label: "YC Spring 2026", companyCountExpected: 197, companyCountObserved: 197 },
    batches: [{ slug: "S2026", label: "YC Spring 2026", companyCountExpected: 197, companyCountObserved: 197 }],
    nodes: [],
    edges: [],
    leaderboard: [
      {
        rank: 1,
        companyId: "company-a",
        companyName: "Zeta Labs",
        score: 91,
        topPlatform: "x",
        biggestContribution: {
          id: "evidence-a",
          entityType: "company",
          entityId: "company-a",
          platform: "x",
          authorName: "Zeta Labs",
          authorHandle: "zetalabs",
          postedAt: "2026-06-29T00:00:00.000Z",
          title: "Zeta Labs X post",
          text: "First sentence. Second sentence should not appear.",
          mediaType: "video",
          metrics: { views: 1234, likes: 45, comments: 7 },
          contributionScore: 91,
          sourceUrl: "https://x.com/zetalabs/status/1",
          why: "Test evidence"
        }
      },
      {
        rank: 2,
        companyId: "company-b",
        companyName: "Alpha AI",
        score: 52,
        topPlatform: "github",
        biggestContribution: {
          id: "evidence-b",
          entityType: "company",
          entityId: "company-b",
          platform: "github",
          authorName: "Alpha AI",
          authorHandle: "alpha-ai",
          postedAt: "2026-06-29T00:00:00.000Z",
          title: "Alpha repo",
          text: "Alpha repo launched.",
          mediaType: "repo",
          metrics: { stars: 88 },
          contributionScore: 52,
          sourceUrl: "https://github.com/alpha-ai/app",
          why: "Test evidence"
        }
      }
    ],
    fastestGaining: [
      {
        rank: 1,
        companyId: "company-a",
        companyName: "Company A",
        dod: {
          scoreDelta: 5,
          percentDelta: 10,
          rankDelta: 3,
          currentScore: 55,
          currentRank: 11,
          baselineScore: 50,
          baselineRank: 14,
          benchmarkedAt: "2026-06-28T12:00:00.000Z"
        },
        wow: {
          scoreDelta: 9,
          percentDelta: 18,
          rankDelta: 7,
          currentScore: 55,
          currentRank: 11,
          baselineScore: 46,
          baselineRank: 18,
          benchmarkedAt: "2026-06-22T12:00:00.000Z"
        }
      }
    ],
    needsReview: [],
    evidence: [],
    platformStatus: [],
    generatedAt: "2026-06-29T00:00:00.000Z",
    mode: "official_snapshot"
  };
}
