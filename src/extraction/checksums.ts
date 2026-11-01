function digitsOf(value: string): number[] {
  return Array.from(value, Number);
}

function weightedSum(digits: readonly number[], weights: readonly number[]): number {
  return weights.reduce((sum, w, i) => sum + w * (digits[i] ?? 0), 0);
}

export function isValidPesel(value: string): boolean {
  if (!/^\d{11}$/.test(value)) return false;
  const d = digitsOf(value);
  const check = (10 - (weightedSum(d, [1, 3, 7, 9, 1, 3, 7, 9, 1, 3]) % 10)) % 10;
  return check === d[10];
}

export function isValidNip(value: string): boolean {
  if (!/^\d{10}$/.test(value)) return false;
  const d = digitsOf(value);
  const check = weightedSum(d, [6, 5, 7, 2, 3, 4, 5, 6, 7]) % 11;
  return check !== 10 && check === d[9];
}

export function isValidRegon(value: string): boolean {
  const weights =
    value.length === 9
      ? [8, 9, 2, 3, 4, 5, 6, 7]
      : value.length === 14
        ? [2, 4, 8, 5, 0, 9, 7, 3, 6, 1, 2, 4, 8]
        : null;
  if (!weights || !/^\d+$/.test(value)) return false;
  const d = digitsOf(value);
  const check = (weightedSum(d, weights) % 11) % 10;
  return check === d[value.length - 1];
}

/** Accepts a Polish IBAN with or without the PL prefix (a bare 26-digit NRB). */
export function isValidPolishIban(value: string): boolean {
  const compact = value.replace(/\s/g, '').toUpperCase();
  const iban = compact.startsWith('PL') ? compact : `PL${compact}`;
  if (!/^PL\d{26}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let remainder = 0;
  for (const ch of numeric) remainder = (remainder * 10 + Number(ch)) % 97;
  return remainder === 1;
}

export function peselCheckDigit(first10: string): number {
  return (10 - (weightedSum(digitsOf(first10), [1, 3, 7, 9, 1, 3, 7, 9, 1, 3]) % 10)) % 10;
}
