import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { FeatureExtractionPipeline } from '@huggingface/transformers';
import { dirname } from 'node:path';
import { z } from 'zod';
import { DOCUMENT_CLASSES, DocumentClassSchema } from '../domain/classes.js';
import type { LabelledExample } from '../domain/types.js';
import type { SparseVector } from './features.js';
import {
  calibrateThresholds,
  DEFAULT_CALIBRATION,
  NEVER,
  outOfFold,
  scenarioOf,
  toPrediction,
  type CalibrationTargets,
  type Prediction,
  type TextClassifier,
} from './local-classifier.js';
import { softmaxScores, trainSoftmax, type SoftmaxWeights, type TrainOptions } from './softmax.js';

/** Turns texts into fixed-size vectors. A local ONNX encoder in the PoC, a GPU service later. */
export interface Embedder {
  readonly model: string;
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

export const DEFAULT_EMBEDDING_MODEL = 'Xenova/multilingual-e5-small';

/**
 * multilingual-e5 (a BERT-family encoder trained for sentence embeddings, Polish included) run
 * locally through ONNX Runtime: no GPU, no Python, and the letter never leaves the machine. The
 * model downloads once (about 120 MB quantised) into the cache directory.
 */
export class TransformersEmbedder implements Embedder {
  private extractor?: Promise<FeatureExtractionPipeline>;
  /** Encodings by text: retraining on a different sample (learning curves) never re-encodes. */
  private readonly memo = new Map<string, Float32Array>();

  constructor(
    readonly model: string = DEFAULT_EMBEDDING_MODEL,
    private readonly cacheDir = 'var/hf-cache',
  ) {}

  /** Loaded lazily: the TF-IDF path never pays for importing ONNX Runtime. */
  private load(): Promise<FeatureExtractionPipeline> {
    this.extractor ??= (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = this.cacheDir;
      return pipeline('feature-extraction', this.model, { dtype: 'q8' });
    })();
    return this.extractor;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    const missing = [...new Set(texts.filter((t) => !this.memo.has(t)))];
    const fresh = await this.encode(missing);
    missing.forEach((t, i) => {
      const v = fresh[i];
      if (v) this.memo.set(t, v);
    });
    return texts.map((t) => this.memo.get(t) ?? new Float32Array());
  }

  private async encode(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const extract = await this.load();
    const out: Float32Array[] = [];
    // e5 expects a role prefix; the encoder truncates at 512 tokens, which keeps the letterhead
    // and the opening paragraph, where the type of a letter is almost always stated.
    for (let i = 0; i < texts.length; i += 16) {
      const batch = texts.slice(i, i + 16).map((t) => `query: ${t}`);
      const result = await extract(batch, { pooling: 'mean', normalize: true });
      for (const row of result.tolist() as number[][]) out.push(Float32Array.from(row));
    }
    return out;
  }
}

/**
 * Dense standardised features overfit fast with a few hundred examples: a small step and few
 * passes won a grid search on out-of-sample accuracy (20 to 200 epochs, step 0.005 to 0.1).
 */
export const EMBEDDING_TRAIN_OPTIONS: TrainOptions = {
  epochs: 20,
  learningRate: 0.005,
  l2: 1e-4,
  seed: 42,
};

const EmbeddingModelFileSchema = z.object({
  version: z.literal(1),
  kind: z.literal('embeddings'),
  embeddingModel: z.string(),
  trainedAt: z.iso.datetime(),
  trainingSize: z.number().int().positive(),
  classes: z.array(DocumentClassSchema),
  mean: z.array(z.number()),
  std: z.array(z.number()),
  weights: z.array(z.array(z.number())),
  bias: z.array(z.number()),
  thresholds: z.record(DocumentClassSchema, z.number().min(0).max(NEVER)),
});
type EmbeddingModelFile = z.infer<typeof EmbeddingModelFileSchema>;

interface Standardiser {
  readonly mean: ArrayLike<number>;
  readonly std: ArrayLike<number>;
}

function fitStandardiser(vectors: readonly Float32Array[]): Standardiser {
  const dims = vectors[0]?.length ?? 0;
  const mean = new Float64Array(dims);
  const std = new Float64Array(dims);
  for (const v of vectors) v.forEach((x, d) => (mean[d] = (mean[d] ?? 0) + x / vectors.length));
  for (const v of vectors)
    v.forEach((x, d) => (std[d] = (std[d] ?? 0) + (x - (mean[d] ?? 0)) ** 2 / vectors.length));
  return { mean, std: std.map((s) => Math.sqrt(s) || 1) };
}

/**
 * Sentence embeddings cluster tightly (cosine similarities around 0.8 for any two letters), so
 * features are standardised per dimension before the linear head sees them. The dense vector is
 * passed to the same softmax trainer as TF-IDF, written as a sparse vector with every index set.
 */
function toFeatures(v: Float32Array, s: Standardiser): SparseVector {
  const values = Array.from(v, (x, d) => (x - (s.mean[d] ?? 0)) / (s.std[d] ?? 1));
  return { indices: values.map((_, d) => d), values };
}

function fitHead(
  vectors: readonly Float32Array[],
  labels: readonly LabelledExample['label'][],
  options: TrainOptions,
): SoftmaxWeights & Standardiser {
  const standardiser = fitStandardiser(vectors);
  const head = trainSoftmax(
    vectors.map((v) => toFeatures(v, standardiser)),
    labels.map((l) => DOCUMENT_CLASSES.indexOf(l)),
    DOCUMENT_CLASSES.length,
    vectors[0]?.length ?? 0,
    options,
  );
  return { ...head, ...standardiser };
}

/**
 * Stage 2 with a BERT-family encoder: frozen multilingual-e5 embeddings plus a linear head,
 * calibrated out-of-fold with exactly the same per-class thresholds as the TF-IDF model. Freezing
 * the encoder is the right call at a few hundred examples (fine-tuning would overfit); with a few
 * thousand real letters, a fine-tuned HerBERT replaces it behind the same interface.
 */
export class EmbeddingClassifier implements TextClassifier {
  private constructor(
    private readonly model: EmbeddingModelFile,
    private readonly embedder: Embedder,
  ) {}

  static async train(
    examples: readonly LabelledExample[],
    embedder: Embedder,
    options: { train?: TrainOptions; calibration?: CalibrationTargets; folds?: number } = {},
  ): Promise<EmbeddingClassifier> {
    const trainOptions = options.train ?? EMBEDDING_TRAIN_OPTIONS;
    // Embed once; every fold reuses the vectors, so calibration costs no extra encoder passes.
    const vectors = await embedder.embed(examples.map((e) => e.text));
    const rows = examples.map((e, i) => ({
      label: e.label,
      group: scenarioOf(e),
      vector: vectors[i] ?? new Float32Array(),
    }));
    const oof = outOfFold(
      rows,
      options.folds ?? 5,
      trainOptions.seed,
      (train, valid) => {
        const head = fitHead(
          train.map((r) => r.vector),
          train.map((r) => r.label),
          trainOptions,
        );
        return valid.map((r) => softmaxScores(head, toFeatures(r.vector, head)));
      },
      (r) => r.group,
    );
    const head = fitHead(
      vectors,
      examples.map((e) => e.label),
      trainOptions,
    );
    return new EmbeddingClassifier(
      {
        version: 1,
        kind: 'embeddings',
        embeddingModel: embedder.model,
        trainedAt: new Date().toISOString(),
        trainingSize: examples.length,
        classes: [...DOCUMENT_CLASSES],
        mean: Array.from(head.mean),
        std: Array.from(head.std),
        weights: head.weights.map((w) => Array.from(w)),
        bias: Array.from(head.bias),
        thresholds: calibrateThresholds(oof, options.calibration ?? DEFAULT_CALIBRATION),
      },
      embedder,
    );
  }

  static async load(path: string, embedder: Embedder): Promise<EmbeddingClassifier> {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    const model = EmbeddingModelFileSchema.parse(raw);
    if (model.embeddingModel !== embedder.model)
      throw new Error(
        `model file was trained on ${model.embeddingModel}, embedder is ${embedder.model}`,
      );
    return new EmbeddingClassifier(model, embedder);
  }

  async save(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(this.model));
  }

  get thresholds(): Readonly<Partial<Record<LabelledExample['label'], number>>> {
    return this.model.thresholds;
  }

  async predict(text: string): Promise<Prediction> {
    const [vector] = await this.embedder.embed([text]);
    if (!vector) throw new Error('embedder returned no vector');
    const scores = softmaxScores(this.model, toFeatures(vector, this.model));
    return toPrediction(this.model.classes, scores, this.model.thresholds);
  }
}
