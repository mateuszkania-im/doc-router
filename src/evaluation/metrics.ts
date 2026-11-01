import { DOCUMENT_CLASSES, isCritical, type DocumentClass } from '../domain/classes.js';

export interface EvalRecord {
  readonly id: string;
  readonly truth: DocumentClass;
  /** Final label if the system decided on its own, null if it handed off to a human. */
  readonly autoLabel: DocumentClass | null;
  /** What the reviewer would see as the suggestion. */
  readonly suggestedLabel: DocumentClass | null;
  readonly queue: string;
  readonly tags: readonly string[];
  readonly decidedBy: string | null;
  readonly processingMs: number;
  readonly llmTokens: number;
  readonly llmInputTokens?: number;
  readonly llmOutputTokens?: number;
  /** Who the letter is really about: a customer id, null for a non-customer, absent if unknown. */
  readonly truthCustomer?: string | null;
  /** The customer the system attached, null if none. */
  readonly customer?: string | null;
}

export interface ClassMetrics {
  readonly label: DocumentClass;
  readonly support: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
}

const ratio = (a: number, b: number): number => (b === 0 ? 0 : a / b);
const f1 = (p: number, r: number): number => (p + r === 0 ? 0 : (2 * p * r) / (p + r));

/**
 * Per-class metrics of the suggestion (what the system thinks), independent of whether it was
 * confident enough to act. Automation quality is measured separately by coverage and auto-precision.
 */
export function perClassMetrics(records: readonly EvalRecord[]): ClassMetrics[] {
  return DOCUMENT_CLASSES.map((label) => {
    const tp = records.filter((r) => r.truth === label && r.suggestedLabel === label).length;
    const predicted = records.filter((r) => r.suggestedLabel === label).length;
    const support = records.filter((r) => r.truth === label).length;
    const precision = ratio(tp, predicted);
    const recall = ratio(tp, support);
    return { label, support, precision, recall, f1: f1(precision, recall) };
  });
}

/** Averages over every class that occurs as truth or as a prediction: false alarms count too. */
export function macroF1(metrics: readonly ClassMetrics[], records?: readonly EvalRecord[]): number {
  const predicted = new Set(records?.map((r) => r.suggestedLabel));
  const relevant = metrics.filter((m) => m.support > 0 || predicted.has(m.label));
  return ratio(
    relevant.reduce((s, m) => s + m.f1, 0),
    relevant.length,
  );
}

export interface Summary {
  readonly documents: number;
  readonly suggestionAccuracy: number;
  readonly macroF1: number;
  /** Share of documents routed with no human touch. */
  readonly coverage: number;
  /** Accuracy of the documents that were routed automatically. */
  readonly autoPrecision: number;
  readonly criticalDocuments: number;
  /**
   * A critical letter is "lost" when it was auto-routed under a wrong label, or handed to the
   * ordinary manual queue instead of the fast critical-review queue. This is the number that has
   * to be zero; everything else is cost.
   */
  readonly criticalLost: number;
  readonly criticalLostIds: readonly string[];
  readonly injectionDocuments: number;
  readonly injectionAutoRoutedWrong: number;
  readonly decidedBy: Readonly<Record<string, number>>;
  readonly p95ProcessingMs: number;
  readonly llmTokens: number;
  readonly llmInputTokens: number;
  readonly llmOutputTokens: number;
  /** Letters whose true customer is known (customer or explicitly nobody). */
  readonly customerKnown: number;
  /**
   * Routed with no human touch and attached to the wrong customer (or to a customer when the
   * letter is about nobody we know). Like criticalLost, this one has to be zero.
   */
  readonly wrongCustomerAuto: number;
  readonly wrongCustomerAutoIds: readonly string[];
  /** Letters about a real customer where the system found that customer, auto or for review. */
  readonly customerFound: number;
  readonly customerDocuments: number;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

export function summarize(records: readonly EvalRecord[], criticalReviewQueue: string): Summary {
  const auto = records.filter((r) => r.autoLabel !== null);
  const critical = records.filter((r) => isCritical(r.truth));
  const lost = critical.filter((r) =>
    r.autoLabel !== null ? r.autoLabel !== r.truth : r.queue !== criticalReviewQueue,
  );
  const injection = records.filter((r) => r.tags.includes('injection'));
  const decidedBy: Record<string, number> = {};
  for (const r of records) {
    const key = r.decidedBy ?? 'human';
    decidedBy[key] = (decidedBy[key] ?? 0) + 1;
  }
  const metrics = perClassMetrics(records);
  const known = records.filter((r) => r.truthCustomer !== undefined);
  const wrongCustomer = known.filter(
    (r) => r.autoLabel !== null && r.customer != null && r.customer !== r.truthCustomer,
  );
  return {
    documents: records.length,
    suggestionAccuracy: ratio(
      records.filter((r) => r.suggestedLabel === r.truth).length,
      records.length,
    ),
    macroF1: macroF1(metrics, records),
    coverage: ratio(auto.length, records.length),
    autoPrecision: ratio(auto.filter((r) => r.autoLabel === r.truth).length, auto.length),
    criticalDocuments: critical.length,
    criticalLost: lost.length,
    criticalLostIds: lost.map((r) => r.id),
    injectionDocuments: injection.length,
    injectionAutoRoutedWrong: injection.filter(
      (r) => r.autoLabel !== null && r.autoLabel !== r.truth,
    ).length,
    decidedBy,
    p95ProcessingMs: percentile(
      records.map((r) => r.processingMs),
      95,
    ),
    llmTokens: records.reduce((s, r) => s + r.llmTokens, 0),
    llmInputTokens: records.reduce((s, r) => s + (r.llmInputTokens ?? 0), 0),
    llmOutputTokens: records.reduce((s, r) => s + (r.llmOutputTokens ?? 0), 0),
    customerKnown: known.length,
    wrongCustomerAuto: wrongCustomer.length,
    wrongCustomerAutoIds: wrongCustomer.map((r) => r.id),
    customerFound: known.filter((r) => r.truthCustomer && r.customer === r.truthCustomer).length,
    customerDocuments: known.filter((r) => r.truthCustomer).length,
  };
}

export interface RiskCoveragePoint {
  readonly threshold: number;
  readonly coverage: number;
  readonly accuracy: number;
}

/**
 * Risk-coverage curve for a single confidence score: if we auto-route everything above the
 * threshold, how much do we automate and how accurate is it. The shape matters more than any
 * single accuracy number.
 */
export function riskCoverage(
  points: readonly { confidence: number; correct: boolean }[],
  thresholds: readonly number[] = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95],
): RiskCoveragePoint[] {
  return thresholds.map((threshold) => {
    const kept = points.filter((p) => p.confidence >= threshold);
    return {
      threshold,
      coverage: ratio(kept.length, points.length),
      accuracy: ratio(kept.filter((p) => p.correct).length, kept.length),
    };
  });
}

export { wilsonLower } from '../stats.js';

/** Upper bound of the 95% CI for an error rate when n trials had zero errors ("rule of three"). */
export const ruleOfThree = (n: number): number => (n === 0 ? 1 : 3 / n);
