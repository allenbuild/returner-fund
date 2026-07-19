"use client";

import { Analytics, type BeforeSendEvent } from "@vercel/analytics/next";
import { privacySafeAnalyticsUrl } from "@/lib/analytics";

function redactEventUrl(event: BeforeSendEvent): BeforeSendEvent {
  return {
    ...event,
    url: privacySafeAnalyticsUrl(event.url)
  };
}

export function Telemetry() {
  return <Analytics beforeSend={redactEventUrl} />;
}
