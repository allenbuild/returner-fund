export const INGESTION_ACCEPTANCE_MARKER_PATH: string;
export const INGESTION_PUBLICATION_RECEIPT_PATH: string;
export const INGESTION_GRAPH_MANIFEST_PATH: string;

export function sha256Text(value: unknown): string;
export function acceptanceBindingSha256(marker: Record<string, unknown>): string;
export function inspectIngestionPublicationBinding(input?: {
  marker?: unknown;
  receiptText?: string;
  manifestText?: string;
}): Readonly<{ status: "valid" | "invalid"; error: string | null }>;

export type IngestionAcceptanceInspection = Readonly<{
  status: "valid" | "invalid";
  marker: Readonly<{
    slotKey: string;
    scheduledAt: string;
    publicationCommit: string;
    publicationSourceSha: string;
    publicationManifestSha256: string;
    publicationManifestContentHash: string;
    receiptSha256: string;
    validatedManifestSha256: string;
    validatedManifestContentHash: string;
    evidenceCollectedAt: string;
    validation: Readonly<{ validatedSha: string }>;
  }> | null;
  error: string | null;
}>;

export function inspectIngestionAcceptanceMarker(input?: {
  markerText?: string;
  receiptText?: string;
  manifestText?: string;
  now?: Date;
}): IngestionAcceptanceInspection;
