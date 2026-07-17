const CENTRAL_TIME_ZONE = "America/Chicago";
const CENTRAL_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: CENTRAL_TIME_ZONE,
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

interface CentralDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function centralDayKey(date: Date): string | null {
  const parts = centralDateTimeParts(date);
  if (!parts) {
    return null;
  }

  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0")
  ].join("-");
}

export function isCurrentCentralDay(date: Date, now = new Date()): boolean {
  const dayKey = centralDayKey(date);
  return dayKey !== null && dayKey === centralDayKey(now);
}

export function millisecondsUntilNextCentralMidnight(now = new Date()): number {
  const nowTime = now.getTime();
  const parts = centralDateTimeParts(now);
  if (!parts) {
    throw new RangeError("Cannot calculate Central midnight from an invalid date.");
  }

  const nextDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  const nextMidnightWallTime = nextDay.getTime();
  let nextMidnightTime = nextMidnightWallTime;

  // Resolve the Central wall-clock midnight to its UTC instant. Rechecking the
  // offset makes this safe when the target date has crossed a DST boundary.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const offset = centralUtcOffsetMilliseconds(nextMidnightTime);
    const adjustedTime = nextMidnightWallTime - offset;
    if (adjustedTime === nextMidnightTime) {
      return adjustedTime - nowTime;
    }
    nextMidnightTime = adjustedTime;
  }

  throw new Error("Unable to resolve the next Central midnight.");
}

function centralDateTimeParts(date: Date): CentralDateTimeParts | null {
  if (!Number.isFinite(date.getTime())) {
    return null;
  }

  const formattedParts: Record<string, string> = {};
  for (const part of CENTRAL_DATE_TIME_FORMATTER.formatToParts(date)) {
    formattedParts[part.type] = part.value;
  }

  const parts = {
    year: Number(formattedParts.year),
    month: Number(formattedParts.month),
    day: Number(formattedParts.day),
    hour: Number(formattedParts.hour),
    minute: Number(formattedParts.minute),
    second: Number(formattedParts.second)
  };

  return Object.values(parts).every(Number.isInteger) ? parts : null;
}

function centralUtcOffsetMilliseconds(instant: number): number {
  const parts = centralDateTimeParts(new Date(instant));
  if (!parts) {
    throw new RangeError("Cannot calculate a Central time offset from an invalid date.");
  }

  return (
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
    instant
  );
}
