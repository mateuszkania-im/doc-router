import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  DOCUMENT_CLASSES,
  DocumentClassSchema,
  isCritical,
  type DocumentClass,
} from '../domain/classes.js';
import type { LabelledExample } from '../domain/types.js';
import {
  buildIndex,
  fitVectorizer,
  vectorize,
  type SparseVector,
  type Vectorizer,
} from './features.js';
import {
  DEFAULT_TRAIN_OPTIONS,
  shuffle,
  softmaxScores,
  trainSoftmax,
  type TrainOptions,
} from './softmax.js';

/**
 * What the cascade needs from stage 2. TF-IDF answers synchronously; an encoder model (local
 * embeddings, a fine-tuned HerBERT service) answers asynchronously. The cascade awaits either.
 */
export interface TextClassifier {
  predict(text: string): Prediction | Promise<Prediction>;
}

/** Turns class scores into a decision against the per-class thresholds. Shared by every model. */
export function toPrediction(
  classes: readonly DocumentClass[],
  scores: readonly number[],
  thresholds: Readonly<Record<DocumentClass, number>>,
): Prediction {
  const ranking = classes
    .map((label, i) => ({ label, score: scores[i] ?? 0 }))
    .sort((a, b) => b.score - a.score);
  const top = ranking[0] ?? { label: 'OTHER' as const, score: 0 };
  const threshold = thresholds[top.label];
  return {
    label: top.label,
    confidence: top.score,
    threshold,
    // OTHER is the "I do not know" bucket; accepting it automatically would hide new document types.
    accepted: top.label !== 'OTHER' && top.score >= threshold,
    ranking,
  };
}

export interface Prediction {
  readonly label: DocumentClass;
  readonly confidence: number;
  /** Per-class auto-accept threshold the prediction was compared against. */
  readonly threshold: number;
  readonly accepted: boolean;
  readonly ranking: readonly { label: DocumentClass; score: number }[];
}

export interface CalibrationTargets {
  /** Required precision of auto-accepted predictions for ordinary classes. */
  readonly precision: number;
  /** Stricter target for classes with a statutory deadline. */
  readonly criticalPrecision: number;
  /** Below this many out-of-fold predictions a class is never auto-accepted. */
  readonly minSupport: number;
}

export const DEFAULT_CALIBRATION: CalibrationTargets = {
  precision: 0.97,
  criticalPrecision: 0.99,
  minSupport: 10,
};

/**
 * The scenario an example was written from (`brief:N` or `scenario:N` tag), so calibration can
 * hold out whole scenarios. Real mail has the same structure: a new template from a new court or a
 * new law firm is exactly the "unseen scenario" production meets, and a threshold calibrated on
 * near-copies of the training letters would promise a precision the model cannot keep.
 */
export const scenarioOf = (e: {
  readonly label: string;
  readonly tags: readonly string[];
}): string => {
  const tag = e.tags.find((t) => t.startsWith('brief:') || t.startsWith('scenario:'));
  return tag ? `${e.label}:${tag}` : '';
};

/** Above any reachable probability: the class is never auto-accepted by this stage. */
export const NEVER = 1.01;

const ModelFileSchema = z.object({
  version: z.literal(1),
  trainedAt: z.iso.datetime(),
  trainingSize: z.number().int().positive(),
  classes: z.array(DocumentClassSchema),
  vocabulary: z.array(z.string()),
  idf: z.array(z.number()),
  weights: z.array(z.array(z.number())),
  bias: z.array(z.number()),
  thresholds: z.record(DocumentClassSchema, z.number().min(0).max(NEVER)),
});
type ModelFile = z.infer<typeof ModelFileSchema>;

export class LocalClassifier implements TextClassifier {
  private readonly index: Map<string, number>;

  private constructor(private readonly model: ModelFile) {
    this.index = buildIndex(model);
  }

  static train(
    examples: readonly LabelledExample[],
    options: { train?: TrainOptions; calibration?: CalibrationTargets; folds?: number } = {},
  ): LocalClassifier {
    const trainOptions = options.train ?? DEFAULT_TRAIN_OPTIONS;
    const fitted = fit(examples, trainOptions);
    const oof = outOfFold(
      examples,
      options.folds ?? 5,
      trainOptions.seed,
      (train, valid) => {
        const f = fit(train, trainOptions);
        const index = buildIndex(f.vectorizer);
        return valid.map((e) => softmaxScores(f, vectorize(e.text, f.vectorizer, index)));
      },
      scenarioOf,
    );
    const thresholds = calibrateThresholds(oof, options.calibration ?? DEFAULT_CALIBRATION);
    return new LocalClassifier({
      version: 1,
      trainedAt: new Date().toISOString(),
      trainingSize: examples.length,
      classes: [...DOCUMENT_CLASSES],
      vocabulary: [...fitted.vectorizer.vocabulary],
      idf: [...fitted.vectorizer.idf],
      weights: fitted.weights.map((w) => Array.from(w)),
      bias: Array.from(fitted.bias),
      thresholds,
    });
  }

  static async load(path: string): Promise<LocalClassifier> {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    return new LocalClassifier(ModelFileSchema.parse(raw));
  }

  async save(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(this.model));
  }

  get thresholds(): Readonly<Partial<Record<DocumentClass, number>>> {
    return this.model.thresholds;
  }

  get trainingSize(): number {
    return this.model.trainingSize;
  }

  predict(text: string): Prediction {
    const x = vectorize(text, this.model, this.index);
    return toPrediction(this.model.classes, softmaxScores(this.model, x), this.model.thresholds);
  }
}

interface Fitted {
  readonly vectorizer: Vectorizer;
  readonly weights: readonly ArrayLike<number>[];
  readonly bias: ArrayLike<number>;
}

function fit(examples: readonly LabelledExample[], options: TrainOptions): Fitted {
  const vectorizer = fitVectorizer(examples.map((e) => e.text));
  const index = buildIndex(vectorizer);
  const xs: SparseVector[] = examples.map((e) => vectorize(e.text, vectorizer, index));
  const ys = examples.map((e) => DOCUMENT_CLASSES.indexOf(e.label));
  const { weights, bias } = trainSoftmax(
    xs,
    ys,
    DOCUMENT_CLASSES.length,
    vectorizer.vocabulary.length,
    options,
  );
  return { vectorizer, weights, bias };
}

export interface OutOfFold {
  readonly truth: DocumentClass;
  readonly predicted: DocumentClass;
  readonly confidence: number;
}

/**
 * Stratified k-fold so every class appears in every validation fold. `fitAndScore` trains on the
 * other folds and returns class scores for the held-out one, so any model shares the calibration.
 */
export function outOfFold<T extends { readonly label: DocumentClass }>(
  items: readonly T[],
  folds: number,
  seed: number,
  fitAndScore: (train: readonly T[], valid: readonly T[]) => readonly (readonly number[])[],
  groupOf: (item: T) => string = () => '',
): OutOfFold[] {
  // Folds are assigned per group (a scenario), so a validation fold holds scenarios the model has
  // never seen. Items without a group are their own group, which is plain stratified k-fold.
  const foldOf = new Map<T, number>();
  for (const label of DOCUMENT_CLASSES) {
    const mine = items.filter((e) => e.label === label);
    const keyOf = (e: T, i: number): string => groupOf(e) || `item:${String(i)}`;
    const groups = shuffle([...new Set(mine.map(keyOf))], seed);
    const foldOfGroup = new Map(groups.map((g, i) => [g, i % folds]));
    mine.forEach((e, i) => foldOf.set(e, foldOfGroup.get(keyOf(e, i)) ?? 0));
  }
  const out: OutOfFold[] = [];
  for (let k = 0; k < folds; k++) {
    const train = items.filter((e) => foldOf.get(e) !== k);
    const valid = items.filter((e) => foldOf.get(e) === k);
    if (train.length === 0 || valid.length === 0) continue;
    fitAndScore(train, valid).forEach((scores, i) => {
      const truth = valid[i]?.label;
      if (!truth) return;
      const best = scores.reduce((bi, s, j) => (s > (scores[bi] ?? 0) ? j : bi), 0);
      out.push({
        truth,
        predicted: DOCUMENT_CLASSES[best] ?? 'OTHER',
        confidence: scores[best] ?? 0,
      });
    });
  }
  return out;
}

/**
 * For each class pick the lowest confidence threshold at which the auto-accepted out-of-fold
 * predictions still meet the precision target. One global threshold optimises the average and
 * quietly sacrifices rare classes, which are exactly the critical ones.
 *
 * This is a point estimate. With tens of examples per class it is a weak guarantee (10 out of 10
 * correct only bounds the error rate below about 26% at 95%), which is why critical classes also
 * have the keyword safety net. With the 300+ examples per critical class the PoC plan calls for,
 * replace it with a Wilson lower bound against the target.
 */
export function calibrateThresholds(
  oof: readonly OutOfFold[],
  targets: CalibrationTargets,
): Record<DocumentClass, number> {
  const result = {} as Record<DocumentClass, number>;
  for (const label of DOCUMENT_CLASSES) {
    const target = isCritical(label) ? targets.criticalPrecision : targets.precision;
    const predicted = oof
      .filter((o) => o.predicted === label)
      .sort((a, b) => b.confidence - a.confidence);
    let best = NEVER;
    let correct = 0;
    predicted.forEach((o, i) => {
      if (o.truth === label) correct++;
      // Judge only at the end of a run of equal confidences: a threshold accepts all ties at once.
      const next = predicted[i + 1];
      if (next && next.confidence === o.confidence) return;
      const support = i + 1;
      if (support >= targets.minSupport && correct / support >= target) best = o.confidence;
    });
    result[label] = label === 'OTHER' ? NEVER : best;
  }
  return result;
}
