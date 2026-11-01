/**
 * Lower bound of the 95% Wilson score interval for a proportion. "50 out of 50 correct" is not
 * "100% precise": it is "at least 92.9% precise, with 95% confidence".
 */
export function wilsonLower(successes: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = successes / n;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}
