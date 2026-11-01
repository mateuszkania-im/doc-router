import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EmbeddingClassifier, type Embedder } from '../src/classifier/embedding-classifier.js';
import { NEVER } from '../src/classifier/local-classifier.js';
import { toyDataset } from './helpers.js';

/** Deterministic stand-in for the encoder: hashed bag of word prefixes, L2-normalised. */
class HashEmbedder implements Embedder {
  calls = 0;
  constructor(readonly model = 'hash-64') {}
  embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.calls++;
    return Promise.resolve(
      texts.map((t) => {
        const v = new Float32Array(64);
        for (const w of t
          .toLowerCase()
          .split(/[^\p{L}]+/u)
          .filter(Boolean)) {
          let h = 0;
          for (const ch of w.slice(0, 5)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
          v[h % 64] = (v[h % 64] ?? 0) + 1;
        }
        const norm = Math.hypot(...v) || 1;
        return v.map((x) => x / norm);
      }),
    );
  }
}

describe('EmbeddingClassifier', () => {
  const embedder = new HashEmbedder();
  let callsAfterTraining = -1;
  const trained = EmbeddingClassifier.train(toyDataset(), embedder, {
    folds: 4,
    train: { epochs: 60, learningRate: 0.05, l2: 1e-4, seed: 7 },
  }).then((m) => {
    callsAfterTraining = embedder.calls;
    return m;
  });

  it('learns separable classes through the shared softmax head', async () => {
    const model = await trained;
    const p = await model.predict(
      'Przesyłam fakturę VAT, kwota netto i podatek, termin płatności.',
    );
    expect(p.label).toBe('INVOICE');
    expect(p.ranking).toHaveLength(16);
  });

  it('encodes the training set once and reuses the vectors for every calibration fold', async () => {
    await trained;
    expect(callsAfterTraining).toBe(1);
  });

  it('never auto-accepts OTHER and calibrates like the TF-IDF model', async () => {
    const model = await trained;
    expect(model.thresholds.OTHER).toBe(NEVER);
  });

  it('round-trips through disk and refuses a file trained on another encoder', async () => {
    const model = await trained;
    const path = join(await mkdtemp(join(tmpdir(), 'emb-')), 'model.json');
    await model.save(path);
    const text = 'Doszło do kolizji samochodu, zgłaszam szkodę.';
    const loaded = await EmbeddingClassifier.load(path, embedder);
    expect(await loaded.predict(text)).toEqual(await model.predict(text));
    await expect(EmbeddingClassifier.load(path, new HashEmbedder('other'))).rejects.toThrow(
      /trained on hash-64/,
    );
  });
});
