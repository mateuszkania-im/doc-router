import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tokenize } from '../src/classifier/features.js';
import {
  calibrateThresholds,
  LocalClassifier,
  NEVER,
  outOfFold,
  scenarioOf,
} from '../src/classifier/local-classifier.js';
import { toyDataset } from './helpers.js';

describe('tokenize', () => {
  it('stems inflected Polish words to a shared prefix and adds bigrams', () => {
    expect(tokenize('Zajęcie zajęciu')).toEqual(['zajęci', 'zajęci', 'zajęci_zajęci']);
  });
});

describe('LocalClassifier', () => {
  const model = LocalClassifier.train(toyDataset(), { folds: 4 });

  it('predicts the right class for an unseen paraphrase', () => {
    expect(
      model.predict('Przesyłam fakturę VAT, kwota netto i podatek, termin płatności 30 dni.').label,
    ).toBe('INVOICE');
    expect(model.predict('Doszło do kolizji samochodu, zgłaszam szkodę.').label).toBe(
      'CLAIM_NOTIFICATION',
    );
  });

  it('returns a full, sorted probability ranking', () => {
    const p = model.predict('Proszę o zmianę adresu.');
    expect(p.ranking).toHaveLength(16);
    expect(p.ranking.reduce((s, r) => s + r.score, 0)).toBeCloseTo(1, 6);
    expect(p.ranking[0]?.score).toBeGreaterThanOrEqual(p.ranking[1]?.score ?? 0);
  });

  it('never auto-accepts OTHER or classes it never saw', () => {
    expect(model.thresholds.OTHER).toBe(NEVER);
    expect(model.thresholds.BAILIFF_SEIZURE).toBe(NEVER);
    expect(model.predict('Zapraszamy na konferencję branżową.').accepted).toBe(false);
  });

  it('round-trips through disk and refuses a corrupt file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doc-router-'));
    const path = join(dir, 'model.json');
    await model.save(path);
    const loaded = await LocalClassifier.load(path);
    const text = 'Faktura VAT, termin płatności.';
    expect(loaded.predict(text)).toEqual(model.predict(text));

    await writeFile(path, JSON.stringify({ version: 2 }));
    await expect(LocalClassifier.load(path)).rejects.toThrow();
  });

  it('is deterministic for the same data and seed', () => {
    const again = LocalClassifier.train(toyDataset(), { folds: 4 });
    expect(again.predict('Proszę zmienić mój numer telefonu.')).toEqual(
      model.predict('Proszę zmienić mój numer telefonu.'),
    );
  });
});

describe('calibrateThresholds', () => {
  const targets = { precision: 0.9, criticalPrecision: 0.99, minSupport: 3 };

  it('picks the lowest threshold that still meets the precision target', () => {
    const oof = [
      { truth: 'INVOICE', predicted: 'INVOICE', confidence: 0.95 },
      { truth: 'INVOICE', predicted: 'INVOICE', confidence: 0.9 },
      { truth: 'INVOICE', predicted: 'INVOICE', confidence: 0.8 },
      { truth: 'OTHER', predicted: 'INVOICE', confidence: 0.6 },
      { truth: 'INVOICE', predicted: 'INVOICE', confidence: 0.5 },
    ] as const;
    // At 0.8: 3/3 correct. At 0.6: 3/4 = 0.75 < 0.9. At 0.5: 4/5 = 0.8 < 0.9.
    expect(calibrateThresholds(oof, targets).INVOICE).toBe(0.8);
  });

  it('holds critical classes to the stricter target', () => {
    const oof = [
      ...Array.from({ length: 20 }, () => ({
        truth: 'COMPLAINT' as const,
        predicted: 'COMPLAINT' as const,
        confidence: 0.9,
      })),
      { truth: 'OTHER' as const, predicted: 'COMPLAINT' as const, confidence: 0.85 },
    ];
    // 20/21 = 0.952 passes 0.9 but fails 0.99, so only the 0.9 band is accepted.
    expect(calibrateThresholds(oof, targets).COMPLAINT).toBe(0.9);
  });

  it('judges tied confidences together, since a threshold accepts all of them', () => {
    const oof = [
      { truth: 'INVOICE', predicted: 'INVOICE', confidence: 0.9 },
      { truth: 'INVOICE', predicted: 'INVOICE', confidence: 0.9 },
      { truth: 'INVOICE', predicted: 'INVOICE', confidence: 0.9 },
      { truth: 'OTHER', predicted: 'INVOICE', confidence: 0.9 },
    ] as const;
    // Mid-tie the first three look perfect, but a 0.9 threshold accepts all four: 3/4 < 0.9.
    expect(calibrateThresholds(oof, targets).INVOICE).toBe(NEVER);
  });

  it('refuses classes with too little evidence', () => {
    const oof = [{ truth: 'INVOICE', predicted: 'INVOICE', confidence: 0.99 }] as const;
    expect(calibrateThresholds(oof, targets).INVOICE).toBe(NEVER);
  });
});

describe('outOfFold with scenario groups', () => {
  it('never validates on a scenario that was in the training folds', () => {
    const items = Array.from({ length: 60 }, (_, i) => ({
      label: 'INVOICE' as const,
      group: `brief:${String(i % 6)}`,
    }));
    const seen: { train: Set<string>; valid: Set<string> }[] = [];
    outOfFold(
      items,
      3,
      1,
      (train, valid) => {
        seen.push({
          train: new Set(train.map((t) => t.group)),
          valid: new Set(valid.map((v) => v.group)),
        });
        return valid.map(() => new Array<number>(16).fill(1 / 16));
      },
      (x) => x.group,
    );
    expect(seen).toHaveLength(3);
    for (const fold of seen) for (const g of fold.valid) expect(fold.train.has(g)).toBe(false);
  });

  it('reads the scenario from brief or scenario tags', () => {
    expect(scenarioOf({ label: 'INVOICE', tags: ['brief:3', 'customer:C1'] })).toBe(
      'INVOICE:brief:3',
    );
    expect(scenarioOf({ label: 'INVOICE', tags: [] })).toBe('');
  });
});
