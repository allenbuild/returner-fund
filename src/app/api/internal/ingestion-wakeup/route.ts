import { NextResponse } from "next/server";
import { handleCloudIngestionWakeup } from "@/lib/ingestion/cloud-wakeup";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(request: Request) {
  const result = await handleCloudIngestionWakeup(request);
  return NextResponse.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "private, no-store" }
  });
}
