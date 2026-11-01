/**
 * List prices in USD per million tokens, standard tier, taken from the provider's model pages on
 * 2026-10-31. Prices change; update this table and re-run `pnpm eval` before quoting a number.
 */
export const PRICES_PER_MILLION: Readonly<Record<string, { input: number; output: number }>> = {
  'gpt-5.4-mini-2026-03-17': { input: 0.75, output: 4.5 },
};

export interface CostLine {
  readonly name: string;
  readonly documents: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly llmCalls: number;
  readonly toHuman: number;
}

export interface CostPerThousand {
  readonly name: string;
  readonly usd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly llmCalls: number;
  readonly toHuman: number;
}

/** Scales measured usage to 1000 letters, the unit a mailroom thinks in. */
export function costPerThousand(line: CostLine, model: string): CostPerThousand | undefined {
  const price = PRICES_PER_MILLION[model];
  if (!price || line.documents === 0) return undefined;
  const k = 1000 / line.documents;
  const usd = ((line.inputTokens * price.input + line.outputTokens * price.output) / 1e6) * k;
  return {
    name: line.name,
    usd,
    inputTokens: Math.round(line.inputTokens * k),
    outputTokens: Math.round(line.outputTokens * k),
    llmCalls: Math.round(line.llmCalls * k),
    toHuman: Math.round(line.toHuman * k),
  };
}
