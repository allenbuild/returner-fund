import type { EvidenceItem } from "./types";
import { centralDayKey } from "../time/central-day";

export type NativePublicationPrecision = "exact" | "day";

export interface CredibleNativePublicationDate {
  /** Stable value used for deterministic ordering and rolling-window checks. */
  timestamp: number;
  /** The platform-native calendar day, interpreted in Central time for exact instants. */
  centralDay: string;
  precision: NativePublicationPrecision;
}

const CANONICAL_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const EXPLICIT_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-](\d{2}):(\d{2}))$/i;

/**
 * Returns only a credible platform-native publication date.
 *
 * `postedAt` is the sole publication clock in the EvidenceItem contract. In
 * particular, observation, metric-check, first-seen, and update timestamps are
 * deliberately never consulted here. Callers therefore fail closed when an
 * adapter did not obtain a native publication date.
 */
export function credibleNativePublicationDate(
  evidence: Pick<EvidenceItem, "postedAt" | "publishedAtPrecision">
): CredibleNativePublicationDate | null {
  if (typeof evidence.postedAt !== "string") return null;

  if (evidence.publishedAtPrecision === "exact") {
    // Exact instants require an explicit zone so results cannot depend on the
    // browser or server's local timezone.
    const rawTimestamp = evidence.postedAt.trim();
    const instantParts = rawTimestamp.match(EXPLICIT_INSTANT);
    if (!instantParts || !validExactInstantParts(instantParts)) return null;
    const timestamp = Date.parse(rawTimestamp);
    if (!Number.isFinite(timestamp)) return null;
    const day = centralDayKey(new Date(timestamp));
    return day ? { timestamp, centralDay: day, precision: "exact" } : null;
  }

  if (evidence.publishedAtPrecision !== "day") return null;
  const match = evidence.postedAt.trim().match(CANONICAL_DAY);
  if (!match) return null;
  const [, year, month, day] = match;
  const centralDay = `${year}-${month}-${day}`;
  const timestamp = Date.UTC(Number(year), Number(month) - 1, Number(day), 12);
  // Date.UTC normalizes impossible dates, so round-trip validation is required.
  if (new Date(timestamp).toISOString().slice(0, 10) !== centralDay) return null;
  return { timestamp, centralDay, precision: "day" };
}

function validExactInstantParts(parts: RegExpMatchArray): boolean {
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const hour = Number(parts[4]);
  const minute = Number(parts[5]);
  const second = Number(parts[6]);
  const offsetHour = parts[8].toUpperCase() === "Z" ? 0 : Number(parts[9]);
  const offsetMinute = parts[8].toUpperCase() === "Z" ? 0 : Number(parts[10]);

  return (
    Number.isInteger(year) &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59 &&
    offsetHour >= 0 &&
    offsetHour <= 14 &&
    offsetMinute >= 0 &&
    offsetMinute <= 59 &&
    (offsetHour < 14 || offsetMinute === 0)
  );
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isCrediblyPublishedToday(
  evidence: Pick<EvidenceItem, "postedAt" | "publishedAtPrecision">,
  now: Date
): boolean {
  const publication = credibleNativePublicationDate(evidence);
  const today = centralDayKey(now);
  if (!publication || !today || publication.centralDay !== today) return false;
  return publication.precision === "day" || publication.timestamp <= now.getTime();
}

export function isCrediblyPublishedWithinWindow(
  evidence: Pick<EvidenceItem, "postedAt" | "publishedAtPrecision">,
  now: Date,
  windowMs: number
): boolean {
  const publication = credibleNativePublicationDate(evidence);
  if (!publication || !Number.isFinite(now.getTime()) || !Number.isFinite(windowMs) || windowMs < 0) {
    return false;
  }

  if (publication.precision === "exact") {
    return publication.timestamp >= now.getTime() - windowMs && publication.timestamp <= now.getTime();
  }

  // Native day-only dates are calendar claims, not fabricated midnight
  // instants. Use Central calendar-day bounds rather than inventing a time.
  const today = centralDayKey(now);
  const firstDay = centralDayKey(new Date(now.getTime() - windowMs));
  return Boolean(
    today &&
      firstDay &&
      publication.centralDay >= firstDay &&
      publication.centralDay <= today
  );
}
