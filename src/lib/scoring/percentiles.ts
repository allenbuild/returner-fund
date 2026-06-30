export function clamp(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}

export function safeNumber(value: number | null | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

export function percentileRank(samples: number[] | undefined, value: number): number {
  const finiteSamples = (samples ?? []).filter(Number.isFinite).sort((a, b) => a - b);

  if (!Number.isFinite(value)) {
    return 0;
  }

  if (finiteSamples.length === 0) {
    return 0.5;
  }

  const lessThan = finiteSamples.filter((sample) => sample < value).length;
  const equalTo = finiteSamples.filter((sample) => sample === value).length;

  if (equalTo === 0) {
    return clamp(lessThan / finiteSamples.length);
  }

  return clamp((lessThan + equalTo / 2) / finiteSamples.length);
}

export function batchPercentileScores<T>(
  rows: T[],
  getValue: (row: T) => number
): Array<{ row: T; percentile: number; score: number }> {
  const values = rows.map(getValue).filter(Number.isFinite);

  return rows.map((row) => {
    const percentile = percentileRank(values, getValue(row));

    return {
      row,
      percentile,
      score: Math.round(percentile * 10000) / 100
    };
  });
}

export function weightedAverage(
  rows: Array<{ value: number; weight: number }>,
  fallback = 0
): number {
  const validRows = rows.filter((row) => Number.isFinite(row.value) && row.weight > 0);
  const totalWeight = validRows.reduce((sum, row) => sum + row.weight, 0);

  if (totalWeight <= 0) {
    return fallback;
  }

  return validRows.reduce((sum, row) => sum + row.value * row.weight, 0) / totalWeight;
}

export function roundScore(value: number): number {
  return Math.round(clamp(value, 0, 100) * 100) / 100;
}
