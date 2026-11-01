import type { SparseVector } from './features.js';

export interface SoftmaxWeights {
  /** weights[c][f] */
  readonly weights: readonly ArrayLike<number>[];
  readonly bias: ArrayLike<number>;
}

export interface TrainOptions {
  readonly epochs: number;
  readonly learningRate: number;
  readonly l2: number;
  readonly seed: number;
}

export const DEFAULT_TRAIN_OPTIONS: TrainOptions = {
  epochs: 40,
  learningRate: 0.8,
  l2: 1e-4,
  seed: 42,
};

/** Mulberry32: tiny seeded PRNG so training (and therefore eval) is reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const rnd = prng(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export function softmaxScores(model: SoftmaxWeights, x: SparseVector): number[] {
  const logits = Array.from(model.bias, (b, c) => {
    const w = model.weights[c] ?? [];
    let z = b;
    x.indices.forEach((f, k) => (z += (w[f] ?? 0) * (x.values[k] ?? 0)));
    return z;
  });
  const max = Math.max(...logits);
  const exps = logits.map((z) => Math.exp(z - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

/**
 * Plain SGD on cross-entropy with L2. Good enough for a few thousand documents and keeps the
 * whole PoC dependency-free; the interface is what a fine-tuned HerBERT would slot into.
 */
export function trainSoftmax(
  xs: readonly SparseVector[],
  ys: readonly number[],
  classCount: number,
  featureCount: number,
  options: TrainOptions = DEFAULT_TRAIN_OPTIONS,
): SoftmaxWeights {
  const weights = Array.from({ length: classCount }, () => new Float64Array(featureCount));
  const bias = new Float64Array(classCount);
  const order = xs.map((_, i) => i);

  for (let epoch = 0; epoch < options.epochs; epoch++) {
    const lr = options.learningRate / (1 + epoch * 0.1);
    for (const i of shuffle(order, options.seed + epoch)) {
      const x = xs[i];
      const y = ys[i];
      if (!x || y === undefined) continue;
      const p = softmaxScores({ weights, bias }, x);
      for (let c = 0; c < classCount; c++) {
        const grad = (p[c] ?? 0) - (c === y ? 1 : 0);
        const w = weights[c];
        if (!w) continue;
        x.indices.forEach((f, k) => {
          w[f] = (w[f] ?? 0) * (1 - lr * options.l2) - lr * grad * (x.values[k] ?? 0);
        });
        bias[c] = (bias[c] ?? 0) - lr * grad;
      }
    }
  }
  return { weights, bias };
}
