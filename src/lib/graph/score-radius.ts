import type { EntityType } from "./types";

const SCORE_RADIUS_BOUNDS: Record<EntityType, { min: number; max: number }> = {
  company: { min: 5, max: 68 },
  founder: { min: 4, max: 38 }
};

/**
 * Maps the shared 0..100 headline score to a stable visual radius.
 *
 * `peerScores` remains in the signature for compatibility with graph builders,
 * but peers must never change the visual meaning of an absolute score.
 */
export function getNodeRadius(
  score: number,
  _peerScores: number[],
  entityType: EntityType
): number {
  const bounds = SCORE_RADIUS_BOUNDS[entityType];
  const normalizedScore = Math.min(100, Math.max(0, Number.isFinite(score) ? score : 0)) / 100;
  return round(bounds.min + Math.pow(normalizedScore, 2.2) * (bounds.max - bounds.min));
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
