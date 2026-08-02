"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FileClock,
  History,
  LockKeyhole,
  RefreshCw,
  RotateCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  TIMELINE_CATEGORIES,
  TIMELINE_EVENT_DATE_TYPES,
  type TimelineAdminEventDetail,
  type TimelineCandidateDetail,
  type TimelineCandidateSummary,
  type TimelineCategory,
  type TimelineCompanyCoverageSummary,
  type TimelineEventDateType,
  type TimelineEvidenceRole,
  type TimelineSourceDocumentAdmin,
} from "@/lib/timeline/contracts";
import { TIMELINE_SOURCE_CLASSES } from "@/lib/timeline/coordinator";
import styles from "./admin-timeline.module.css";

type AdminView = "coverage" | "review" | "events";
type EventActionKind =
  | "publish" | "unpublish" | "reject" | "edit" | "merge" | "split"
  | "attach_evidence" | "remove_evidence" | "add_conflict_note" | "resolve_conflict"
  | "re_evaluate";

interface ListResponse<T> {
  generatedAt: string;
  items: T[];
  nextCursor: string | null;
  error?: { message?: string };
}

interface ActionResponse {
  status?: string;
  result?: { auditId?: string; cacheInvalidated?: boolean };
  error?: { message?: string };
}

export default function AdminTimelinePage() {
  const allowActorOverride = process.env.NODE_ENV !== "production";
  const [view, setView] = useState<AdminView>("coverage");
  const [secret, setSecret] = useState("");
  const [appliedSecret, setAppliedSecret] = useState("");
  const [actorId, setActorId] = useState("timeline-admin");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [coverage, setCoverage] = useState<TimelineCompanyCoverageSummary[]>([]);
  const [candidates, setCandidates] = useState<TimelineCandidateSummary[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadedRequestUrl, setLoadedRequestUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [actionInFlight, setActionInFlight] = useState<string | null>(null);
  const [reviewReason, setReviewReason] = useState("Reviewed against the attached direct evidence.");
  const [mergeTarget, setMergeTarget] = useState<Record<string, string>>({});
  const [expandedCandidateId, setExpandedCandidateId] = useState<string | null>(null);
  const [candidateDetails, setCandidateDetails] = useState<Record<string, TimelineCandidateDetail>>({});
  const [candidateDetailLoading, setCandidateDetailLoading] = useState<string | null>(null);
  const [sourceDetails, setSourceDetails] = useState<Record<string, TimelineSourceDocumentAdmin>>({});
  const [expandedSourceId, setExpandedSourceId] = useState<string | null>(null);
  const [eventId, setEventId] = useState("");
  const [eventAction, setEventAction] = useState<EventActionKind>("publish");
  const [eventReason, setEventReason] = useState("");
  const [eventDetail, setEventDetail] = useState<TimelineAdminEventDetail | null>(null);
  const [eventDetailLoading, setEventDetailLoading] = useState(false);
  const [eventEditTitle, setEventEditTitle] = useState("");
  const [eventEditSummary, setEventEditSummary] = useState("");
  const [eventEditDate, setEventEditDate] = useState("");
  const [eventEditDateType, setEventEditDateType] = useState<TimelineEventDateType>("announcement_date");
  const [eventEditCategory, setEventEditCategory] = useState<TimelineCategory>("other");
  const [eventEditMajor, setEventEditMajor] = useState(false);
  const [eventRelatedIds, setEventRelatedIds] = useState("");
  const [eventSourceDocumentId, setEventSourceDocumentId] = useState("");
  const [eventEvidenceRole, setEventEvidenceRole] = useState<TimelineEvidenceRole>("supporting");
  const [eventResolution, setEventResolution] = useState("");
  const paginationAbortRef = useRef<AbortController | null>(null);

  const requestUrl = useMemo(() => {
    if (view === "events") return null;
    const params = new URLSearchParams({ limit: "100" });
    if (query.trim()) params.set("q", query.trim());
    if (status) params.set("status", status);
    return `/api/admin/timeline/${view === "coverage" ? "coverage" : "review"}?${params}`;
  }, [query, status, view]);

  const loadData = useCallback(async (signal?: AbortSignal) => {
    paginationAbortRef.current?.abort();
    paginationAbortRef.current = null;
    setLoadingMore(false);
    if (!requestUrl) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(requestUrl, {
        cache: "no-store",
        headers: appliedSecret ? { Authorization: `Bearer ${appliedSecret}` } : undefined,
        signal,
      });
      const body = await response.json() as ListResponse<TimelineCompanyCoverageSummary | TimelineCandidateSummary>;
      if (!response.ok) throw new Error(body.error?.message ?? `Request failed (${response.status}).`);
      if (view === "coverage") setCoverage(body.items as TimelineCompanyCoverageSummary[]);
      else setCandidates(body.items as TimelineCandidateSummary[]);
      setGeneratedAt(body.generatedAt);
      setNextCursor(body.nextCursor);
      setLoadedRequestUrl(requestUrl);
      setError(null);
    } catch (caught) {
      if (signal?.aborted) return;
      setError(caught instanceof Error ? caught.message : "Timeline admin data could not be loaded.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [appliedSecret, requestUrl, view]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadData(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadData, refreshKey]);

  useEffect(() => () => paginationAbortRef.current?.abort(), []);

  function selectView(nextView: AdminView) {
    paginationAbortRef.current?.abort();
    setView(nextView);
    setStatus("");
    setError(null);
    setNotice(null);
  }

  function moveTabFocus(event: React.KeyboardEvent<HTMLElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    if (!tabs.length) return;
    const currentIndex = Math.max(0, tabs.indexOf(document.activeElement as HTMLButtonElement));
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    tabs[nextIndex]?.focus();
    tabs[nextIndex]?.click();
  }

  function authenticateAndRefresh() {
    setAppliedSecret(secret);
    setRefreshKey((value) => value + 1);
  }

  async function runAction(key: string, command: object) {
    setActionInFlight(key);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/timeline/actions", {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          ...(appliedSecret ? { Authorization: `Bearer ${appliedSecret}` } : {}),
          ...(allowActorOverride && actorId.trim() ? { "x-admin-actor-id": actorId.trim() } : {}),
        },
        body: JSON.stringify(command),
      });
      const body = await response.json() as ActionResponse;
      if (!response.ok) throw new Error(body.error?.message ?? `Action failed (${response.status}).`);
      setNotice(`Action completed${body.result?.auditId ? ` · audit ${body.result.auditId}` : ""}.`);
      if (key.startsWith("event:")) setEventDetail(null);
      setRefreshKey((value) => value + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Timeline action failed.");
    } finally {
      setActionInFlight(null);
    }
  }

  async function loadNextPage() {
    const cursor = loadedRequestUrl === requestUrl ? nextCursor : null;
    if (!requestUrl || !cursor || loading || loadingMore) return;
    paginationAbortRef.current?.abort();
    const controller = new AbortController();
    paginationAbortRef.current = controller;
    const requestedView = view;
    const url = new URL(requestUrl, window.location.origin);
    url.searchParams.set("cursor", cursor);
    setLoadingMore(true);
    setError(null);
    try {
      const response = await fetch(`${url.pathname}${url.search}`, {
        cache: "no-store",
        headers: appliedSecret ? { Authorization: `Bearer ${appliedSecret}` } : undefined,
        signal: controller.signal,
      });
      const body = await response.json() as ListResponse<TimelineCompanyCoverageSummary | TimelineCandidateSummary>;
      if (!response.ok) throw new Error(body.error?.message ?? `Request failed (${response.status}).`);
      if (controller.signal.aborted || requestedView !== view) return;
      if (requestedView === "coverage") {
        setCoverage((current) => mergeById(current, body.items as TimelineCompanyCoverageSummary[], (item) => item.company.id));
      } else {
        setCandidates((current) => mergeById(current, body.items as TimelineCandidateSummary[], (item) => item.id));
      }
      setGeneratedAt(body.generatedAt);
      setNextCursor(body.nextCursor);
      setLoadedRequestUrl(requestUrl);
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(caught instanceof Error ? caught.message : "More timeline admin records could not be loaded.");
      }
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false);
      if (paginationAbortRef.current === controller) paginationAbortRef.current = null;
    }
  }

  async function inspectCandidate(candidateId: string) {
    if (expandedCandidateId === candidateId) {
      setExpandedCandidateId(null);
      return;
    }
    setExpandedCandidateId(candidateId);
    if (candidateDetails[candidateId]) return;
    setCandidateDetailLoading(candidateId);
    setError(null);
    try {
      const response = await fetch(`/api/admin/timeline/review/${encodeURIComponent(candidateId)}`, {
        cache: "no-store",
        headers: appliedSecret ? { Authorization: `Bearer ${appliedSecret}` } : undefined,
      });
      const body = await response.json() as { candidate?: TimelineCandidateDetail; error?: { message?: string } };
      if (!response.ok || !body.candidate) {
        throw new Error(body.error?.message ?? `Candidate detail failed (${response.status}).`);
      }
      setCandidateDetails((value) => ({ ...value, [candidateId]: body.candidate as TimelineCandidateDetail }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Candidate detail could not be loaded.");
    } finally {
      setCandidateDetailLoading(null);
    }
  }

  async function inspectSource(sourceId: string) {
    if (expandedSourceId === sourceId) {
      setExpandedSourceId(null);
      return;
    }
    setExpandedSourceId(sourceId);
    if (sourceDetails[sourceId]) return;
    setError(null);
    try {
      const response = await fetch(`/api/admin/timeline/sources/${encodeURIComponent(sourceId)}`, {
        cache: "no-store",
        headers: appliedSecret ? { Authorization: `Bearer ${appliedSecret}` } : undefined,
      });
      const body = await response.json() as { source?: TimelineSourceDocumentAdmin; error?: { message?: string } };
      if (!response.ok || !body.source) {
        throw new Error(body.error?.message ?? `Source detail failed (${response.status}).`);
      }
      setSourceDetails((value) => ({ ...value, [sourceId]: body.source as TimelineSourceDocumentAdmin }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Source detail could not be loaded.");
    }
  }

  async function inspectEvent() {
    const normalizedId = eventId.trim();
    if (!normalizedId || eventDetailLoading) return;
    setEventDetailLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/timeline/events/${encodeURIComponent(normalizedId)}`, {
        cache: "no-store",
        headers: appliedSecret ? { Authorization: `Bearer ${appliedSecret}` } : undefined,
      });
      const body = await response.json() as { eventDetail?: TimelineAdminEventDetail; error?: { message?: string } };
      if (!response.ok || !body.eventDetail) {
        throw new Error(body.error?.message ?? `Event detail failed (${response.status}).`);
      }
      setEventDetail(body.eventDetail);
      setEventEditTitle(body.eventDetail.event.title);
      setEventEditSummary(body.eventDetail.event.summary);
      setEventEditDate(body.eventDetail.event.eventDate);
      setEventEditDateType(body.eventDetail.event.eventDateType);
      setEventEditCategory(body.eventDetail.event.category);
      setEventEditMajor(body.eventDetail.event.isMajor);
      setEventRelatedIds("");
      setEventSourceDocumentId("");
      setEventResolution(body.eventDetail.event.conflictSummary ?? "");
    } catch (caught) {
      setEventDetail(null);
      setError(caught instanceof Error ? caught.message : "Timeline event detail could not be loaded.");
    } finally {
      setEventDetailLoading(false);
    }
  }

  const summary = summarizeCoverage(coverage);
  const visibleNextCursor = loadedRequestUrl === requestUrl ? nextCursor : null;
  const eventActionReady = canApplyEventAction({
    eventId,
    eventDetail,
    eventReason,
    eventAction,
    eventEditTitle,
    eventEditSummary,
    eventEditDate,
    eventRelatedIds,
    eventSourceDocumentId,
    eventResolution,
  });

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.kicker}>Admin / Timeline</p>
          <h1>Company Timeline operations</h1>
          <p className={styles.subtitle}>Coverage, evidence review, publication controls, and cache recovery.</p>
          <div className={styles.freshness}>
            <ShieldCheck size={15} aria-hidden="true" />
            Protected admin data
            {generatedAt ? <time dateTime={generatedAt}>Updated {formatTime(generatedAt)}</time> : null}
          </div>
        </div>
        <div className={styles.headerActions}>
          <a href="/admin/ingestion">Ingestion diagnostics</a>
          {allowActorOverride ? <label className={styles.compactField}>
            <span>Actor override (local only)</span>
            <input value={actorId} onChange={(event) => setActorId(event.target.value)} autoComplete="username" />
          </label> : null}
          <label className={styles.secretField}>
            <LockKeyhole size={15} aria-hidden="true" />
            <input
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder="Admin secret"
              autoComplete="current-password"
              aria-label="Timeline admin secret"
            />
          </label>
          <button className={styles.iconButton} type="button" onClick={authenticateAndRefresh} aria-label="Authenticate and refresh timeline admin data">
            <RefreshCw size={18} aria-hidden="true" className={loading ? styles.spinning : ""} />
          </button>
        </div>
      </header>

      <nav className={styles.tabs} aria-label="Timeline admin views" role="tablist" onKeyDown={moveTabFocus}>
        <Tab id="timeline-coverage-tab" controls="timeline-coverage-panel" active={view === "coverage"} onClick={() => selectView("coverage")} icon={<History size={16} />} label="Coverage" />
        <Tab id="timeline-review-tab" controls="timeline-review-panel" active={view === "review"} onClick={() => selectView("review")} icon={<FileClock size={16} />} label="Review queue" />
        <Tab id="timeline-events-tab" controls="timeline-events-panel" active={view === "events"} onClick={() => selectView("events")} icon={<ShieldCheck size={16} />} label="Event actions" />
      </nav>

      {view !== "events" ? (
        <section className={styles.toolbar} aria-label="Timeline admin filters">
          <label className={styles.searchField}>
            <Search size={16} aria-hidden="true" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search companies or candidates" aria-label="Search timeline admin records" />
          </label>
          <label>
            <span>Status</span>
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">All statuses</option>
              {(view === "coverage"
                ? ["pending", "running", "completed", "partial", "failed"]
                : ["needs_review", "pending", "processing", "accepted", "rejected", "merged"]
              ).map((value) => <option value={value} key={value}>{humanize(value)}</option>)}
            </select>
          </label>
          <button type="button" onClick={() => setRefreshKey((value) => value + 1)} className={styles.secondaryButton}>
            <RotateCw size={15} aria-hidden="true" /> Refresh
          </button>
        </section>
      ) : null}

      {error ? <div className={styles.error} role="alert"><AlertTriangle size={17} aria-hidden="true" />{error}</div> : null}
      {notice ? <div className={styles.notice} role="status"><CheckCircle2 size={17} aria-hidden="true" />{notice}</div> : null}

      {view === "coverage" ? (
        <div id="timeline-coverage-panel" role="tabpanel" aria-labelledby="timeline-coverage-tab">
          <section className={styles.metricGrid} aria-label="Timeline coverage summary">
            <Metric label="Companies loaded" value={coverage.length} />
            <Metric label="Backfill complete" value={summary.complete} />
            <Metric label="Published events" value={summary.published} />
            <Metric label="Review candidates" value={summary.candidates} />
            <Metric label="Unresolved dates" value={summary.unresolvedDates} warning={summary.unresolvedDates > 0} />
            <Metric label="Conflicts" value={summary.conflicts} warning={summary.conflicts > 0} />
            <Metric label="Failed sources" value={summary.failedSources} warning={summary.failedSources > 0} />
            <Metric label="Dead-letter tasks" value={summary.deadLetters} warning={summary.deadLetters > 0} />
            <Metric label="Caches needing attention" value={summary.cacheAttention} warning={summary.cacheAttention > 0} />
          </section>
          <CoverageTable
            items={coverage}
            loading={loading}
            actionInFlight={actionInFlight}
            onAction={runAction}
          />
          {visibleNextCursor ? (
            <button
              type="button"
              className={styles.loadMoreButton}
              disabled={loading || loadingMore}
              onClick={() => void loadNextPage()}
            >
              {loadingMore ? "Loading more companies…" : "Load more companies"}
            </button>
          ) : null}
        </div>
      ) : null}

      {view === "review" ? (
        <section id="timeline-review-panel" role="tabpanel" aria-labelledby="timeline-review-tab" className={styles.reviewLayout} aria-busy={loading}>
          <label className={styles.reasonField}>
            <span>Audit reason applied to review actions</span>
            <textarea value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} rows={2} />
          </label>
          {!loading && candidates.length === 0 ? <Empty label="No candidates match these filters." /> : null}
          {candidates.map((candidate) => (
            <article className={styles.candidateCard} key={candidate.id}>
              <div className={styles.candidateHeading}>
                <div>
                  <span className={styles.status} data-status={candidate.status}>{humanize(candidate.status)}</span>
                  <h2>{candidate.proposedTitle ?? "Untitled candidate"}</h2>
                </div>
                <time dateTime={candidate.proposedDate ?? undefined}>{candidate.proposedDate ?? "Exact date unresolved"}</time>
              </div>
              <p>{candidate.proposedSummary ?? "No proposed summary."}</p>
              <dl className={styles.candidateMeta}>
                <div><dt>Candidate</dt><dd>{candidate.id}</dd></div>
                <div><dt>Company</dt><dd>{candidate.companyId}</dd></div>
                <div><dt>Category</dt><dd>{candidate.proposedCategory ? humanize(candidate.proposedCategory) : "Unresolved"}</dd></div>
                <div><dt>Sources</dt><dd>{candidate.sourceIds.length}</dd></div>
              </dl>
              {candidate.rejectionReason ? <p className={styles.rejection}>Prior rejection: {candidate.rejectionReason}</p> : null}
              <button
                type="button"
                className={styles.inspectButton}
                aria-expanded={expandedCandidateId === candidate.id}
                onClick={() => void inspectCandidate(candidate.id)}
              >
                {candidateDetailLoading === candidate.id ? "Loading evidence…" : expandedCandidateId === candidate.id ? "Hide evidence" : "Inspect evidence and duplicate checks"}
              </button>
              {expandedCandidateId === candidate.id && candidateDetails[candidate.id] ? (
                <CandidateDetail
                  detail={candidateDetails[candidate.id]}
                  expandedSourceId={expandedSourceId}
                  sourceDetails={sourceDetails}
                  onInspectSource={inspectSource}
                />
              ) : null}
              <div className={styles.cardActions}>
                <button
                  type="button"
                  disabled={reviewReason.trim().length < 3 || actionInFlight !== null}
                  onClick={() => void runAction(`publish:${candidate.id}`, {
                    scope: "candidate",
                    action: { type: "publish_candidate", candidateId: candidate.id, reason: reviewReason.trim() },
                  })}
                >Publish</button>
                <button
                  type="button"
                  className={styles.dangerButton}
                  disabled={reviewReason.trim().length < 3 || actionInFlight !== null}
                  onClick={() => void runAction(`reject:${candidate.id}`, {
                    scope: "candidate",
                    action: { type: "reject_candidate", candidateId: candidate.id, reason: reviewReason.trim() },
                  })}
                >Reject</button>
                <label className={styles.mergeField}>
                  <span>Existing event ID</span>
                  <input
                    value={mergeTarget[candidate.id] ?? ""}
                    onChange={(event) => setMergeTarget((value) => ({ ...value, [candidate.id]: event.target.value }))}
                    placeholder="event-id"
                  />
                </label>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={!mergeTarget[candidate.id]?.trim() || reviewReason.trim().length < 3 || actionInFlight !== null}
                  onClick={() => void runAction(`merge:${candidate.id}`, {
                    scope: "candidate",
                    action: {
                      type: "merge_candidate",
                      candidateId: candidate.id,
                      targetEventId: mergeTarget[candidate.id].trim(),
                      reason: reviewReason.trim(),
                    },
                  })}
                >Merge duplicate</button>
              </div>
            </article>
          ))}
          {visibleNextCursor ? (
            <button
              type="button"
              className={styles.loadMoreButton}
              disabled={loading || loadingMore}
              onClick={() => void loadNextPage()}
            >
              {loadingMore ? "Loading more candidates…" : "Load more candidates"}
            </button>
          ) : null}
        </section>
      ) : null}

      {view === "events" ? (
        <section id="timeline-events-panel" role="tabpanel" aria-labelledby="timeline-events-tab" className={styles.eventConsole}>
          <div>
            <p className={styles.kicker}>Audited correction</p>
            <h2>Apply an event-level action</h2>
            <p>Every mutation is validated server-side, recorded with the actor and reason, and invalidates affected timeline caches.</p>
          </div>
          <label><span>Event ID</span><input value={eventId} onChange={(event) => { setEventId(event.target.value); setEventDetail(null); }} placeholder="Timeline event ID" /></label>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={!eventId.trim() || eventDetailLoading}
            onClick={() => void inspectEvent()}
          >
            {eventDetailLoading ? "Loading event…" : "Inspect event before editing"}
          </button>
          {eventDetail ? <AdminEventInspection detail={eventDetail} /> : null}
          <label>
            <span>Action</span>
            <select value={eventAction} onChange={(event) => setEventAction(event.target.value as EventActionKind)}>
              <option value="publish">Publish</option>
              <option value="unpublish">Unpublish</option>
              <option value="reject">Reject</option>
              <option value="re_evaluate">Re-evaluate from durable evidence</option>
              <option value="edit">Edit public fields</option>
              <option value="merge">Merge other events into this event</option>
              <option value="split">Split evidence into a new event</option>
              <option value="attach_evidence">Attach evidence</option>
              <option value="remove_evidence">Remove evidence</option>
              <option value="add_conflict_note">Add conflict note</option>
              <option value="resolve_conflict">Resolve conflict</option>
            </select>
          </label>
          {eventAction === "edit" ? (
            <fieldset className={styles.actionFields}>
              <legend>Public event fields</legend>
              <label><span>Title</span><input value={eventEditTitle} onChange={(event) => setEventEditTitle(event.target.value)} /></label>
              <label className={styles.wideField}><span>Summary</span><textarea rows={3} value={eventEditSummary} onChange={(event) => setEventEditSummary(event.target.value)} /></label>
              <label><span>Exact date</span><input type="date" value={eventEditDate} onChange={(event) => setEventEditDate(event.target.value)} /></label>
              <label><span>Date semantics</span><select value={eventEditDateType} onChange={(event) => setEventEditDateType(event.target.value as TimelineEventDateType)}>{TIMELINE_EVENT_DATE_TYPES.map((value) => <option value={value} key={value}>{humanize(value)}</option>)}</select></label>
              <label><span>Category</span><select value={eventEditCategory} onChange={(event) => setEventEditCategory(event.target.value as TimelineCategory)}>{TIMELINE_CATEGORIES.map((value) => <option value={value} key={value}>{humanize(value)}</option>)}</select></label>
              <label className={styles.checkboxField}><input type="checkbox" checked={eventEditMajor} onChange={(event) => setEventEditMajor(event.target.checked)} /><span>Major event</span></label>
            </fieldset>
          ) : null}
          {eventAction === "merge" || eventAction === "split" ? (
            <label>
              <span>{eventAction === "merge" ? "Source event IDs" : "Evidence source IDs"}</span>
              <textarea rows={3} value={eventRelatedIds} onChange={(event) => setEventRelatedIds(event.target.value)} placeholder="One ID per line or comma-separated" />
              {eventAction === "split" && eventDetail?.evidence.length ? <small>Available source IDs: {eventDetail.evidence.map((source) => source.id).join(", ")}</small> : null}
            </label>
          ) : null}
          {eventAction === "attach_evidence" || eventAction === "remove_evidence" ? (
            <fieldset className={styles.actionFields}>
              <legend>Evidence link</legend>
              <label><span>Source document ID</span><input value={eventSourceDocumentId} onChange={(event) => setEventSourceDocumentId(event.target.value)} placeholder="source-document-id" /></label>
              {eventAction === "attach_evidence" ? <label><span>Evidence role</span><select value={eventEvidenceRole} onChange={(event) => setEventEvidenceRole(event.target.value as TimelineEvidenceRole)}><option value="primary">Primary</option><option value="supporting">Supporting</option><option value="conflicting">Conflicting</option></select></label> : null}
            </fieldset>
          ) : null}
          {eventAction === "resolve_conflict" || eventAction === "add_conflict_note" ? (
            <label>
              <span>{eventAction === "resolve_conflict" ? "Conflict resolution" : "Conflict note"}</span>
              <textarea
                rows={3}
                value={eventResolution}
                onChange={(event) => setEventResolution(event.target.value)}
                placeholder={eventAction === "resolve_conflict" ? "Explain which evidence resolves the conflict" : "Describe the directly evidenced disagreement"}
              />
            </label>
          ) : null}
          <label><span>Reason</span><textarea rows={4} value={eventReason} onChange={(event) => setEventReason(event.target.value)} placeholder="Evidence-backed reason for this change" /></label>
          <button
            type="button"
            disabled={!eventActionReady || actionInFlight !== null}
            onClick={() => void runAction(`event:${eventId}`, eventCommand({
              eventId: eventId.trim(), action: eventAction, reason: eventReason.trim(),
              edit: { title: eventEditTitle.trim(), summary: eventEditSummary.trim(), eventDate: eventEditDate, eventDateType: eventEditDateType, category: eventEditCategory, isMajor: eventEditMajor },
              relatedIds: parseAdminIds(eventRelatedIds), sourceDocumentId: eventSourceDocumentId.trim(),
              evidenceRole: eventEvidenceRole, resolution: eventResolution.trim(),
            }))}
          >Apply audited action</button>
        </section>
      ) : null}
    </main>
  );
}

function Tab({ id, controls, active, onClick, icon, label }: { id: string; controls: string; active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return <button id={id} type="button" role="tab" tabIndex={active ? 0 : -1} aria-controls={controls} aria-selected={active} className={active ? styles.activeTab : ""} onClick={onClick}>{icon}{label}</button>;
}

function Metric({ label, value, warning = false }: { label: string; value: number; warning?: boolean }) {
  return <article className={styles.metric} data-warning={warning || undefined}><span>{label}</span><strong>{value.toLocaleString()}</strong></article>;
}

function CoverageTable({
  items,
  loading,
  actionInFlight,
  onAction,
}: {
  items: TimelineCompanyCoverageSummary[];
  loading: boolean;
  actionInFlight: string | null;
  onAction: (key: string, command: object) => Promise<void>;
}) {
  const [sourceClasses, setSourceClasses] = useState<Record<string, string>>({});
  if (loading && items.length === 0) return <Empty label="Loading company timeline coverage…" />;
  if (!loading && items.length === 0) return <Empty label="No companies match these filters." />;
  return <div className={styles.tableWrap}><table>
    <caption className="sr-only">Company Timeline coverage and operational health</caption>
    <thead><tr><th scope="col">Company</th><th scope="col">Backfill</th><th scope="col">Events</th><th scope="col">Candidates</th><th scope="col">Open issues</th><th scope="col">Failures</th><th scope="col">Scans</th><th scope="col">Cache</th><th scope="col">Source coverage</th><th scope="col">Actions</th></tr></thead>
    <tbody>{items.map((item) => <tr key={item.company.id}>
      <th scope="row"><strong>{item.company.name}</strong><small>{item.company.slug}</small></th>
      <td><span className={styles.status} data-status={item.historicalBackfillStatus}>{humanize(item.historicalBackfillStatus)}</span>{item.lastError ? <small className={styles.rowError}>{item.lastError}</small> : null}</td>
      <td>{item.publishedEventCount}</td>
      <td>{item.candidateEventCount}</td>
      <td>{item.unresolvedDateCount} dates · {item.unresolvedConflictCount} conflicts</td>
      <td className={styles.failureCell} data-warning={(item.failedSourceCount > 0 || item.deadLetterTaskCount > 0) || undefined}>
        <small>{item.failedSourceCount} failed {pluralize(item.failedSourceCount, "source")}</small>
        <small>{item.deadLetterTaskCount} dead-letter {pluralize(item.deadLetterTaskCount, "task")}</small>
      </td>
      <td className={styles.scanCell}>
        <Timestamp label="Incremental" value={item.lastIncrementalScanAt} />
        <Timestamp label="Deep" value={item.lastDeepScanAt} />
        <Timestamp label="Artifact" value={item.lastSuccessfulArtifactAt} />
      </td>
      <td><span className={styles.status} data-status={item.cacheStatus} aria-label={`Cache status: ${humanize(item.cacheStatus)}`}>{humanize(item.cacheStatus)}</span></td>
      <td>{sourceCoverageLabel(item.sourceCoverage)}</td>
      <td><div className={styles.rowActions}>
        <a href={`/?node=${encodeURIComponent(`company:${item.company.id}`)}&view=timeline`} target="_blank" rel="noreferrer" aria-label={`Open ${item.company.name} public timeline`}><ExternalLink size={15} /></a>
        <button
          type="button"
          disabled={actionInFlight !== null}
          onClick={() => void onAction(`rerun:${item.company.id}`, { scope: "company", action: { type: "rerun_discovery", companyId: item.company.id } })}
        >Re-run</button>
        <label className={styles.rowSourceField}>
          <span className="sr-only">Source class for {item.company.name}</span>
          <select
            aria-label={`Source class for ${item.company.name}`}
            value={sourceClasses[item.company.id] ?? "timeline_official_site"}
            onChange={(event) => setSourceClasses((current) => ({ ...current, [item.company.id]: event.target.value }))}
          >
            {TIMELINE_SOURCE_CLASSES.map((sourceClass) => (
              <option value={sourceClass} key={sourceClass}>{humanize(sourceClass.replace(/^timeline_/, ""))}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={actionInFlight !== null}
          onClick={() => void onAction(`rerun-source:${item.company.id}`, { scope: "company", action: { type: "rerun_source", companyId: item.company.id, sourceClass: sourceClasses[item.company.id] ?? "timeline_official_site" } })}
        >Re-run source</button>
        <button
          type="button"
          disabled={actionInFlight !== null}
          onClick={() => void onAction(`reclassify:${item.company.id}`, { scope: "company", action: { type: "reclassify", companyId: item.company.id } })}
        >Reclassify</button>
        <button
          type="button"
          disabled={actionInFlight !== null}
          onClick={() => void onAction(`rebuild:${item.company.id}`, { scope: "company", action: { type: "rebuild_artifact", companyId: item.company.id } })}
        >Rebuild cache</button>
      </div></td>
    </tr>)}</tbody>
  </table></div>;
}

function CandidateDetail({
  detail,
  expandedSourceId,
  sourceDetails,
  onInspectSource,
}: {
  detail: TimelineCandidateDetail;
  expandedSourceId: string | null;
  sourceDetails: Record<string, TimelineSourceDocumentAdmin>;
  onInspectSource: (sourceId: string) => Promise<void>;
}) {
  return <section className={styles.candidateDetail} aria-label="Candidate evidence detail">
    <dl className={styles.candidateMeta}>
      <div><dt>Importance</dt><dd>{detail.proposedImportance ?? "Unresolved"}</dd></div>
      <div><dt>Merge key</dt><dd>{detail.proposedMergeKey ?? "None"}</dd></div>
      <div><dt>Classifier</dt><dd>{detail.classifierVersion}</dd></div>
      <div><dt>Extractor</dt><dd>{detail.extractionVersion}</dd></div>
    </dl>
    {detail.conflicts.length ? <div className={styles.conflictList}>
      <h3><AlertTriangle size={16} aria-hidden="true" /> Conflicting claims</h3>
      {detail.conflicts.map((conflict) => <article key={`${conflict.field}:${conflict.description}`}>
        <strong>{humanize(conflict.field)}</strong>
        <p>{conflict.description}</p>
        <small>Selected: {conflict.selectedValue ?? "No value selected"} · {conflict.alternateClaims.length} alternate claims</small>
      </article>)}
    </div> : null}
    {detail.potentialDuplicates.length ? <div className={styles.duplicateList}>
      <h3>Potential duplicates</h3>
      {detail.potentialDuplicates.map((duplicate) => <article key={duplicate.eventId}>
        <strong>{duplicate.title}</strong>
        <span>{duplicate.eventDate} · {humanize(duplicate.category)}</span>
        <small>{duplicate.deterministicMatchReasons.join(" · ")}</small>
      </article>)}
    </div> : null}
    <div className={styles.sourceList}>
      <h3>Evidence sources ({detail.sources.length})</h3>
      {detail.sources.map((source) => <article key={source.id}>
        <div>
          <span className={styles.status} data-status={source.evidenceRole}>{humanize(source.evidenceRole)}</span>
          <strong>{source.title}</strong>
          <small>{source.publisher ?? source.domain} · {humanize(source.sourceType)}</small>
          {source.excerpt ? <p>{source.excerpt}</p> : null}
        </div>
        <div className={styles.sourceActions}>
          <a href={source.url} target="_blank" rel="noopener noreferrer">Open source <ExternalLink size={14} /></a>
          <button type="button" className={styles.secondaryButton} aria-expanded={expandedSourceId === source.id} onClick={() => void onInspectSource(source.id)}>Inspect record</button>
        </div>
        {expandedSourceId === source.id && sourceDetails[source.id] ? <SourceDocumentDetail source={sourceDetails[source.id]} /> : null}
      </article>)}
    </div>
  </section>;
}

function AdminEventInspection({ detail }: { detail: TimelineAdminEventDetail }) {
  return <article className={styles.eventInspection} aria-label="Inspected timeline event">
    <div>
      <span className={styles.status} data-status={detail.event.status}>{humanize(detail.event.status)}</span>
      <h3>{detail.event.title}</h3>
      <p>{detail.event.summary}</p>
    </div>
    <dl className={styles.candidateMeta}>
      <div><dt>Date</dt><dd>{detail.event.eventDate}</dd></div>
      <div><dt>Category</dt><dd>{humanize(detail.event.category)}</dd></div>
      <div><dt>Evidence</dt><dd>{detail.event.evidenceCount}</dd></div>
      <div><dt>Audit entries</dt><dd>{detail.auditHistory.length}</dd></div>
    </dl>
    {detail.event.hasConflict ? <p className={styles.rejection}>{detail.event.conflictSummary ?? "This event has unresolved conflicting evidence."}</p> : null}
  </article>;
}

function SourceDocumentDetail({ source }: { source: TimelineSourceDocumentAdmin }) {
  return <div className={styles.sourceRecord}>
    <dl>
      <div><dt>Quality tier</dt><dd>{source.sourceQualityTier}</dd></div>
      <div><dt>Attribution</dt><dd>{humanize(source.attributionStatus)}</dd></div>
      <div><dt>HTTP</dt><dd>{source.httpStatus ?? "Unknown"}</dd></div>
      <div><dt>Fetched</dt><dd>{formatTime(source.fetchedAt)}</dd></div>
      <div><dt>Validated</dt><dd>{formatTime(source.lastValidatedAt)}</dd></div>
      <div><dt>Discovery</dt><dd>{source.discoveryMethod}</dd></div>
    </dl>
    <code title={source.contentHash}>{source.contentHash}</code>
    {source.normalizedText ? <details><summary>Normalized source text</summary><p>{source.normalizedText}</p></details> : null}
  </div>;
}

function Empty({ label }: { label: string }) {
  return <div className={styles.empty}>{label}</div>;
}

function Timestamp({ label, value }: { label: string; value: string | null }) {
  return <small><span>{label}</span> {value ? <time dateTime={value}>{formatTime(value)}</time> : "Not yet"}</small>;
}

function summarizeCoverage(items: TimelineCompanyCoverageSummary[]) {
  return items.reduce((summary, item) => ({
    complete: summary.complete + (item.historicalBackfillStatus === "completed" ? 1 : 0),
    published: summary.published + item.publishedEventCount,
    candidates: summary.candidates + item.candidateEventCount,
    unresolvedDates: summary.unresolvedDates + item.unresolvedDateCount,
    conflicts: summary.conflicts + item.unresolvedConflictCount,
    failedSources: summary.failedSources + item.failedSourceCount,
    deadLetters: summary.deadLetters + item.deadLetterTaskCount,
    cacheAttention: summary.cacheAttention + (item.cacheStatus === "current" ? 0 : 1),
  }), {
    complete: 0,
    published: 0,
    candidates: 0,
    unresolvedDates: 0,
    conflicts: 0,
    failedSources: 0,
    deadLetters: 0,
    cacheAttention: 0,
  });
}

function mergeById<T>(current: T[], incoming: T[], id: (item: T) => string): T[] {
  const merged = new Map(current.map((item) => [id(item), item]));
  for (const item of incoming) merged.set(id(item), item);
  return [...merged.values()];
}

interface EventCommandInput {
  eventId: string;
  action: EventActionKind;
  reason: string;
  edit: { title: string; summary: string; eventDate: string; eventDateType: TimelineEventDateType; category: TimelineCategory; isMajor: boolean };
  relatedIds: string[];
  sourceDocumentId: string;
  evidenceRole: TimelineEvidenceRole;
  resolution: string;
}

function eventCommand(input: EventCommandInput): object {
  const common = { eventId: input.eventId, reason: input.reason };
  if (input.action === "edit") return { scope: "event", action: { type: "edit", ...common, patch: input.edit } };
  if (input.action === "merge") return { scope: "event", action: { type: "merge", ...common, sourceEventIds: input.relatedIds } };
  if (input.action === "split") return { scope: "event", action: { type: "split", ...common, evidenceIds: input.relatedIds } };
  if (input.action === "attach_evidence") return { scope: "event", action: { type: "attach_evidence", ...common, sourceDocumentId: input.sourceDocumentId, evidenceRole: input.evidenceRole } };
  if (input.action === "remove_evidence") return { scope: "event", action: { type: "remove_evidence", ...common, sourceDocumentId: input.sourceDocumentId } };
  if (input.action === "add_conflict_note") return { scope: "event", action: { type: "add_conflict_note", ...common, note: input.resolution } };
  if (input.action === "resolve_conflict") return { scope: "event", action: { type: "resolve_conflict", ...common, resolution: input.resolution } };
  return { scope: "event", action: { type: input.action, ...common } };
}

function canApplyEventAction(input: {
  eventId: string;
  eventDetail: TimelineAdminEventDetail | null;
  eventReason: string;
  eventAction: EventActionKind;
  eventEditTitle: string;
  eventEditSummary: string;
  eventEditDate: string;
  eventRelatedIds: string;
  eventSourceDocumentId: string;
  eventResolution: string;
}): boolean {
  if (!input.eventDetail || input.eventDetail.event.id !== input.eventId.trim() || input.eventReason.trim().length < 3) return false;
  if (input.eventAction === "edit") {
    return input.eventEditTitle.trim().length >= 3
      && input.eventEditSummary.trim().length >= 8
      && /^\d{4}-\d{2}-\d{2}$/.test(input.eventEditDate);
  }
  if (input.eventAction === "merge" || input.eventAction === "split") return parseAdminIds(input.eventRelatedIds).length > 0;
  if (input.eventAction === "attach_evidence" || input.eventAction === "remove_evidence") return input.eventSourceDocumentId.trim().length > 0;
  if (input.eventAction === "resolve_conflict" || input.eventAction === "add_conflict_note") return input.eventResolution.trim().length >= 3;
  return true;
}

function parseAdminIds(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
}

function sourceCoverageLabel(coverage: TimelineCompanyCoverageSummary["sourceCoverage"]): string {
  const values = Object.values(coverage);
  if (!values.length) return "Not recorded";
  const terminal = values.filter((value) => ["completed", "no_applicable_source", "no_results"].includes(value ?? "")).length;
  return `${terminal}/${values.length} terminal`;
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatTime(value: string | null): string {
  if (!value) return "Not yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function pluralize(value: number, singular: string): string {
  return value === 1 ? singular : `${singular}s`;
}
