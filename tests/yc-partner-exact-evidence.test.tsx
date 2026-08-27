import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InsightsTabs } from "@/components/InsightsTabs";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import type { EvidenceItem, TopVoiceMember } from "@/lib/graph/types";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";
import {
  analyzeFavoriteEvidence,
  scoreFavoritePair
} from "@/lib/yc-partners/favorite-scoring";
import type {
  YcPartnerFavoriteRanking,
  YcPartnersResponse
} from "@/lib/yc-partners/favorite-contracts";

const ANKIT_GUPTA: TopVoiceMember = {
  personId: "ankit-gupta",
  displayName: "Ankit Gupta",
  aliases: ["Ankit Gupta"],
  handles: { x: ["agupta"] },
  category: "yc_partner",
  weight: 1,
  active: true,
  source: "test"
};

const GENERATED_SUMMARY_PHRASES = /quoted\s+(?:post|founder post)|native\s+x\s+article\s+(?:introduces|launches)|Ankit Gupta\s+(?:praises|congratulates)/i;

const EXPECTED_SENTENCES = {
  Instance: [
    "I met them at the end of last year, and it’s been a pleasure working with them as they iterated through their ideas and landed on this product.",
    "I think it's these two."
  ],
  Prized: [
    "They're two of the strongest product people in my group.",
    "This isn't a hunch — everything they ship, from the landing page to the demo to the launch video (which they edited themselves in a day), has unusual taste for a two-person team a few weeks in."
  ]
} as const;

const S26_PARTNERS_GRAPH = buildGraphResponse(
  { batchSlug: "S26", topVoices: "yc_partners" },
  ycSpring2026GraphDataset
);

describe("YC partner exact full-post evidence", () => {
  it.each([
    {
      companyName: "Most Robotic",
      platformPostId: "2077125864006062268",
      expected: EXPECTED_SENTENCES.Instance
    },
    {
      companyName: "Prized",
      platformPostId: "2077424054966088137",
      expected: EXPECTED_SENTENCES.Prized
    }
  ])("preserves exact source sentences for Ankit Gupta/$companyName", ({
    companyName,
    platformPostId,
    expected
  }) => {
    const item = findAnkitEvidence(companyName, platformPostId);
    expect(item, `missing Ankit Gupta ${companyName} evidence`).toBeDefined();

    const analysis = analyzeFavoriteEvidence(item!);
    expect(analysis.contributingSentences).toEqual(expected);
    expect(analysis.contributingSentences.join("\n")).not.toMatch(GENERATED_SUMMARY_PHRASES);

    const score = scoreFavoritePair(ANKIT_GUPTA, [item!]);
    expect(score.citations[0]?.contributingSentences).toEqual(expected);
    expect(score.citations[0]?.excerpt).not.toMatch(GENERATED_SUMMARY_PHRASES);
  });

  it("rejects generated summary language from every Ankit/Prized or Most Robotic citation surface", () => {
    const relevantEvidence = S26_PARTNERS_GRAPH.evidence.filter(
      (item) =>
        item.topVoice?.displayName === "Ankit Gupta" &&
        (item.attachedCompanyName === "Prized" || item.attachedCompanyName === "Most Robotic")
    );

    expect(relevantEvidence.length).toBeGreaterThan(0);
    for (const item of relevantEvidence) {
      const citation = scoreFavoritePair(ANKIT_GUPTA, [item]).citations[0];
      expect(citation, `missing citation for ${item.sourceUrl}`).toBeDefined();
      expect(citation?.contributingSentences?.join("\n")).not.toMatch(GENERATED_SUMMARY_PHRASES);
      expect(citation?.excerpt).not.toMatch(GENERATED_SUMMARY_PHRASES);
    }
  });

  it.each([
    {
      companyName: "Most Robotic",
      platformPostId: "2077125864006062268",
      expected: EXPECTED_SENTENCES.Instance
    },
    {
      companyName: "Prized",
      platformPostId: "2077424054966088137",
      expected: EXPECTED_SENTENCES.Prized
    }
  ])("renders only verbatim source sentences in the $companyName partner detail", ({
    companyName,
    platformPostId,
    expected
  }) => {
    const item = findAnkitEvidence(companyName, platformPostId);
    expect(item).toBeDefined();
    const score = scoreFavoritePair(ANKIT_GUPTA, [item!]);
    const response = ycPartnerResponse(companyName, score.citations[0]!, score);

    render(
      <InsightsTabs
        graph={S26_PARTNERS_GRAPH}
        ycPartners={response}
        ycPartnersLoading={false}
        onSelectNode={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: "YC Partners" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Ankit Gupta favorite rankings" }));

    const sentenceRegion = screen.getByLabelText("Verbatim contributing sentences");
    expect([...sentenceRegion.querySelectorAll("p")].map((paragraph) => paragraph.textContent)).toEqual(expected);
    expect(sentenceRegion).not.toHaveTextContent(GENERATED_SUMMARY_PHRASES);
    expect(screen.getByRole("region", { name: "Ankit Gupta" })).not.toHaveTextContent(
      GENERATED_SUMMARY_PHRASES
    );
  });
});

function findAnkitEvidence(companyName: string, platformPostId: string): EvidenceItem | undefined {
  return S26_PARTNERS_GRAPH.evidence.find(
    (item) =>
      item.platform === "x" &&
      item.platformPostId === platformPostId &&
      item.attachedCompanyName === companyName &&
      item.topVoice?.displayName === "Ankit Gupta"
  );
}

function ycPartnerResponse(
  companyName: string,
  citation: YcPartnerFavoriteRanking["citations"][number],
  score: ReturnType<typeof scoreFavoritePair>
): YcPartnersResponse {
  const ranking: YcPartnerFavoriteRanking = {
    rank: 1,
    companyId: citation.evidenceId,
    companyName,
    batchSlug: "S26",
    batchLabel: "YC Summer 2026 (S26)",
    score: score.score,
    confidence: score.confidence,
    evidenceCount: 1,
    primaryReason: score.primaryReason,
    citations: [citation],
    breakdown: score.breakdown
  };

  return {
    generatedAt: "2099-01-01T00:00:00.000Z",
    modelVersion: "conviction-v2",
    modelName: "YC partner conviction score",
    batchCount: 1,
    companyCount: 1,
    partnerCount: 1,
    partners: [{
      partnerId: "ankit-gupta",
      partnerName: "Ankit Gupta",
      category: "yc_partner",
      topFavorite: ranking,
      rankingCount: 1,
      supportingEvidenceCount: 1,
      confidence: score.confidence,
      updatedAt: "2099-01-01T00:00:00.000Z",
      rankings: [ranking]
    }]
  };
}
