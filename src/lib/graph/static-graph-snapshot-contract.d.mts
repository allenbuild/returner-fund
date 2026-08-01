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

export function validateStaticGraphSnapshotContract(
  value: unknown,
  options?: StaticGraphSnapshotContractOptions
): StaticGraphSnapshotContractResult;
export function formatStaticGraphSnapshotContractIssue(issue: StaticGraphSnapshotContractIssue): string;
