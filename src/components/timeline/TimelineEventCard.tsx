import { AlertTriangle, ChevronDown, ExternalLink, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PlatformIdentity } from "@/components/PlatformLogo";
import { PLATFORM_VALUES, type Platform } from "@/lib/graph/types";
import type {
  PublishedTimelineEvent,
  PublishedTimelineEventDetail,
  TimelineEvidenceDetail,
  TimelinePostEvidence,
  TimelineSourcePreview,
} from "@/lib/timeline/contracts";
import { splitTimelineDetailSources } from "@/lib/timeline/detail-sources";
import { TIMELINE_CATEGORY_LABELS } from "@/lib/timeline/taxonomy";
import { loadTimelineEventDetail } from "./client";
import styles from "./CompanyTimeline.module.css";

interface TimelineEventCardProps {
  event: PublishedTimelineEvent;
}

const PLATFORM_SET = new Set<string>(PLATFORM_VALUES);

export function TimelineEventCard({ event }: TimelineEventCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<PublishedTimelineEventDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const detailId = `timeline-event-detail-${safeDomId(event.id)}`;
  const titleId = `timeline-event-title-${safeDomId(event.id)}`;
  const summaryId = `timeline-event-summary-${safeDomId(event.id)}`;

  useEffect(() => () => abortRef.current?.abort(), []);

  async function toggleExpanded() {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    if (!nextExpanded) {
      abortRef.current?.abort();
      abortRef.current = null;
      setLoading(false);
      return;
    }
    if (detail || loading) return;

    await fetchDetail();
  }

  async function fetchDetail() {
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const payload = await loadTimelineEventDetail(event.id, controller.signal);
      if (controller.signal.aborted) return;
      setDetail(payload.event);
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(caught instanceof Error ? caught.message : "Event evidence could not be loaded.");
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        if (abortRef.current === controller) abortRef.current = null;
      }
    }
  }

  return (
    <article className={`${styles.eventCard} ${event.isMajor ? styles.majorEvent : ""}`}>
      <div className={styles.eventCollapsed}>
        <span className={styles.eventDate}>
          <time dateTime={event.eventDate}>{formatExactDate(event.eventDate)}</time>
          {event.isMajor ? <strong>Major event</strong> : null}
        </span>
        <span className={styles.eventTitleRow}>
          <span>
            <span className={styles.category}>{TIMELINE_CATEGORY_LABELS[event.category]}</span>
            <h5 id={titleId}>{event.title}</h5>
          </span>
          <ChevronDown className={styles.expandIcon} size={20} aria-hidden="true" />
        </span>
        <p className={styles.eventSummary} id={summaryId}>{event.summary}</p>
        <span className={styles.evidenceCount}>
          {event.evidenceCount} {event.evidenceCount === 1 ? "source" : "sources"}
        </span>
        {event.hasConflict ? (
          <span className={styles.conflictWarning}>
            <AlertTriangle size={16} aria-hidden="true" />
            {event.conflictSummary || "Sources disagree on part of this event."}
          </span>
        ) : null}
        <button
          type="button"
          className={styles.eventToggle}
          aria-expanded={expanded}
          aria-controls={detailId}
          aria-labelledby={titleId}
          aria-describedby={summaryId}
          onClick={() => void toggleExpanded()}
        >
          <span className="sr-only">{expanded ? "Collapse" : "Expand"} event evidence</span>
        </button>
      </div>

      {expanded ? (
        <div id={detailId} className={styles.eventDetail} role="region" aria-label={`Evidence for ${event.title}`}>
          {loading ? (
            <div className={styles.detailStatus} role="status">
              <LoaderCircle className={styles.spinner} size={18} aria-hidden="true" />
              Loading evidence…
            </div>
          ) : null}
          {error ? (
            <div className={styles.detailError} role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => void fetchDetail()}>Retry</button>
            </div>
          ) : null}
          {detail ? <EventEvidence detail={detail} /> : null}
          {!loading && !error && !detail && event.sourcePreview.length ? (
            <SourceList sources={event.sourcePreview} />
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function EventEvidence({ detail }: { detail: PublishedTimelineEventDetail }) {
  // The HTTP projection already assigns a URL to one section. Keep this
  // defensive split because cached/static v1 details created before that
  // projection can still contain the original source-document/post pair.
  const sources = splitTimelineDetailSources(detail.eventDate, detail.evidence, detail.posts);
  return (
    <div className={styles.evidenceSections}>
      {detail.hasConflict ? (
        <div className={styles.conflictDetail}>
          <strong><AlertTriangle size={16} aria-hidden="true" /> Conflicting evidence</strong>
          <p>{detail.conflictSummary || "Sources disagree on part of this event."}</p>
          <dl className={styles.conflictSelection}>
            <div>
              <dt>Selected date</dt>
              <dd><time dateTime={detail.eventDate}>{formatExactDate(detail.eventDate)}</time></dd>
            </div>
            <div>
              <dt>Why selected</dt>
              <dd>{conflictSelectionRationale(detail)}</dd>
            </div>
          </dl>
        </div>
      ) : null}

      {sources.evidence.length ? (
        <section aria-labelledby={`sources-${safeDomId(detail.id)}`}>
          <h6 id={`sources-${safeDomId(detail.id)}`}>Web evidence</h6>
          <SourceList sources={sources.evidence} selectedEventDate={detail.eventDate} />
        </section>
      ) : null}

      {sources.posts.length ? (
        <section aria-labelledby={`posts-${safeDomId(detail.id)}`}>
          <h6 id={`posts-${safeDomId(detail.id)}`}>Related posts</h6>
          <ul className={styles.sourceList}>
            {sources.posts.map((post) => <PostEvidence post={post} key={post.id} />)}
          </ul>
        </section>
      ) : null}

      {!sources.evidence.length && !sources.posts.length ? (
        <p className={styles.noDetails}>No additional source detail is available.</p>
      ) : null}
    </div>
  );
}

function SourceList({
  sources,
  selectedEventDate = null,
}: {
  sources: Array<TimelineSourcePreview | TimelineEvidenceDetail>;
  selectedEventDate?: string | null;
}) {
  return (
    <ul className={styles.sourceList}>
      {sources.map((source) => (
        <li key={source.id}>
          <div className={styles.sourceMeta}>
            <span>{source.evidenceRole}</span>
            <span>{sourceTypeLabel(source.sourceType)}</span>
            {(source.publishedAt || ("publicationDate" in source && source.publicationDate)) ? (
              <time dateTime={source.publishedAt ?? ("publicationDate" in source ? source.publicationDate ?? undefined : undefined)}>
                {formatExactDate((source.publishedAt ?? ("publicationDate" in source ? source.publicationDate : null))!)}
              </time>
            ) : null}
          </div>
          <a href={source.url} target="_blank" rel="noopener noreferrer nofollow">
            <span>
              <strong>{source.title}</strong>
              <small>{source.publisher || source.domain}</small>
            </span>
            <ExternalLink size={16} aria-label="Open source in a new tab" />
          </a>
          {"excerpt" in source && source.excerpt ? <blockquote>{source.excerpt}</blockquote> : null}
          {"sourceEventDate" in source
            && source.isConflicting
            && source.sourceEventDate
            && source.sourceEventDate !== selectedEventDate ? (
              <p className={styles.sourceClaim}>
                <strong>Alternate event date</strong>
                <time dateTime={source.sourceEventDate}>{formatExactDate(source.sourceEventDate)}</time>
              </p>
            ) : null}
          {"isConflicting" in source && source.isConflicting ? (
            <p className={styles.sourceConflict}>
              <AlertTriangle size={14} aria-hidden="true" />
              {source.conflictDescription || "This source contains a conflicting claim."}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function conflictSelectionRationale(detail: PublishedTimelineEventDetail): string {
  const selectedEvidence = detail.evidence.filter((source) => source.sourceEventDate === detail.eventDate);
  if (selectedEvidence.some((source) => source.evidenceRole === "primary")) {
    return "This exact date is supported by primary evidence; alternate directly evidenced dates remain listed below.";
  }
  if (selectedEvidence.length) {
    return "This exact date has direct supporting evidence; alternate directly evidenced dates remain listed below.";
  }
  return "This is the reviewed exact date selected for the event; alternate directly evidenced dates remain listed below.";
}

function PostEvidence({ post }: { post: TimelinePostEvidence }) {
  const metrics = Object.entries(post.metrics).filter((entry): entry is [string, number] => typeof entry[1] === "number");
  return (
    <li>
      <div className={styles.sourceMeta}>
        <span>{post.evidenceRole}</span>
        <time dateTime={post.postDate}>{formatExactDate(post.postDate)}</time>
      </div>
      <a href={post.url} target="_blank" rel="noopener noreferrer nofollow">
        <span>
          <strong className={styles.postPlatform}>
            {isPlatform(post.platform) ? <PlatformIdentity platform={post.platform} /> : post.platform}
          </strong>
          <small>{post.account || "Official public post"}</small>
        </span>
        <ExternalLink size={16} aria-label="Open post in a new tab" />
      </a>
      {post.excerpt ? <blockquote>{post.excerpt}</blockquote> : null}
      {metrics.length ? (
        <dl className={styles.postMetrics}>
          {metrics.map(([label, value]) => (
            <div key={label}><dt>{humanize(label)}</dt><dd>{value.toLocaleString("en-US")}</dd></div>
          ))}
        </dl>
      ) : null}
    </li>
  );
}

export function formatExactDate(value: string): string {
  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return value;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

function sourceTypeLabel(value: string): string {
  return humanize(value);
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function isPlatform(value: string): value is Platform {
  return PLATFORM_SET.has(value);
}

function safeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}
