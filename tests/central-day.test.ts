import { describe, expect, it } from "vitest";
import {
  centralDayKey,
  isCurrentCentralDay,
  millisecondsUntilNextCentralMidnight
} from "@/lib/time/central-day";

const HOUR_MS = 60 * 60 * 1_000;

describe("Central calendar days", () => {
  it("changes summer day keys at 05:00 UTC", () => {
    const beforeMidnight = new Date("2026-07-05T04:59:59.999Z");
    const atMidnight = new Date("2026-07-05T05:00:00.000Z");

    expect(centralDayKey(beforeMidnight)).toBe("2026-07-04");
    expect(centralDayKey(atMidnight)).toBe("2026-07-05");
    expect(isCurrentCentralDay(beforeMidnight, atMidnight)).toBe(false);
    expect(millisecondsUntilNextCentralMidnight(beforeMidnight)).toBe(1);
    expect(millisecondsUntilNextCentralMidnight(atMidnight)).toBe(24 * HOUR_MS);
  });

  it("keeps the spring-forward jump on one day and measures a 23-hour day", () => {
    const centralMidnight = new Date("2026-03-08T06:00:00.000Z");
    const beforeJump = new Date("2026-03-08T07:59:59.999Z");
    const afterJump = new Date("2026-03-08T08:00:00.000Z");

    expect(centralDayKey(beforeJump)).toBe("2026-03-08");
    expect(centralDayKey(afterJump)).toBe("2026-03-08");
    expect(isCurrentCentralDay(beforeJump, afterJump)).toBe(true);
    expect(millisecondsUntilNextCentralMidnight(centralMidnight)).toBe(23 * HOUR_MS);
  });

  it("keeps both fall-back hours on one day and measures a 25-hour day", () => {
    const centralMidnight = new Date("2026-11-01T05:00:00.000Z");
    const beforeFallback = new Date("2026-11-01T06:59:59.999Z");
    const afterFallback = new Date("2026-11-01T07:00:00.000Z");

    expect(centralDayKey(beforeFallback)).toBe("2026-11-01");
    expect(centralDayKey(afterFallback)).toBe("2026-11-01");
    expect(isCurrentCentralDay(beforeFallback, afterFallback)).toBe(true);
    expect(millisecondsUntilNextCentralMidnight(centralMidnight)).toBe(25 * HOUR_MS);
  });

  it("handles invalid dates without treating them as a shared day", () => {
    const invalidDate = new Date(Number.NaN);

    expect(centralDayKey(invalidDate)).toBeNull();
    expect(isCurrentCentralDay(invalidDate, invalidDate)).toBe(false);
    expect(() => millisecondsUntilNextCentralMidnight(invalidDate)).toThrow(RangeError);
  });
});
