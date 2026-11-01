import { describe, expect, it } from 'vitest';
import {
  macroF1,
  perClassMetrics,
  riskCoverage,
  ruleOfThree,
  summarize,
  wilsonLower,
  type EvalRecord,
} from '../src/evaluation/metrics.js';

const rec = (
  truth: EvalRecord['truth'],
  suggested: EvalRecord['suggestedLabel'],
  auto: boolean,
  queue = 'q',
  tags: string[] = [],
): EvalRecord => ({
  id: `${truth}-${String(Math.random())}`,
  truth,
  suggestedLabel: suggested,
  autoLabel: auto ? suggested : null,
  queue,
  tags,
  decidedBy: auto ? 'local_model' : null,
  processingMs: 1,
  llmTokens: 0,
});

describe('metrics', () => {
  it('computes per-class precision, recall and macro-F1', () => {
    const records = [
      rec('INVOICE', 'INVOICE', true),
      rec('INVOICE', 'OTHER', false),
      rec('OTHER', 'OTHER', true),
    ];
    const m = perClassMetrics(records);
    const invoice = m.find((x) => x.label === 'INVOICE');
    expect(invoice).toMatchObject({ support: 2, precision: 1, recall: 0.5 });
    expect(macroF1(m)).toBeCloseTo((2 / 3 + 2 / 3) / 2, 6);
  });

  it('counts a critical letter as lost only if auto-routed wrongly or sent to the ordinary manual queue', () => {
    const s = summarize(
      [
        rec('COMPLAINT', 'COMPLAINT', true),
        rec('COMPLAINT', 'INVOICE', false, 'critical-review'),
        rec('COMPLAINT', 'INVOICE', false, 'manual-classification'),
        rec('BAILIFF_SEIZURE', 'INVOICE', true),
      ],
      'critical-review',
    );
    expect(s.criticalDocuments).toBe(4);
    expect(s.criticalLost).toBe(2);
    expect(s.coverage).toBe(0.5);
    expect(s.autoPrecision).toBe(0.5);
  });

  it('builds a risk-coverage curve', () => {
    const points = [
      { confidence: 0.95, correct: true },
      { confidence: 0.8, correct: true },
      { confidence: 0.5, correct: false },
      { confidence: 0.3, correct: false },
    ];
    expect(riskCoverage(points, [0.3, 0.9])).toEqual([
      { threshold: 0.3, coverage: 1, accuracy: 0.5 },
      { threshold: 0.9, coverage: 0.25, accuracy: 1 },
    ]);
  });

  it('bounds a perfect score from below with the Wilson interval', () => {
    expect(wilsonLower(50, 50)).toBeCloseTo(0.9287, 3);
    expect(wilsonLower(0, 0)).toBe(0);
    expect(wilsonLower(95, 100)).toBeLessThan(0.95);
  });

  it('applies the rule of three', () => {
    expect(ruleOfThree(300)).toBeCloseTo(0.01, 6);
  });
});
