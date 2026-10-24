const delaysMs = [5_000, 30_000, 120_000, 600_000];

export function nextAttemptDelay(attemptNumber: number, scale = 1, random = Math.random): number | null {
  if (attemptNumber < 1 || attemptNumber > delaysMs.length) return null;
  const base = delaysMs[attemptNumber - 1] * scale;
  return Math.round(base * (0.8 + random() * 0.4));
}
