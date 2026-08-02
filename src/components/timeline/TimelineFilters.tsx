import { CalendarRange, Check, ListFilter, RotateCcw } from "lucide-react";
import { TIMELINE_CATEGORIES, type TimelineCategory } from "@/lib/timeline/contracts";
import { TIMELINE_CATEGORY_LABELS } from "@/lib/timeline/taxonomy";
import type { TimelineFiltersState } from "./client";
import styles from "./CompanyTimeline.module.css";

interface TimelineFiltersProps {
  filters: TimelineFiltersState;
  resultCount: number;
  loading: boolean;
  onChange: (filters: TimelineFiltersState) => void;
}

type DatePreset = "all" | "past-year" | "past-three-years" | "custom";

export function TimelineFilters({ filters, resultCount, loading, onChange }: TimelineFiltersProps) {
  const selectedCategorySet = new Set(filters.categories);
  const hasFilters = Boolean(filters.from || filters.to || filters.categories.length);

  function setPreset(preset: DatePreset) {
    if (preset === "all") {
      onChange({ ...filters, from: null, to: null });
      return;
    }
    if (preset === "custom") return;
    const today = new Date();
    const start = new Date(today);
    start.setUTCFullYear(today.getUTCFullYear() - (preset === "past-year" ? 1 : 3));
    onChange({ ...filters, from: isoDay(start), to: isoDay(today) });
  }

  function toggleCategory(category: TimelineCategory) {
    const categories = selectedCategorySet.has(category)
      ? filters.categories.filter((value) => value !== category)
      : TIMELINE_CATEGORIES.filter((value) => selectedCategorySet.has(value) || value === category);
    onChange({ ...filters, categories });
  }

  return (
    <section className={styles.filters} aria-labelledby="timeline-filter-heading">
      <div className={styles.filterHeadingRow}>
        <div>
          <h3 id="timeline-filter-heading">Company timeline</h3>
          <p aria-live="polite" aria-atomic="true">
            {loading ? "Updating events…" : `${resultCount} ${resultCount === 1 ? "event" : "events"}`}
          </p>
        </div>
        <button
          type="button"
          className={styles.clearButton}
          disabled={!hasFilters}
          onClick={() => onChange({ from: null, to: null, categories: [] })}
          aria-label="Clear timeline filters"
        >
          <RotateCcw size={15} aria-hidden="true" />
          Clear
        </button>
      </div>

      <div className={styles.filterControls}>
        <label className={styles.presetControl}>
          <span><CalendarRange size={15} aria-hidden="true" /> Date range</span>
          <select
            value={datePreset(filters)}
            onChange={(event) => setPreset(event.target.value as DatePreset)}
            aria-label="Timeline date range preset"
          >
            <option value="all">All time</option>
            <option value="past-year">Past year</option>
            <option value="past-three-years">Past 3 years</option>
            <option value="custom">Custom dates</option>
          </select>
        </label>

        <div className={styles.dateInputs} role="group" aria-label="Custom timeline date range">
          <label>
            <span>From</span>
            <input
              type="date"
              value={filters.from ?? ""}
              max={filters.to ?? undefined}
              onChange={(event) => onChange({ ...filters, from: event.target.value || null })}
            />
          </label>
          <label>
            <span>To</span>
            <input
              type="date"
              value={filters.to ?? ""}
              min={filters.from ?? undefined}
              onChange={(event) => onChange({ ...filters, to: event.target.value || null })}
            />
          </label>
        </div>

        <details className={styles.categoryFilter}>
          <summary>
            <span><ListFilter size={15} aria-hidden="true" /> Event type</span>
            <strong>{filters.categories.length ? `${filters.categories.length} selected` : "All types"}</strong>
          </summary>
          <fieldset>
            <legend className="sr-only">Filter timeline by event type</legend>
            {TIMELINE_CATEGORIES.map((category) => (
              <label key={category}>
                <input
                  type="checkbox"
                  checked={selectedCategorySet.has(category)}
                  onChange={() => toggleCategory(category)}
                />
                <span className={styles.checkboxMark} aria-hidden="true">
                  <Check size={13} />
                </span>
                <span>{TIMELINE_CATEGORY_LABELS[category]}</span>
              </label>
            ))}
          </fieldset>
        </details>
      </div>
    </section>
  );
}

function datePreset(filters: TimelineFiltersState): DatePreset {
  if (!filters.from && !filters.to) return "all";
  if (!filters.from || !filters.to) return "custom";
  const today = new Date();
  const todayKey = isoDay(today);
  if (filters.to !== todayKey) return "custom";
  for (const [preset, years] of [["past-year", 1], ["past-three-years", 3]] as const) {
    const start = new Date(today);
    start.setUTCFullYear(today.getUTCFullYear() - years);
    if (filters.from === isoDay(start)) return preset;
  }
  return "custom";
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
