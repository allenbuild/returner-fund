export interface StaticGraphSnapshotContractIssue {
  path: string;
  message: string;
}

export type StaticGraphSnapshotContractResult =
  | { ok: true; issues: [] }
  | { ok: false; issues: StaticGraphSnapshotContractIssue[] };

export const STATIC_GRAPH_SCORING_MODEL_ID: "returner-traction";
export const STATIC_GRAPH_SCORING_MODEL_VERSION: "4.2.0";
export const STATIC_GRAPH_SCORING_MODEL_NAME: "returner-traction-v4-absolute-fixed-platform-global-best";

export interface StaticGraphSnapshotContractOptions {
  now?: Date;
  maxFutureSkewMs?: number;
}

export interface RawEvidenceTemporalPreflightOptions {
  sourceObservedAt: string;
  sourceLabel?: string;
}

export interface EvidenceTemporalNormalizationOptions {
  sourceObservedAt?: string;
}

export function assertRawEvidenceTemporalPreflight<T extends object>(
  records: readonly T[],
  options: RawEvidenceTemporalPreflightOptions
): void;
export function normalizeEvidenceTemporalSemantics<T extends object>(
  record: T,
  options?: EvidenceTemporalNormalizationOptions
): T & {
  postedAt: string;
  publishedAtPrecision: "exact" | "day" | "unknown";
  observedAt: string;
};

export function validateStaticGraphSnapshotContract(
  value: unknown,
  options?: StaticGraphSnapshotContractOptions
): StaticGraphSnapshotContractResult;
export function formatStaticGraphSnapshotContractIssue(issue: StaticGraphSnapshotContractIssue): string;
