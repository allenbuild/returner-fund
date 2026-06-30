import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const auditPath = path.join(process.cwd(), "outputs", "evidence-attribution-audit-s2026.json");
const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"));

describe("attribution audit output", () => {
  it("keeps hard attribution failures separate from first-party social review work", () => {
    expect(audit.high_risk_scored_count).toBe(0);
    expect(audit.medium_risk_scored_count).toBe(0);
    expect(audit.first_party_social_review_count).toBeGreaterThanOrEqual(0);
    expect(audit.founder_first_party_review_count).toBeGreaterThanOrEqual(0);
    expect(audit.first_party_social_review_priority_counts).toEqual(
      expect.objectContaining({
        high: expect.any(Number),
        medium: expect.any(Number),
        low: expect.any(Number)
      })
    );
  });

  it("records actionable high-priority first-party social review rows without marking them as hard failures", () => {
    const highPriorityRows = audit.first_party_social_review.filter(
      (item: { reviewPriority?: string }) => item.reviewPriority === "high"
    );

    expect(highPriorityRows.length).toBeLessThanOrEqual(audit.first_party_social_review_priority_counts.high);
    for (const row of highPriorityRows) {
      expect(row.reviewReason).toContain("verified first-party");
      expect(row.url).toMatch(/^https?:\/\//);
      expect(row.score).toBeGreaterThan(0);
    }
  });
});
