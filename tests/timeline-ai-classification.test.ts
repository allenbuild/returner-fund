import { describe, expect, it, vi } from "vitest";
import {
  OpenAiCompatibleTimelineClassificationProvider,
  configuredTimelineAiVersion,
  configuredTimelineClassifierVersion,
  createConfiguredTimelineClassificationProvider,
} from "@/lib/timeline/ai-classification";
import { classifySourceDeterministically } from "@/lib/timeline/classification";
import type {
  TimelineClassificationInput,
  TimelineClassificationProvider,
  TimelineClassificationSource,
} from "@/lib/timeline/domain";
import { TIMELINE_EXTRACTION_VERSION } from "@/lib/timeline/domain";
import {
  classifyDiscoveredTimelineSourceWithAi,
  timelineSourceInputHash,
} from "@/lib/timeline/ingestion-runner";

const input = classificationInput();

describe("strict-JSON Timeline AI classification", () => {
  it("uses deterministic classification when no complete AI configuration exists", () => {
    expect(createConfiguredTimelineClassificationProvider({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBeNull();
    expect(createConfiguredTimelineClassificationProvider({
      NODE_ENV: "test",
      TIMELINE_AI_API_KEY: "secret",
    } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("cannot publish malformed or unsupported model output", async () => {
    const malformed: TimelineClassificationProvider = {
      id: "malformed",
      version: "malformed-v1",
      classify: async () => ({ isMeaningfulEvent: true, title: "free form without evidence" }),
    };
    await expect(classifyDiscoveredTimelineSourceWithAi(input.company, input.sources, input.sources[0]!, malformed))
      .rejects.toThrow();

    const deterministic = classifySourceDeterministically(input, input.sources[0]!);
    expect(deterministic.isMeaningfulEvent).toBe(true);
    const unsupported: TimelineClassificationProvider = {
      id: "unsupported-quantity",
      version: "unsupported-v1",
      classify: async () => deterministic.isMeaningfulEvent ? {
        ...deterministic,
        title: "Acme announced a $9M seed round",
        summary: "Acme announced a $9M seed round.",
      } : deterministic,
    };
    await expect(classifyDiscoveredTimelineSourceWithAi(input.company, input.sources, input.sources[0]!, unsupported))
      .rejects.toThrow(/unsupported/i);
  });

  it("uses AI as a veto while deterministic supported claims remain the publication gate", async () => {
    const deterministic = classifySourceDeterministically(input, input.sources[0]!);
    const accepting: TimelineClassificationProvider = {
      id: "accepting",
      version: "accepting-v1",
      classify: async () => deterministic,
    };
    const result = await classifyDiscoveredTimelineSourceWithAi(input.company, input.sources, input.sources[0]!, accepting);
    expect(result).toMatchObject({
      isMeaningfulEvent: true,
      eventDate: "2026-08-02",
      eventDateType: "publication_date",
      category: "funding",
    });
    expect(result.classifierVersion).toBe(configuredTimelineClassifierVersion(accepting));

    const rejecting: TimelineClassificationProvider = {
      id: "rejecting",
      version: "rejecting-v1",
      classify: async () => ({
        isMeaningfulEvent: false,
        companyId: input.company.id,
        sourceIds: [input.sources[0]!.id],
        reason: "not_meaningful",
        classifierVersion: "rejecting-v1",
        extractionVersion: "timeline-extraction-2026-08-02.v1",
      }),
    };
    await expect(classifyDiscoveredTimelineSourceWithAi(input.company, input.sources, input.sources[0]!, rejecting))
      .resolves.toMatchObject({ isMeaningfulEvent: false, reason: "not_meaningful" });
  });

  it("keeps third-party timestamps as publication dates and reserves stronger semantics for direct sources", () => {
    const thirdParty = classifySourceDeterministically(input, input.sources[0]!);
    expect(thirdParty).toMatchObject({
      isMeaningfulEvent: true,
      eventDate: "2026-08-02",
      eventDateType: "publication_date",
    });

    const companyAnnouncement: TimelineClassificationSource = {
      ...input.sources[0]!,
      id: "source-acme-company-announcement",
      url: "https://acme.example/funding",
      publisher: "Acme",
      sourceType: "company_post",
      authorRelationship: "company",
      sourceQualityTier: 1,
    };
    expect(classifySourceDeterministically(
      { ...input, sources: [companyAnnouncement] },
      companyAnnouncement,
    )).toMatchObject({ isMeaningfulEvent: true, eventDateType: "announcement_date" });

    const sameTierThirdParty: TimelineClassificationSource = {
      ...input.sources[0]!,
      id: "a-third-party-publication",
      sourceQualityTier: 1,
    };
    const laterLexicalCompany = {
      ...companyAnnouncement,
      id: "z-company-announcement",
    };
    expect(classifySourceDeterministically(
      { ...input, sources: [sameTierThirdParty, laterLexicalCompany] },
      sameTierThirdParty,
    )).toMatchObject({
      isMeaningfulEvent: true,
      eventDateType: "announcement_date",
      sourceIds: expect.arrayContaining([sameTierThirdParty.id, laterLexicalCompany.id]),
    });

    const directRelease: TimelineClassificationSource = {
      ...companyAnnouncement,
      id: "source-acme-release",
      url: "https://github.com/acme/acme/releases/tag/v1.2.0",
      title: "Acme released version v1.2.0",
      text: "Acme released version v1.2.0 with a new API.",
      evidenceExcerpt: "Acme released version v1.2.0 with a new API.",
      sourceType: "github_release",
    };
    expect(classifySourceDeterministically(
      { ...input, sources: [directRelease] },
      directRelease,
    )).toMatchObject({ isMeaningfulEvent: true, eventDateType: "occurrence_date" });
  });

  it("rejects model output that upgrades a third-party publication date to an occurrence date", async () => {
    const deterministic = classifySourceDeterministically(input, input.sources[0]!);
    expect(deterministic.isMeaningfulEvent).toBe(true);
    const falseOccurrence: TimelineClassificationProvider = {
      id: "false-occurrence",
      version: "false-occurrence-v1",
      classify: async () => deterministic.isMeaningfulEvent
        ? { ...deterministic, eventDateType: "occurrence_date" }
        : deterministic,
    };
    await expect(classifyDiscoveredTimelineSourceWithAi(
      input.company,
      input.sources,
      input.sources[0]!,
      falseOccurrence,
    )).rejects.toThrow(/date provenance/i);
  });

  it("does not let an AI veto erase a deterministic direct-source conflict", async () => {
    const alternate: TimelineClassificationSource = {
      ...input.sources[0]!,
      id: "source-acme-funding-alternate",
      url: "https://acme.example/funding",
      title: "Acme raised a $7M seed round",
      text: "Acme raised a $7M seed round to expand its product.",
      evidenceExcerpt: "Acme raised a $7M seed round to expand its product.",
      sourceQualityTier: 1,
      publisher: "Acme",
      sourceType: "press_release",
      authorRelationship: "company",
    };
    const rejecting: TimelineClassificationProvider = {
      id: "rejecting-conflict",
      version: "rejecting-conflict-v1",
      classify: async () => ({
        isMeaningfulEvent: false,
        companyId: input.company.id,
        sourceIds: [input.sources[0]!.id],
        reason: "not_meaningful",
        classifierVersion: "rejecting-conflict-v1",
        extractionVersion: TIMELINE_EXTRACTION_VERSION,
      }),
    };
    const result = await classifyDiscoveredTimelineSourceWithAi(
      input.company,
      [input.sources[0]!, alternate],
      input.sources[0]!,
      rejecting,
    );
    expect(result.isMeaningfulEvent).toBe(true);
    if (result.isMeaningfulEvent) {
      expect(result.conflicts).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: "funding_amount" }),
      ]));
      expect(result.sourceIds).toEqual(expect.arrayContaining([input.sources[0]!.id, alternate.id]));
    }
  });

  it("keeps content and configured model lineage deterministic for idempotency", () => {
    expect(timelineSourceInputHash(input.sources[0]!)).toBe(timelineSourceInputHash({ ...input.sources[0]! }));
    expect(configuredTimelineAiVersion("model-a", "https://ai.example/v1/chat/completions"))
      .toBe(configuredTimelineAiVersion("model-a", "https://ai.example/v1/chat/completions"));
    expect(configuredTimelineAiVersion("model-a", "https://ai.example/v1/chat/completions"))
      .not.toBe(configuredTimelineAiVersion("model-b", "https://ai.example/v1/chat/completions"));
  });

  it("sends an isolated strict schema and retries transient transport failures only within bounds", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("temporary", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          isMeaningfulEvent: false,
          companyId: input.company.id,
          sourceIds: [input.sources[0]!.id],
          reason: "not_meaningful",
          classifierVersion: "model-supplied-value-is-overwritten",
          extractionVersion: "model-supplied-value-is-overwritten",
        }) } }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const provider = new OpenAiCompatibleTimelineClassificationProvider({
      apiKey: "test-secret",
      model: "test-model",
      baseUrl: "https://ai.example/v1/",
      fetchImpl: fetchMock,
      maxAttempts: 2,
      timeoutMs: 1_000,
    });

    const output = await provider.classify(input) as Record<string, unknown>;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(output).toMatchObject({ classifierVersion: provider.version, extractionVersion: TIMELINE_EXTRACTION_VERSION });
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true } });
    expect(request.messages[0].content).toMatch(/untrusted source data/i);
    expect(request.messages[0].content).toMatch(/preserve every claim in conflicts/i);
    expect(request.response_format.json_schema.schema.oneOf[0].properties.conflicts.maxItems).toBeGreaterThan(0);
    expect(request.messages[1].content).toContain("untrustedSources");
    expect(request.messages[1].content).not.toContain("test-secret");
  });
});

function classificationInput(): TimelineClassificationInput {
  const company = {
    id: "company-acme",
    slug: "acme",
    name: "Acme",
    aliases: ["Acme"],
    websiteUrl: "https://acme.example",
    founderNames: ["Alice Founder"],
  };
  const source: TimelineClassificationSource = {
    id: "source-acme-funding",
    url: "https://news.example/acme-funding",
    title: "Acme raised a $5M seed round",
    publisher: "Example News",
    sourceType: "news_article",
    platform: "web",
    publicationTimestamp: "2026-08-02T09:00:00.000Z",
    publicationDatePrecision: "exact",
    text: "Acme raised a $5M seed round to expand its product.",
    evidenceExcerpt: "Acme raised a $5M seed round to expand its product.",
    sourceQualityTier: 2,
    attributionStatus: "verified",
    linkStatus: "verified",
    topic: null,
    authorRelationship: "third_party",
  };
  return { company, sources: [source], existingEventKeys: [] };
}
