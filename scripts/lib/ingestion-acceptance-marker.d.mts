export const INGESTION_ACCEPTANCE_MARKER_PATH: string;
export const INGESTION_PUBLICATION_RECEIPT_PATH: string;
export const INGESTION_GRAPH_MANIFEST_PATH: string;

export function sha256Text(value: unknown): string;
export function acceptanceBindingSha256(marker: Record<string, unknown>): string;

export type IngestionAcceptanceInspection = Readonly<{
  status: "valid" | "invalid";
  marker: Readonly<{
    slotKey: string;
    scheduledAt: string;
    publicationCommit: string;
  }> | null;
  error: string | null;
}>;

export function inspectIngestionAcceptanceMarker(input?: {
  markerText?: string;
  receiptText?: string;
  manifestText?: string;
  now?: Date;
}): IngestionAcceptanceInspection;
