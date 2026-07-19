import { createElement } from "react";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Telemetry } from "@/components/Telemetry";
import {
  privacySafeAnalyticsUrl,
  sanitizeAnalyticsProperties,
  trackAnalyticsEvent
} from "@/lib/analytics";
import { track } from "@vercel/analytics";
import { Analytics, type BeforeSendEvent } from "@vercel/analytics/next";

vi.mock("@vercel/analytics", () => ({
  track: vi.fn()
}));

vi.mock("@vercel/analytics/next", () => ({
  Analytics: vi.fn(() => null)
}));

describe("privacy-safe analytics events", () => {
  beforeEach(() => {
    vi.mocked(Analytics).mockClear();
    vi.mocked(track).mockClear();
  });

  it("keeps only allowlisted flat primitive properties", () => {
    const properties = sanitizeAnalyticsProperties("result_opened", {
      result_type: "founder",
      position: 2.4,
      query: "sensitive query",
      company_name: "Private Company",
      node_id: "company:private",
      nested: { url: "https://example.com/private" }
    });

    expect(properties).toEqual({ result_type: "founder", position: 2 });
  });

  it("drops invalid enum values and bounds numeric counts", () => {
    expect(sanitizeAnalyticsProperties("filter_changed", {
      filter: "company_name",
      action: "set",
      selection_count: 50_000,
      error: "do not send"
    })).toEqual({ action: "set", selection_count: 1_000 });
  });

  it("sends only the sanitized event payload", () => {
    trackAnalyticsEvent("search_submitted", {
      result_count: 4,
      has_results: true
    });

    expect(track).toHaveBeenCalledWith("search_submitted", {
      result_count: 4,
      has_results: true
    });
  });

  it("removes query parameters and fragments from analytics URLs", () => {
    expect(
      privacySafeAnalyticsUrl(
        "https://returner.example/?industries=fintech&node=company%3Aprivate#details"
      )
    ).toBe("https://returner.example/");
    expect(privacySafeAnalyticsUrl("/methodology?query=private")).toBe("/methodology");
    expect(privacySafeAnalyticsUrl("https://returner.example/companies/private-company")).toBe(
      "https://returner.example/companies/_entity"
    );
    expect(privacySafeAnalyticsUrl("https://returner.example/unlisted/private-value")).toBe(
      "https://returner.example/other"
    );
    expect(privacySafeAnalyticsUrl("http://[")).toBe("/");
  });

  it("installs URL redaction on Vercel Analytics", () => {
    render(createElement(Telemetry));

    const beforeSend = vi.mocked(Analytics).mock.calls[0][0].beforeSend;
    const event: BeforeSendEvent = {
      type: "event",
      url: "https://returner.example/?node=company%3Aprivate"
    };
    expect(beforeSend?.(event)).toEqual({
      type: "event",
      url: "https://returner.example/"
    });
  });
});
