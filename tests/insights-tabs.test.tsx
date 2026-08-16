import { readFileSync } from "node:fs";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InsightsTabs } from "@/components/InsightsTabs";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import type { GraphResponse } from "@/lib/graph/types";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";
import type { YcPartnersResponse } from "@/lib/yc-partners/favorite-contracts";

describe("insights tabs", () => {
  it("keeps all five navigation boxes on one shared equal-size layout in every selected view", () => {
    render(<InsightsTabs graph={graphResponse()} onSelectNode={vi.fn()} />);

    const tabNames = ["Overview", "Hottest", "Ranked Posts", "Stats", "YC Partners"] as const;
    const navigation = screen.getByRole("tablist", { name: "Dashboard panels" });
    const tabList = navigation.parentElement;
    const actions = tabList?.querySelector(".tab-list-actions");
    const tabs = tabNames.map((name) => screen.getByRole("tab", { name }));
    const sharedClassName = tabs[0].className;
    const sharedInlineStyle = tabs[0].getAttribute("style");

    expect(tabList).toHaveClass("tab-list");
    expect(actions).toBeInstanceOf(HTMLElement);
    expect(sharedClassName).toBe("insights-tab-button");
    expect(new Set(tabs.map((tab) => tab.className))).toEqual(new Set([sharedClassName]));
    expect(new Set(tabs.map((tab) => tab.getAttribute("style")))).toEqual(
      new Set([sharedInlineStyle])
    );
    expect(tabs.map((tab) => tab.parentElement)).toEqual(tabs.map(() => navigation));
    expect(
      tabs.map((tab) => tab.querySelector(".insights-tab-button-content")?.className)
    ).toEqual(tabs.map(() => "insights-tab-button-content"));

    for (const selectedTab of tabs) {
      fireEvent.click(selectedTab);
      expect(selectedTab).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("tablist", { name: "Dashboard panels" })).toBe(navigation);
      expect(navigation.parentElement).toBe(tabList);
      expect(tabList?.querySelector(".tab-list-actions")).toBe(actions);
      expect(within(navigation).getAllByRole("tab")).toEqual(tabs);
      expect(new Set(tabs.map((tab) => tab.className))).toEqual(new Set([sharedClassName]));
      expect(new Set(tabs.map((tab) => tab.getAttribute("style")))).toEqual(
        new Set([sharedInlineStyle])
      );
    }

    const css = readFileSync("src/app/globals.css", "utf8");
    const navigationRules = [
      ...css.matchAll(/(?:^|\n)\s*\.tab-navigation\s*\{([^}]*)\}/g)
    ].map((match) => match[1]);
    const buttonRules = [
      ...css.matchAll(/(?:^|\n)\s*\.insights-tab-button\s*\{([^}]*)\}/g)
    ].map((match) => match[1]);
    const hiddenActionRules = [
      ...css.matchAll(/(?:^|\n)\s*\.tab-list-actions-hidden\s*\{([^}]*)\}/g)
    ].map((match) => match[1]);
    const centeredButtonRule = css.match(
      /\.tab-navigation\s*>\s*\.insights-tab-button\s*\{([^}]*)\}/
    )?.[1];
    const desktopActionsRule = css.match(
      /(?:^|\n)\s*\.tab-list-actions\s*\{([^}]*)\}/
    )?.[1];
    const desktopToggleRule = css.match(
      /\.tab-list-actions\s*>\s*\.segmented-toggle\s*\{([^}]*)\}/
    )?.[1];
    const desktopToggleButtonRule = css.match(
      /\.tab-list-actions\s*>\s*\.segmented-toggle\s*>\s*button\s*\{([^}]*)\}/
    )?.[1];

    expect(navigationRules.length).toBeGreaterThan(0);
    for (const rule of navigationRules) {
      expect(rule).toMatch(/grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/);
      expect(rule).toMatch(/width:\s*100%/);
      expect(rule).toMatch(/min-width:\s*0/);
    }

    expect(buttonRules.length).toBeGreaterThan(0);
    for (const rule of buttonRules) {
      expect(rule).toMatch(/box-sizing:\s*border-box|width:\s*100%/);
      expect(rule).toMatch(/width:\s*100%/);
      expect(rule).toMatch(/min-width:\s*0/);
      expect(rule).toMatch(/max-width:\s*none/);
    }

    expect(hiddenActionRules.length).toBeGreaterThan(0);
    for (const rule of hiddenActionRules) {
      expect(rule).not.toMatch(/display:\s*none/);
      expect(rule).not.toMatch(
        /(?:^|;)\s*(?:width|min-width|max-width|padding|margin|grid-column|grid-template-columns)\s*:/
      );
    }

    expect(centeredButtonRule).toMatch(/display:\s*grid/);
    expect(centeredButtonRule).toMatch(/place-items:\s*center/);
    expect(desktopActionsRule).toMatch(/height:\s*var\(--insights-tab-height\)/);
    expect(desktopActionsRule).toMatch(/min-height:\s*var\(--insights-tab-height\)/);
    expect(desktopToggleRule).toMatch(/height:\s*var\(--insights-tab-height\)/);
    expect(desktopToggleRule).toMatch(/max-height:\s*var\(--insights-tab-height\)/);
    expect(desktopToggleButtonRule).toMatch(/height:\s*28px/);
    expect(desktopToggleButtonRule).toMatch(/min-height:\s*28px/);

    expect(css).not.toMatch(/#insights-tab-(?:overview|gaining|ranked|stats)/);
    expect(css).not.toMatch(/\.insights-tab-button:nth-(?:child|of-type)/);

    const selectedRule = css.match(
      /\.insights-tab-button\[aria-selected="true"\]\s*\{([^}]*)\}/
    )?.[1];
    expect(selectedRule).toBeDefined();
    expect(selectedRule).not.toMatch(
      /(?:^|;)\s*(?:width|height|min-width|min-height|max-width|max-height|padding|margin|font-size|grid-template-columns)\s*:/
    );
  });

  it("shows complete top-platform names instead of ellipsizing long labels", () => {
    const graph = graphResponse();
    const platforms = [
      { platform: "instagram" as const, label: "Instagram" },
      { platform: "product_hunt" as const, label: "Product Hunt" },
      { platform: "hacker_news" as const, label: "Hacker News" }
    ];
    graph.leaderboard = platforms.map(({ platform }, index) => ({
      ...graph.leaderboard[0]!,
      rank: index + 1,
      companyId: `company-platform-${index}`,
      companyName: `Platform company ${index + 1}`,
      topPlatform: platform
    }));

    render(<InsightsTabs graph={graph} onSelectNode={vi.fn()} />);

    for (const { label } of platforms) {
      const platformName = screen.getByText(label);
      expect(platformName.closest(".overview-platform-cell")).toBeInTheDocument();
      expect(platformName.closest(".platform-identity")).toBeInTheDocument();
      expect(platformName).toHaveTextContent(label);
    }

    const css = readFileSync("src/app/globals.css", "utf8");
    const platformLabelRule = css.match(
      /\.overview-platform-cell\s+\.ranking-platform-chip\s+\.platform-identity\s+span\s*\{([^}]*)\}/
    )?.[1];

    expect(platformLabelRule).toBeDefined();
    expect(platformLabelRule).toMatch(/overflow:\s*visible/);
    expect(platformLabelRule).toMatch(/overflow-wrap:\s*anywhere/);
    expect(platformLabelRule).toMatch(/text-overflow:\s*clip/);
    expect(platformLabelRule).toMatch(/white-space:\s*normal/);
    expect(platformLabelRule).not.toMatch(/text-overflow:\s*ellipsis/);
    expect(platformLabelRule).not.toMatch(/white-space:\s*nowrap/);

    const responsivePlatformRules = [
      ...css.matchAll(/\.overview-table td:nth-child\(4\)\s*\{([^}]*)\}/g)
    ].map((match) => match[1]);
    expect(responsivePlatformRules.length).toBeGreaterThan(0);
    expect(responsivePlatformRules).not.toContainEqual(expect.stringMatching(/display:\s*none/));
    expect(responsivePlatformRules).toContainEqual(expect.stringMatching(/grid-row:\s*2/));
  });

  it("exposes selected tabs and momentum periods to assistive technology", () => {
    render(<InsightsTabs graph={graphResponse()} onSelectNode={vi.fn()} />);

    const overviewTab = screen.getByRole("tab", { name: "Overview" });
    const hottestTab = screen.getByRole("tab", { name: "Hottest" });
    const rankedTab = screen.getByRole("tab", { name: "Ranked Posts" });
    const statsTab = screen.getByRole("tab", { name: "Stats" });
    const navigation = screen.getByRole("tablist", { name: "Dashboard panels" });
    expect(navigation).toHaveClass("tab-navigation");
    expect(within(navigation).getAllByRole("tab")).toHaveLength(5);
    expect(navigation.parentElement).toHaveClass("tab-list");
    expect(overviewTab).toHaveAttribute("aria-selected", "true");
    expect(overviewTab).toHaveAttribute("aria-controls", "insights-panel-overview");
    expect(overviewTab).toHaveAttribute("tabindex", "0");
    expect(hottestTab).toHaveAttribute("aria-selected", "false");
    expect(hottestTab).toHaveAttribute("tabindex", "-1");
    expect(statsTab).toHaveAttribute("aria-selected", "false");
    expect(statsTab).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "insights-tab-overview");

    fireEvent.keyDown(overviewTab, { key: "ArrowRight" });

    expect(hottestTab).toHaveFocus();
    expect(overviewTab).toHaveAttribute("aria-selected", "false");
    expect(hottestTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "insights-tab-gaining");

    const dayToggle = screen.getByRole("button", { name: "Day over day" });
    const weekToggle = screen.getByRole("button", { name: "Week over week" });
    expect(dayToggle).toHaveAttribute("aria-pressed", "true");
    expect(weekToggle).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(weekToggle);

    expect(dayToggle).toHaveAttribute("aria-pressed", "false");
    expect(weekToggle).toHaveAttribute("aria-pressed", "true");

    fireEvent.keyDown(hottestTab, { key: "ArrowRight" });

    expect(rankedTab).toHaveFocus();
    expect(rankedTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "insights-tab-ranked");
    const rankedPeriodGroup = screen.getByRole("group", { name: "Ranked posts period" });
    expect(rankedPeriodGroup).toHaveClass("ranked-posts-period-toggle");
    expect(within(rankedPeriodGroup).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "All time",
      "Today",
      "Month"
    ]);
    expect(screen.getByRole("button", { name: "All time" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Today" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Month" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.keyDown(rankedTab, { key: "ArrowRight" });

    expect(statsTab).toHaveFocus();
    expect(statsTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "insights-tab-stats");
  });

  it("shows database totals and ingestion growth charts without methodology or quality-summary text", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const companyCount = graph.nodes.filter((node) => node.entityType === "company").length;
    const founderCount = new Set(
      graph.nodes.flatMap((node) => node.founders.map((founder) => founder.id))
    ).size;

    render(<InsightsTabs graph={graph} onSelectNode={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Stats" }));

    expect(screen.getByRole("heading", { name: "Database growth" })).toBeInTheDocument();
    expect(screen.getByText(graph.batch.label)).toBeInTheDocument();
    expect(screen.getByText("Sources").closest(".stats-metric")).toHaveTextContent(
      graph.evidenceStats!.totalCount.toLocaleString()
    );
    expect(screen.getByText("Companies").closest(".stats-metric")).toHaveTextContent(
      companyCount.toLocaleString()
    );
    expect(screen.getByText("Founders").closest(".stats-metric")).toHaveTextContent(
      founderCount.toLocaleString()
    );
    const sourceSpline = screen.getByRole("slider", { name: /Total sources by day for the last 14 days/i });
    expect(sourceSpline).toHaveAttribute("aria-valuenow", graph.evidenceStats!.totalCount.toString());
    expect(screen.getByRole("slider", { name: /Total companies by day for the last 14 days/i })).toHaveAttribute(
      "aria-valuenow",
      companyCount.toString()
    );
    expect(screen.getByRole("slider", { name: /Total founders by day for the last 14 days/i })).toHaveAttribute(
      "aria-valuenow",
      founderCount.toString()
    );
    fireEvent.keyDown(sourceSpline, { key: "Home" });
    expect(sourceSpline.getAttribute("aria-valuetext")).toMatch(/^[A-Z][a-z]{2} \d{1,2}: [\d,]+$/);
    expect(screen.queryByText("Platforms represented")).not.toBeInTheDocument();
    expect(screen.queryByText("Verified source links")).not.toBeInTheDocument();
    expect(screen.queryByText("Sources per company")).not.toBeInTheDocument();
    expect(screen.queryByText("Needs review")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Scoring model status and methodology" })).not.toBeInTheDocument();
    expect(screen.queryByText(/V5 learned model/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/How the currently displayed V4 baseline is calculated/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/strongest 5 posts per platform contribute/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Platform weights")).not.toBeInTheDocument();
  });

  it("renders complete published entity coverage when the client evidence preview is capped", () => {
    const statsGraph = {
      ...graphResponse(),
      nodes: [
        { entityType: "company", entityId: "company-a", founders: [{ id: "founder-a" }, { id: "founder-b" }] },
        { entityType: "company", entityId: "company-b", founders: [{ id: "founder-c" }] },
        { entityType: "company", entityId: "company-c", founders: [{ id: "founder-d" }] }
      ] as GraphResponse["nodes"],
      evidence: [
        {
          ...graphResponse().leaderboard[0].biggestContribution!,
          entityType: "founder" as const,
          entityId: "founder-a",
          attachedCompanyId: "company-a",
          observedAt: "2026-06-29T00:00:00.000Z"
        }
      ],
      evidenceStats: {
        totalCount: 36_663,
        scoringEligibleCount: 15_563,
        byPlatform: { x: 28_649 },
        byTopic: {},
        firstSeenByDay: { "2026-06-29": 36_663 },
        entityCoverage: {
          company: { withSourcesCount: 2, firstSeenByDay: { "2026-06-28": 2 } },
          founder: { withSourcesCount: 3, firstSeenByDay: { "2026-06-28": 3 } }
        }
      }
    } satisfies GraphResponse;

    render(<InsightsTabs graph={graphResponse()} statsGraph={statsGraph} onSelectNode={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Stats" }));

    expect(screen.getByText("Sources").closest(".stats-metric")).toHaveTextContent("36,663");
    expect(screen.getByText("Companies").closest(".stats-metric")).toHaveTextContent("67% have sources");
    expect(screen.getByText("Founders").closest(".stats-metric")).toHaveTextContent("75% have sources");
  });

  it("renders at most 100 physically deduplicated ranked posts and a reliable Today empty state", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    render(
      <InsightsTabs
        graph={graph}
        now={new Date("2099-01-01T18:00:00.000Z")}
        onSelectNode={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: "Ranked Posts" }));
    expect(screen.queryByRole("heading", { name: "Top performing posts" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Scores use graph evidence available as of/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByText("No reliably dated posts were published today.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    expect(screen.getByText("No reliably dated posts were published in the last 30 days.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "All time" }));
    const list = screen.getByRole("list", { name: "Ranked posts" });
    const posts = within(list).getAllByRole("listitem");
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.length).toBeLessThanOrEqual(100);
    const firstPost = posts[0];
    expect(firstPost.querySelector("article.ranked-post-card")).toBeInTheDocument();
    expect(firstPost.querySelector(".ranked-post-primary-row")).toContainElement(
      firstPost.querySelector(".ranked-post-company")
    );
    expect(firstPost.querySelector(".ranked-post-primary-row")).toContainElement(
      firstPost.querySelector(".ranked-post-meta")
    );
    expect(firstPost.querySelector(".ranked-post-meta time")).toHaveAttribute("datetime");
    expect(firstPost.querySelector(".ranked-post-title")).not.toBeEmptyDOMElement();
    expect(firstPost.querySelector(".ranked-post-title-row")).toContainElement(
      firstPost.querySelector(".ranked-post-title")
    );
    expect(firstPost.querySelector(".ranked-post-details")).toBeInTheDocument();
    const score = firstPost.querySelector<HTMLElement>(".ranked-post-score");
    expect(firstPost.querySelector(".ranked-post-title-row")).not.toContainElement(score);
    expect(firstPost.querySelector("article.ranked-post-card")).toContainElement(score);
    expect(score?.parentElement).toBe(firstPost.querySelector("article.ranked-post-card"));
    expect(score).toHaveTextContent(/^\d+$/);
    expect(score).toHaveAttribute("aria-label", expect.stringMatching(/^Post score \d+$/));
    expect(score?.querySelector("span, small")).not.toBeInTheDocument();
    expect(firstPost.querySelector(".ranked-post-rank .rank-medal, .ranked-post-rank .rank-number")).toBeInTheDocument();
    const rowLink = within(firstPost).getByRole("link", { name: /Open .* post on /i });
    expect(rowLink).toHaveAttribute("href");
    expect(rowLink).toHaveAttribute("target", "_blank");
    expect(rowLink).toContainElement(firstPost.querySelector("article.ranked-post-card"));
    expect(firstPost.querySelector(".ranked-post-taxonomies")).not.toBeInTheDocument();
  });

  it("shows only reliably dated posts inside the rolling Month window", () => {
    const now = new Date("2026-07-29T18:00:00.000Z");
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const company = graph.nodes.find((node) => node.entityType === "company");
    expect(company).toBeDefined();

    const monthEvidence = (
      id: string,
      title: string,
      postedAt: string,
      publishedAtPrecision: "exact" | "unknown" = "exact"
    ): GraphResponse["evidence"][number] => ({
      id,
      batchSlug: "S2026",
      entityType: "company",
      entityId: company!.entityId,
      attachedCompanyId: company!.entityId,
      attachedCompanyName: company!.label,
      platform: "x",
      authorName: "Month test",
      authorHandle: "monthtest",
      postedAt,
      publishedAtPrecision,
      title,
      text: title,
      mediaType: "text",
      metrics: { views: 1_000, likes: 25 },
      contributionScore: 70,
      normalizedScore: 70,
      tractionStatus: "scored",
      sourceUrl: `https://x.com/monthtest/status/${id}`,
      platformPostId: id,
      why: "Month visibility test",
      review_state: "verified",
      linkStatus: "verified"
    });

    graph.evidence = [
      monthEvidence("2100000000000000001", "Inside the rolling month", "2026-07-15T12:00:00.000Z"),
      monthEvidence("2100000000000000002", "Older than the rolling month", "2026-06-20T12:00:00.000Z"),
      monthEvidence("2100000000000000003", "Future publication", "2026-07-30T12:00:00.000Z"),
      monthEvidence(
        "2100000000000000004",
        "Unknown publication precision",
        "2026-07-20T12:00:00.000Z",
        "unknown"
      )
    ];

    render(<InsightsTabs graph={graph} now={now} onSelectNode={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Ranked Posts" }));
    fireEvent.click(screen.getByRole("button", { name: "Month" }));

    const list = screen.getByRole("list", { name: "Ranked posts" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("Inside the rolling month")).toBeInTheDocument();
    expect(within(list).queryByText("Older than the rolling month")).not.toBeInTheDocument();
    expect(within(list).queryByText("Future publication")).not.toBeInTheDocument();
    expect(within(list).queryByText("Unknown publication precision")).not.toBeInTheDocument();
  });

  it("uses native publication time for Today across platforms and ignores refresh timestamps", () => {
    const now = new Date("2026-07-31T18:00:00.000Z");
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const company = graph.nodes.find((node) => node.entityType === "company");
    expect(company).toBeDefined();

    const platforms = [
      {
        platform: "github" as const,
        sourceUrl: "https://github.com/native-date-test/repository",
        platformPostId: "native-date-test/repository",
        todaySourceUrl: "https://github.com/native-date-test/repository-new",
        todayPostId: "native-date-test/repository-new",
        metrics: { stars: 250 },
        mediaType: "repo" as const
      },
      {
        platform: "x" as const,
        sourceUrl: "https://x.com/nativedatetest/status/2100000000000000101",
        platformPostId: "2100000000000000101",
        todaySourceUrl: "https://x.com/nativedatetest/status/2100000000000000201",
        todayPostId: "2100000000000000201",
        metrics: { views: 2_500, likes: 80 },
        mediaType: "text" as const
      },
      {
        platform: "linkedin" as const,
        sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:2100000000000000102",
        platformPostId: "2100000000000000102",
        todaySourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:2100000000000000202",
        todayPostId: "2100000000000000202",
        metrics: { reactions: 90 },
        mediaType: "text" as const
      },
      {
        platform: "instagram" as const,
        sourceUrl: "https://www.instagram.com/p/NativeDateTest/",
        platformPostId: "NativeDateTest",
        todaySourceUrl: "https://www.instagram.com/p/NativeDateToday/",
        todayPostId: "NativeDateToday",
        metrics: { views: 3_000, likes: 120 },
        mediaType: "image" as const
      }
    ];
    const refreshedAt = "2026-07-31T17:00:00.000Z";
    const evidence = platforms.flatMap((record) => {
      const base = {
        batchSlug: "S2026",
        entityType: "company" as const,
        entityId: company!.entityId,
        attachedCompanyId: company!.entityId,
        attachedCompanyName: company!.label,
        platform: record.platform,
        authorName: "Native date test",
        authorHandle: "native_date_test",
        publishedAtPrecision: "exact" as const,
        mediaType: record.mediaType,
        metrics: record.metrics,
        contributionScore: 70,
        normalizedScore: 70,
        tractionStatus: "scored" as const,
        sourceUrl: record.sourceUrl,
        platformPostId: record.platformPostId,
        observedAt: refreshedAt,
        metricsCheckedAt: refreshedAt,
        first_seen_at: refreshedAt,
        last_checked_at: refreshedAt,
        last_updated_at: refreshedAt,
        why: "Native publication date visibility test",
        review_state: "verified" as const,
        linkStatus: "verified" as const
      };
      return [
        {
          ...base,
          id: `old-refreshed-${record.platform}`,
          postedAt: "2026-06-15T12:00:00.000Z",
          title: `Old ${record.platform} item refreshed today`,
          text: `Old ${record.platform} item refreshed today`
        },
        {
          ...base,
          id: `native-today-${record.platform}`,
          sourceUrl: record.todaySourceUrl,
          platformPostId: record.todayPostId,
          postedAt: "2026-07-31T12:00:00.000Z",
          title: `New ${record.platform} item published today`,
          text: `New ${record.platform} item published today`
        }
      ];
    });

    graph.evidence = evidence;

    render(<InsightsTabs graph={graph} now={now} onSelectNode={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Ranked Posts" }));
    fireEvent.click(screen.getByRole("button", { name: "Today" }));

    const list = screen.getByRole("list", { name: "Ranked posts" });
    for (const { platform } of platforms) {
      expect(within(list).getByText(`New ${platform} item published today`)).toBeInTheDocument();
      expect(within(list).queryByText(`Old ${platform} item refreshed today`)).not.toBeInTheDocument();
    }
    expect(within(list).getAllByRole("listitem")).toHaveLength(platforms.length);
  });

  it("keeps every ranked-post label readable instead of clipping it into an ellipsis", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    const rankedPostRules = css.slice(
      css.indexOf(".ranked-post-card"),
      css.indexOf(".ranked-posts-empty")
    );

    expect(rankedPostRules).toMatch(
      /grid-template-columns:\s*32px\s+86px\s+minmax\(0,\s*1fr\)\s+52px/
    );
    expect(rankedPostRules).not.toMatch(/grid-template-columns:[^;]*minmax\(0,\s*560px\)/);
    expect(rankedPostRules).not.toMatch(/text-overflow:\s*ellipsis/);
    expect(rankedPostRules).not.toMatch(/white-space:\s*nowrap/);
    expect(rankedPostRules).not.toMatch(/overflow:\s*hidden/);
    expect(rankedPostRules).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rankedPostRules).toMatch(/white-space:\s*normal/);
    expect(rankedPostRules).toMatch(/flex-wrap:\s*wrap/);
  });

  it("does not show a separate score scope or Top Voices audience strip", () => {
    const graph = graphResponse();
    graph.scoringContext = {
      ...graph.scoringContext!,
      scoreScope: "selected_platforms",
      selectedPlatforms: ["github", "x"]
    };
    const { rerender } = render(<InsightsTabs graph={graph} onSelectNode={vi.fn()} />);

    expect(screen.queryByText("Score scope")).not.toBeInTheDocument();

    rerender(
      <InsightsTabs
        graph={{
          ...graph,
          selectedTopVoiceAudience: {
            id: "yc_partners",
            displayName: "YC Partners",
            description: "Current YC partners and YC leadership.",
            helperText: "Showing attention from current YC partners only.",
            scoreLabel: "Top Voices score",
            scoreDescription: "Current YC partners and YC leadership.",
            active: true,
            memberCount: 18
          },
          scoringContext: {
            ...graph.scoringContext!,
            scoreScope: "top_voice",
            selectedPlatforms: []
          }
        }}
        onSelectNode={vi.fn()}
      />
    );

    expect(screen.queryByText("Score audience")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "YC Partners" })).toBeInTheDocument();
  });

  it("sorts overview by rank or company and keeps contribution text compact", () => {
    const onSelectNode = vi.fn();
    render(<InsightsTabs graph={graphResponse()} onSelectNode={onSelectNode} />);

    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
    expect(screen.queryByText("Evidence links")).not.toBeInTheDocument();
    expect(screen.getAllByRole("row")[1]).toHaveTextContent("Zeta Labs");
    expect(screen.getByRole("table")).toHaveClass("overview-table");
    expect(screen.getByText("First sentence.")).toBeInTheDocument();
    expect(screen.getByText("zetalabs")).toBeInTheDocument();
    expect(screen.queryByText("Zeta Labs X post")).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "Alpha AI" }));
    expect(onSelectNode).toHaveBeenCalledWith("company:company-b");
  });

  it("shows hottest companies as DoD/WoW score and rank momentum without evidence columns", () => {
    const onSelectNode = vi.fn();
    render(<InsightsTabs graph={graphResponse()} onSelectNode={onSelectNode} />);

    fireEvent.click(screen.getByRole("tab", { name: "Hottest" }));

    expect(screen.getByRole("button", { name: "Day over day" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Week over week" })).toBeInTheDocument();
    expect(screen.getByText("Hot rank")).toBeInTheDocument();
    expect(screen.getByText("Score delta")).toBeInTheDocument();
    expect(screen.getByText("Rank delta")).toBeInTheDocument();
    expect(screen.queryByText("Platform")).not.toBeInTheDocument();
    expect(screen.queryByText("New high-performing evidence")).not.toBeInTheDocument();
    expect(screen.getByText("+5 pts (+10%)")).toBeInTheDocument();
    expect(screen.getByText("+3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Company A" }));
    expect(onSelectNode).toHaveBeenCalledWith("company:company-a");

    fireEvent.click(screen.getByRole("button", { name: "Week over week" }));

    const table = screen.getByRole("table");
    expect(within(table).getByText("+9 pts (+18%)")).toBeInTheDocument();
    expect(within(table).getByText("+7")).toBeInTheDocument();
    const cells = table.querySelectorAll("tbody tr td");
    expect(cells[4]).toHaveTextContent("#11 / 55 points");
    expect(cells[5]).toHaveTextContent("#18 / 46 points on");
  });

  it("numbers Hot rank in the selected week-over-week order", () => {
    const graph = graphResponse();
    const first = graph.fastestGaining[0]!;
    graph.fastestGaining = [
      {
        ...first,
        rank: 44,
        companyName: "Daily leader",
        dod: { ...first.dod, scoreDelta: 15 },
        wow: { ...first.wow, scoreDelta: 1 }
      },
      {
        ...first,
        rank: 1,
        companyId: "company-b",
        companyName: "Weekly leader",
        dod: { ...first.dod, scoreDelta: 10 },
        wow: { ...first.wow, scoreDelta: 20 }
      }
    ];

    render(<InsightsTabs graph={graph} onSelectNode={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Hottest" }));
    fireEvent.click(screen.getByRole("button", { name: "Week over week" }));

    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Weekly leader");
    expect(rows[0]?.querySelector(".rank-medal")).toHaveAttribute("aria-label", "Rank 1");
    expect(rows[1]).toHaveTextContent("Daily leader");
    expect(rows[1]?.querySelector(".rank-medal")).toHaveAttribute("aria-label", "Rank 2");
  });

  it("labels a company absent from an otherwise valid prior snapshot without implying a pending job", () => {
    const graph = graphResponse();
    const dodBenchmarkAt = new Date(2026, 6, 12).toISOString();
    const wowBenchmarkAt = new Date(2026, 6, 6).toISOString();
    const completeRow = {
      ...graph.fastestGaining[0]!,
      rank: 2,
      companyId: "company-b",
      companyName: "Company B"
    };
    const missingPriorRow = {
      ...graph.fastestGaining[0]!,
      dod: {
        ...graph.fastestGaining[0]!.dod,
        baselineScore: null,
        baselineRank: 14,
        benchmarkedAt: dodBenchmarkAt
      },
      wow: {
        ...graph.fastestGaining[0]!.wow,
        baselineScore: 46,
        baselineRank: null,
        benchmarkedAt: wowBenchmarkAt
      }
    };
    graph.fastestGaining = [missingPriorRow, completeRow];

    render(<InsightsTabs graph={graph} onSelectNode={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Hottest" }));

    const missingDod = screen.getByText(
      `Not in ${new Date(dodBenchmarkAt).toLocaleDateString()} snapshot`
    );
    const dodCells = missingDod.closest("tr")?.querySelectorAll("td");
    expect(missingDod).toBeInTheDocument();
    expect(dodCells?.[2]).toHaveTextContent("Score —");
    expect(dodCells?.[3]).toHaveTextContent("+3");
    expect(
      missingDod.closest("tr")?.querySelector(".momentum-stat-cell:last-child .momentum-value-compact")
    ).toHaveTextContent(
      `Not in ${new Date(dodBenchmarkAt).toLocaleDateString(undefined, {
        month: "numeric",
        day: "numeric"
      })}`
    );
    expect(screen.queryByText(/Awaiting snapshot/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Week over week" }));

    const missingWow = screen.getByText(
      `Not in ${new Date(wowBenchmarkAt).toLocaleDateString()} snapshot`
    );
    const wowCells = missingWow.closest("tr")?.querySelectorAll("td");
    expect(missingWow).toBeInTheDocument();
    expect(wowCells?.[2]).toHaveTextContent("+9 pts (+18%)");
    expect(wowCells?.[3]).toHaveTextContent("Rank —");
    expect(screen.queryByText(/Awaiting snapshot/)).not.toBeInTheDocument();
  });

  it("keeps an unavailable same-model period unselectable and shows the valid period instead", () => {
    const graph = graphResponse();
    graph.fastestGaining = graph.fastestGaining.map((row) => ({
      ...row,
      wow: {
        ...row.wow,
        scoreDelta: 0,
        percentDelta: 0,
        rankDelta: 0,
        baselineScore: null,
        baselineRank: null,
        benchmarkedAt: null
      }
    }));

    render(<InsightsTabs graph={graph} onSelectNode={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Hottest" }));

    const dayToggle = screen.getByRole("button", { name: "Day over day" });
    const weekToggle = screen.getByRole("button", { name: "Week over week" });
    expect(dayToggle).toBeEnabled();
    expect(dayToggle).toHaveAttribute("aria-pressed", "true");
    expect(weekToggle).toBeDisabled();
    expect(weekToggle).toHaveAttribute(
      "title",
      "Available after an observed snapshot exists from seven Central days earlier under this scoring model."
    );
    expect(screen.getByText("+5 pts (+10%)")).toBeInTheDocument();
    expect(screen.queryByText(/Awaiting/)).not.toBeInTheDocument();
  });

  it("falls back to current standings without inventing deltas when momentum history is unavailable", () => {
    const graph = graphResponse();
    graph.fastestGaining = [];

    render(<InsightsTabs graph={graph} onSelectNode={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Hottest" }));

    expect(screen.getByRole("button", { name: "Day over day" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Week over week" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Historical comparison is not available for this scoring model yet."
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Showing current scores and overall ranks. No historical deltas are inferred."
    );
    const zetaRow = screen.getByRole("button", { name: "Zeta Labs" }).closest("tr");
    expect(zetaRow).toBeInTheDocument();
    const cells = zetaRow?.querySelectorAll("td");
    expect(cells?.[2]).toHaveTextContent("Score —");
    expect(cells?.[3]).toHaveTextContent("Rank —");
    expect(cells?.[4]).toHaveTextContent("#1 / 91 points");
    expect(cells?.[5]).toHaveTextContent("Not benchmarked");
    expect(zetaRow).not.toHaveTextContent("Awaiting snapshot");
  });

  it("keeps measured momentum ahead of unbenchmarked rows", () => {
    const graph = graphResponse();
    const measured = graph.fastestGaining[0]!;
    graph.fastestGaining = [
      {
        ...measured,
        rank: 2,
        companyId: "unbenchmarked",
        companyName: "Unbenchmarked Current Leader",
        dod: {
          ...measured.dod,
          scoreDelta: 0,
          percentDelta: 0,
          rankDelta: 0,
          currentScore: 100,
          currentRank: 1,
          baselineScore: null,
          baselineRank: null,
          benchmarkedAt: null
        }
      },
      {
        ...measured,
        rank: 1,
        companyId: "measured",
        companyName: "Measured Decline",
        dod: {
          ...measured.dod,
          scoreDelta: -2,
          percentDelta: -4,
          rankDelta: -1,
          currentScore: 48,
          currentRank: 12,
          baselineScore: 50,
          baselineRank: 11
        }
      }
    ];

    render(<InsightsTabs graph={graph} onSelectNode={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Hottest" }));

    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Measured Decline");
    expect(rows[0]).toHaveTextContent("-2 pts (-4%)");
    expect(rows[1]).toHaveTextContent("Unbenchmarked Current Leader");
    expect(rows[1]).toHaveTextContent("Not benchmarked");
  });

  it("breaks equal hottest score deltas by percentage growth", () => {
    const graph = graphResponse();
    graph.fastestGaining = [
      {
        rank: 1,
        companyId: "company-greypoint",
        companyName: "Greypoint Industries",
        dod: {
          scoreDelta: 1,
          percentDelta: 1.3,
          rankDelta: 8,
          currentScore: 78,
          currentRank: 4,
          baselineScore: 77,
          baselineRank: 12,
          benchmarkedAt: "2026-07-11T12:00:00.000Z"
        },
        wow: {
          scoreDelta: 1,
          percentDelta: 1.3,
          rankDelta: 8,
          currentScore: 78,
          currentRank: 4,
          baselineScore: 77,
          baselineRank: 12,
          benchmarkedAt: "2026-07-05T12:00:00.000Z"
        }
      },
      {
        rank: 2,
        companyId: "company-cova",
        companyName: "Cova",
        dod: {
          scoreDelta: 1,
          percentDelta: 1.9,
          rankDelta: 1,
          currentScore: 53,
          currentRank: 7,
          baselineScore: 52,
          baselineRank: 8,
          benchmarkedAt: "2026-07-11T12:00:00.000Z"
        },
        wow: {
          scoreDelta: 1,
          percentDelta: 1.9,
          rankDelta: 1,
          currentScore: 53,
          currentRank: 7,
          baselineScore: 52,
          baselineRank: 8,
          benchmarkedAt: "2026-07-05T12:00:00.000Z"
        }
      }
    ];

    render(<InsightsTabs graph={graph} onSelectNode={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Hottest" }));

    const rows = screen.getAllByRole("row");
    expect(rows[1]).toHaveTextContent("Cova");
    expect(rows[1]).toHaveTextContent("+1 pts (+1.9%)");
    expect(rows[2]).toHaveTextContent("Greypoint Industries");
    expect(rows[2]).toHaveTextContent("+1 pts (+1.3%)");
  });

  it("numbers a Top Voices subset by its sorted momentum order", () => {
    const graph = graphResponse();
    graph.selectedTopVoiceAudience = {
      id: "yc_partners",
      displayName: "YC Partners",
      description: "Current YC partners and YC leadership.",
      helperText: "Showing attention from current YC partners only.",
      scoreLabel: "Top Voices score",
      scoreDescription: "Current YC partners and YC leadership.",
      active: true,
      memberCount: 18
    };
    const topVoiceRow = graph.fastestGaining[0]!;
    graph.fastestGaining = [
      {
        ...topVoiceRow,
        rank: 4,
        companyId: "top-voice-a",
        companyName: "Top Voice A",
        dod: { ...topVoiceRow.dod, scoreDelta: 1 }
      },
      {
        ...topVoiceRow,
        rank: 4,
        companyId: "top-voice-b",
        companyName: "Top Voice B",
        dod: { ...topVoiceRow.dod, scoreDelta: 2 }
      }
    ];

    render(<InsightsTabs graph={graph} onSelectNode={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Hottest" }));

    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector("td")).toHaveTextContent("1");
    expect(rows[1]?.querySelector("td")).toHaveTextContent("2");
  });

  it("shows an empty state in Overview and Hottest when a Top Voices audience has no qualifying companies", () => {
    render(
      <InsightsTabs
        graph={{
          ...graphResponse(),
          leaderboard: [],
          fastestGaining: [],
          selectedTopVoiceAudience: {
            id: "yc_partners",
            displayName: "YC Partners",
            description: "Current YC partners and YC leadership.",
            helperText: "Showing attention from current YC partners only.",
            scoreLabel: "Top Voices score",
            scoreDescription: "Current YC partners and YC leadership.",
            active: true,
            memberCount: 18
          }
        }}
        onSelectNode={vi.fn()}
      />
    );

    expect(
      within(screen.getByRole("tabpanel")).getByText(
        "No companies have traction from this Top Voices audience yet."
      )
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Hottest" }));

    expect(
      within(screen.getByRole("tabpanel")).getByText(
        "No companies have traction from this Top Voices audience yet."
      )
    ).toBeInTheDocument();
  });

  it("carries company social accounts onto leaderboard rows", () => {
    const companyWithAccount = ycSpring2026GraphDataset.companies.find((company) => company.socialAccounts.length > 0);

    expect(companyWithAccount).toBeDefined();

    const graph = buildGraphResponse({ batchSlug: companyWithAccount!.batchSlug }, ycSpring2026GraphDataset);
    const row = graph.leaderboard.find((item) => item.companyId === companyWithAccount!.id);

    expect(row?.socialAccounts).toEqual(companyWithAccount!.socialAccounts);
  });

  it("keeps account handles out of a zero-evidence top-post cell", () => {
    render(
      <InsightsTabs
        graph={{
          ...graphResponse(),
          leaderboard: [
            {
              rank: 1,
              companyId: "zerodrift",
              companyName: "ZeroDrift",
              score: 0,
              topPlatform: null,
              socialAccounts: [
                {
                  id: "account-zerodrift-x",
                  platform: "x",
                  handle: "zerodrift",
                  url: "https://x.com/zerodrift",
                  review_state: "verified",
                  discoveredFromUrl: "https://www.ycombinator.com/companies/zerodrift",
                  matchReason: "Seeded canonical account"
                }
              ],
              biggestContribution: null
            }
          ]
        }}
        onSelectNode={vi.fn()}
      />
    );

    const row = screen.getAllByRole("row")[1];
    expect(within(row).getByText("No traction posts yet")).toBeInTheDocument();
    expect(within(row).queryByText("No evidence")).not.toBeInTheDocument();

    expect(row.querySelector(".overview-account-link")).toBeNull();
    expect(row.querySelector(".overview-founder-account-link")).toBeNull();
  });

  it("keeps founder account handles out of a zero-evidence top-post cell", () => {
    render(
      <InsightsTabs
        graph={{
          ...graphResponse(),
          leaderboard: [
            {
              rank: 1,
              companyId: "hammock",
              companyName: "Hammock",
              score: 0,
              topPlatform: null,
              socialAccounts: [],
              founderAccounts: [
                {
                  founderId: "founder-jesse-rose",
                  founderName: "Jesse Rose",
                  socialAccounts: [
                    {
                      id: "account-jesse-linkedin",
                      platform: "linkedin",
                      handle: "jesserose",
                      url: "https://www.linkedin.com/in/jesserose",
                      review_state: "verified",
                      discoveredFromUrl: "https://speedrun.a16z.com/companies/hammock/jesse-rose",
                      matchReason: "Native social account exposed on the founder profile"
                    }
                  ]
                }
              ],
              biggestContribution: null
            }
          ]
        }}
        onSelectNode={vi.fn()}
      />
    );

    const row = screen.getAllByRole("row")[1];
    expect(within(row).getByText("No traction posts yet")).toBeInTheDocument();

    expect(row.querySelector(".overview-account-link")).toBeNull();
    expect(row.querySelector(".overview-founder-account-link")).toBeNull();
    expect(row.querySelector(".overview-contribution-link")).toBeNull();
  });

  it("renders only the evidence link in YC-style top-post cells", () => {
    render(<InsightsTabs graph={graphResponse()} onSelectNode={vi.fn()} />);

    const row = screen.getAllByRole("row")[1];
    const accountLinks = [...row.querySelectorAll<HTMLAnchorElement>(".overview-account-link")];

    expect(accountLinks).toEqual([]);
    expect(within(row).getByRole("link", { name: /First sentence/i })).toHaveAttribute(
      "href",
      "https://x.com/zetalabs/status/1"
    );
  });

  it("uses generated thumbnails in overview rows when native media is missing or broken", () => {
    const graph = graphResponse();
    render(<InsightsTabs graph={graph} onSelectNode={vi.fn()} />);

    const row = screen.getAllByRole("row")[1];
    const img = row!.querySelector<HTMLImageElement>(".overview-post-thumbnail img");

    expect(img?.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(decodeDataImage(img?.getAttribute("src"))).toContain(">X<");
    expect(row!.querySelector(".overview-post-thumbnail-fallback")).toBeNull();
  });

  it("uses native overview thumbnails before fallbacks and resets failures for a new item", () => {
    const graph = graphResponse();
    graph.leaderboard[0] = {
      ...graph.leaderboard[0],
      biggestContribution: {
        ...graph.leaderboard[0].biggestContribution!,
        thumbnailUrl: "https://pbs.twimg.com/media/expired.jpg",
        thumbnailSource: "x-media"
      }
    };
    const onSelectNode = vi.fn();
    const { rerender } = render(<InsightsTabs graph={graph} onSelectNode={onSelectNode} />);

    const row = screen.getAllByRole("row")[1];
    const nativeImg = row!.querySelector<HTMLImageElement>(".overview-post-thumbnail img");
    expect(nativeImg).toHaveAttribute("src", "https://pbs.twimg.com/media/expired.jpg");
    fireEvent.error(nativeImg!);

    const generatedImg = row!.querySelector<HTMLImageElement>(".overview-post-thumbnail img");
    expect(generatedImg?.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(decodeDataImage(generatedImg?.getAttribute("src"))).toContain(">X<");
    expect(row!.querySelector(".overview-post-thumbnail-fallback")).toBeNull();

    rerender(
      <InsightsTabs
        graph={{
          ...graph,
          leaderboard: graph.leaderboard.map((entry, index) =>
            index === 0
              ? {
                  ...entry,
                  biggestContribution: {
                    ...entry.biggestContribution!,
                    id: "replacement-evidence"
                  }
                }
              : entry
          )
        }}
        onSelectNode={onSelectNode}
      />
    );

    const replacementRow = screen.getAllByRole("row")[1];
    expect(replacementRow!.querySelector(".overview-post-thumbnail img")).toHaveAttribute(
      "src",
      "https://pbs.twimg.com/media/expired.jpg"
    );
  });

  it("renders only the evidence link in A16Z top-post cells", () => {
    const graph = buildGraphResponse({ batchSlug: "A16ZSR006" }, ycSpring2026GraphDataset);
    render(<InsightsTabs graph={graph} onSelectNode={vi.fn()} />);

    const row = screen.getByText("Crebit").closest("tr");

    expect(row).toBeTruthy();
    expect(row!.querySelector(".overview-account-link")).toBeNull();
    expect(row!.querySelector(".overview-founder-account-link")).toBeNull();
    expect(row!.querySelector<HTMLAnchorElement>(".overview-contribution-link")).toHaveAttribute(
      "href",
      "https://www.linkedin.com/posts/simmi-sen_we-are-hiring-ten-paid-growth-interns-for-activity-7403840813530570752-U_Nm"
    );
  });

  it("renders verbatim YC partner contributing sentences and keeps the original post link", () => {
    const exactSentenceOne = "Kara has arguably the strongest founder-market fit in the batch.";
    const exactSentenceTwo = "It is hard to think of a better team building this scientific hardware platform.";
    const summary = "Generated summary that must not appear as a contributing sentence.";
    const reason = "Generated reason that must not appear as a contributing sentence.";
    const graph = graphResponse();
    graph.evidence = [ycPartnerEvidence({
      title: "quoted post",
      text: `${exactSentenceOne} ${exactSentenceTwo}`
    })];

    render(
      <InsightsTabs
        graph={graph}
        ycPartners={ycPartnerResponse({
          excerpt: summary,
          reason,
          contributingSentences: [exactSentenceOne, exactSentenceTwo]
        })}
        ycPartnersLoading={false}
        onSelectNode={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: "YC Partners" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Brad Flora favorite rankings" }));

    const sentenceRegion = screen.getByLabelText("Verbatim contributing sentences");
    expect(sentenceRegion).toHaveTextContent(exactSentenceOne);
    expect(sentenceRegion).toHaveTextContent(exactSentenceTwo);
    expect(sentenceRegion).not.toHaveTextContent(summary);
    expect(sentenceRegion).not.toHaveTextContent(reason);
    expect(sentenceRegion.querySelectorAll("p")).toHaveLength(2);

    const originalPostLink = screen.getByRole("link", { name: "Open original LinkedIn post for Kara" });
    expect(originalPostLink).toHaveAttribute("href", "https://example.com/kara-post");
    const originalPostCard = originalPostLink.querySelector("article.yc-partner-post-card");
    expect(originalPostCard).toBeInTheDocument();
    expect(originalPostCard).toHaveTextContent(exactSentenceOne);
    expect(originalPostCard).not.toHaveTextContent("quoted post");
  });

  it("shows an unavailable state instead of substituting the citation excerpt", () => {
    const summary = "Generated summary that must not appear as a contributing sentence.";
    const graph = graphResponse();
    graph.evidence = [ycPartnerEvidence({ title: "native LinkedIn post", text: "" })];

    render(
      <InsightsTabs
        graph={graph}
        ycPartners={ycPartnerResponse({ excerpt: summary, reason: "Generated reason" })}
        ycPartnersLoading={false}
        onSelectNode={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: "YC Partners" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Brad Flora favorite rankings" }));

    const sentenceRegion = screen.getByLabelText("Verbatim contributing sentences");
    expect(sentenceRegion).toHaveTextContent("Verbatim contributing sentence(s) unavailable.");
    expect(sentenceRegion).not.toHaveTextContent(summary);
    expect(sentenceRegion.querySelectorAll("p")).toHaveLength(1);
    const originalPostCard = screen.getByRole("link", { name: "Open original LinkedIn post for Kara" }).querySelector("article.yc-partner-post-card");
    expect(originalPostCard).toHaveTextContent("Verbatim source text unavailable.");
    expect(originalPostCard).not.toHaveTextContent(summary);
    expect(originalPostCard).not.toHaveTextContent("native LinkedIn post");
  });
});

function ycPartnerResponse({
  excerpt,
  reason,
  contributingSentences
}: {
  excerpt: string;
  reason: string;
  contributingSentences?: string[];
}): YcPartnersResponse {
  const confidence = {
    level: "high" as const,
    score: 86,
    reasons: [reason],
    uniqueEvidenceCount: 1,
    uniquePlatformCount: 1,
    uniqueContextCount: 1,
    datedEvidenceCount: 1,
    verifiedLinkCount: 1
  };
  const citation = {
    evidenceId: "post-1",
    sourceUrl: "https://example.com/kara-post",
    platform: "linkedin" as const,
    postedAt: "2026-08-12T12:00:00.000Z",
    excerpt,
    ...(contributingSentences ? { contributingSentences } : {}),
    reason,
    signalType: "explicit_superlative" as const,
    scoreContribution: 78
  };
  const ranking = {
    rank: 1,
    companyId: "kara",
    companyName: "Kara",
    batchSlug: "S26",
    batchLabel: "YC Summer 2026 (S26)",
    score: 86,
    confidence,
    evidenceCount: 1,
    primaryReason: reason,
    citations: [citation],
    breakdown: {
      strongestEvidenceScore: 78,
      secondaryEvidenceBonus: 0,
      independentContextBonus: 0,
      negativePenalty: 0,
      convictionStrength: 100,
      praiseStrength: 100,
      specificity: 84,
      contextQuality: 100,
      uniqueEvidenceCount: 1,
      uniquePlatformCount: 1,
      uniqueContextCount: 1,
      signalTypes: ["explicit_superlative" as const]
    }
  };

  return {
    generatedAt: "2026-08-14T12:00:00.000Z",
    modelVersion: "conviction-v2",
    modelName: "YC partner conviction score",
    batchCount: 1,
    companyCount: 1,
    partnerCount: 1,
    partners: [{
      partnerId: "brad-flora",
      partnerName: "Brad Flora",
      category: "yc_partner",
      topFavorite: ranking,
      rankingCount: 1,
      supportingEvidenceCount: 1,
      confidence,
      updatedAt: "2026-08-14T12:00:00.000Z",
      rankings: [ranking]
    }]
  };
}

function ycPartnerEvidence({ title, text }: { title?: string; text: string }): GraphResponse["evidence"][number] {
  return {
    id: "post-1",
    batchSlug: "S26",
    entityType: "company",
    entityId: "kara",
    platform: "linkedin",
    authorName: "Brad Flora",
    authorHandle: "bradflora",
    postedAt: "2026-08-12T12:00:00.000Z",
    ...(title ? { title } : {}),
    text,
    mediaType: "text",
    metrics: { likes: 12 },
    contributionScore: 78,
    sourceUrl: "https://example.com/kara-post",
    why: "Test evidence"
  };
}

function decodeDataImage(value: string | null | undefined): string {
  const payload = value?.split(",")[1] ?? "";
  return decodeURIComponent(payload);
}

function graphResponse(): GraphResponse {
  return {
    batch: { slug: "S26", label: "YC Summer 2026 (S26)", companyCountExpected: 83, companyCountObserved: 83 },
    batches: [{ slug: "S26", label: "YC Summer 2026 (S26)", companyCountExpected: 83, companyCountObserved: 83 }],
    nodes: [],
    edges: [],
    leaderboard: [
      {
        rank: 1,
        companyId: "company-a",
        companyName: "Zeta Labs",
        score: 91,
        topPlatform: "x",
        socialAccounts: [
          {
            id: "account-zeta-x",
            platform: "x",
            handle: "zetalabs",
            url: "https://x.com/zetalabs",
            review_state: "verified",
            discoveredFromUrl: "https://www.ycombinator.com/companies/zeta-labs",
            matchReason: "Seeded canonical account"
          }
        ],
        biggestContribution: {
          id: "evidence-a",
          entityType: "company",
          entityId: "company-a",
          platform: "x",
          authorName: "Zeta Labs X post",
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
        socialAccounts: [
          {
            id: "account-alpha-github",
            platform: "github",
            handle: "alpha-ai",
            url: "https://github.com/alpha-ai",
            review_state: "verified",
            discoveredFromUrl: "https://www.speedrun.com/alpha-ai",
            matchReason: "Seeded canonical account"
          }
        ],
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
    selectedTopVoiceAudience: {
      id: "off",
      displayName: "All voices",
      description: "All available network traction signals.",
      helperText: "Showing all available network traction signals.",
      scoreLabel: "Traction score",
      scoreDescription: "Scored from all available GitHub and social evidence.",
      active: true,
      memberCount: 0
    },
    topVoiceAudiences: [
      {
        id: "off",
        displayName: "All voices",
        description: "All available network traction signals.",
        helperText: "Showing all available network traction signals.",
        scoreLabel: "Traction score",
        scoreDescription: "Scored from all available GitHub and social evidence.",
        active: true,
        memberCount: 0
      }
    ],
    generatedAt: "2026-06-29T00:00:00.000Z",
    scoringContext: {
      modelId: "returner-traction",
      modelVersion: "4.0.1",
      modelName: "returner-traction-v4-monotonic",
      scoreScope: "all_platforms",
      selectedPlatforms: [],
      responseBuiltAt: "2026-06-29T00:00:00.000Z",
      evidenceAsOf: "2026-06-29T00:00:00.000Z"
    },
    mode: "official_snapshot"
  };
}
