import {
  TIMELINE_ARTIFACT_SCHEMA_VERSION,
  TIMELINE_EVENT_DETAIL_SCHEMA_VERSION,
  type CompanyTimelineEventDetailArtifact,
  type ListPublishedTimelineEventsResult,
  type PublishedTimelineEvent,
  type TimelineCompanyRef,
  type TimelineEvidenceDetail,
  type TimelineMonthGroup,
  type TimelinePostEvidence,
  type TimelineSourcePreview,
} from "./contracts";
import { splitTimelineDetailSources } from "./detail-sources";

/**
 * Explicit public projections at the HTTP boundary. Artifact and database rows
 * may gain internal fields over time; these functions prevent those fields
 * from becoming an accidental API contract through object spreading.
 */
export function projectPublicTimelineList(result: ListPublishedTimelineEventsResult) {
  return {
    schemaVersion: TIMELINE_ARTIFACT_SCHEMA_VERSION,
    company: projectCompany(result.company),
    events: result.events.map(projectEvent),
    groups: result.groups.map(projectMonthGroup),
    coverage: {
      status: result.coverage.status,
      publishedEventCount: result.coverage.publishedEventCount,
      lastSuccessfulArtifactAt: result.coverage.lastSuccessfulArtifactAt,
    },
    nextCursor: result.nextCursor,
  };
}

export function projectPublicTimelineEventDetail(
  detail: CompanyTimelineEventDetailArtifact,
): CompanyTimelineEventDetailArtifact {
  const sources = splitTimelineDetailSources(
    detail.event.eventDate,
    detail.event.evidence,
    detail.event.posts,
  );
  return {
    schemaVersion: TIMELINE_EVENT_DETAIL_SCHEMA_VERSION,
    company: projectCompany(detail.company),
    event: {
      ...projectEvent(detail.event),
      evidence: sources.evidence.map(projectEvidence),
      posts: sources.posts.map(projectPost),
    },
    generatedAt: detail.generatedAt,
    lastModifiedAt: detail.lastModifiedAt,
  };
}

function projectCompany(company: TimelineCompanyRef): TimelineCompanyRef {
  return { id: company.id, slug: company.slug, name: company.name };
}

function projectEvent(event: PublishedTimelineEvent): PublishedTimelineEvent {
  return {
    id: event.id,
    eventDate: event.eventDate,
    eventDateType: event.eventDateType,
    title: event.title,
    summary: event.summary,
    category: event.category,
    isMajor: event.isMajor,
    hasConflict: event.hasConflict,
    conflictSummary: event.conflictSummary,
    evidenceCount: event.evidenceCount,
    sourcePreview: event.sourcePreview.map(projectSource),
  };
}

function projectSource(source: TimelineSourcePreview): TimelineSourcePreview {
  return {
    id: source.id,
    title: source.title,
    publisher: source.publisher,
    domain: source.domain,
    sourceType: source.sourceType,
    publishedAt: source.publishedAt,
    evidenceRole: source.evidenceRole,
    url: source.url,
  };
}

function projectEvidence(source: TimelineEvidenceDetail): TimelineEvidenceDetail {
  return {
    ...projectSource(source),
    publicationDate: source.publicationDate,
    excerpt: source.excerpt,
    sourceEventDate: source.sourceEventDate,
    isConflicting: source.isConflicting,
    conflictDescription: source.conflictDescription,
  };
}

function projectPost(post: TimelinePostEvidence): TimelinePostEvidence {
  return {
    id: post.id,
    platform: post.platform,
    account: post.account,
    postDate: post.postDate,
    excerpt: post.excerpt,
    url: post.url,
    metrics: Object.fromEntries(Object.entries(post.metrics).map(([key, value]) => [key, value])),
    evidenceRole: post.evidenceRole,
  };
}

function projectMonthGroup(group: TimelineMonthGroup): TimelineMonthGroup {
  return {
    year: group.year,
    months: group.months.map((month) => ({ month: month.month, count: month.count })),
  };
}
