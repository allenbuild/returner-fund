import { NextResponse } from "next/server";
import { loadYcPartnerFavorites } from "@/lib/yc-partners/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const partnerId = cleanQueryValue(params.get("partner"));
  const batchSlug = cleanQueryValue(params.get("batch"));
  const includeNoEvidence = parseBooleanQuery(params.get("includeNoEvidence"));

  if (includeNoEvidence === null) {
    return NextResponse.json(
      { code: "invalid_include_no_evidence", error: "includeNoEvidence must be true or false." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    const response = await loadYcPartnerFavorites({ partnerId, batchSlug, includeNoEvidence });
    return NextResponse.json(response, {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        "X-YC-Partner-Favorite-Model": response.modelVersion,
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    if (isYcPartnerFavoritesQueryError(error)) {
      return NextResponse.json(
        { code: error.code, error: error.message },
        { status: error.statusCode, headers: { "Cache-Control": "no-store" } }
      );
    }
    console.error("YC partner favorites failed", error);
    return NextResponse.json(
      { error: "YC partner favorites are temporarily unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}

function cleanQueryValue(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 120) : undefined;
}

function parseBooleanQuery(value: string | null): boolean | null {
  if (value === null || value === "") return true;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return null;
}

function isYcPartnerFavoritesQueryError(
  value: unknown
): value is { code: "invalid_partner" | "invalid_batch"; message: string; statusCode: 400 } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.name === "YcPartnerFavoritesQueryError" &&
    candidate.statusCode === 400 &&
    (candidate.code === "invalid_partner" || candidate.code === "invalid_batch") &&
    typeof candidate.message === "string";
}
