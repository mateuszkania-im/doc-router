/**
 * Trains the local classifier on the training split plus every human correction from the store,
 * then saves it. Human reviews are the cheapest source of new labels the system will ever get.
 *
 *   pnpm train                          TF-IDF model
 *   LOCAL_MODEL=embeddings pnpm train   multilingual-e5 embeddings + linear head
 */
import { join } from 'node:path';
import { EmbeddingClassifier, TransformersEmbedder } from '../classifier/embedding-classifier.js';
import { LocalClassifier } from '../classifier/local-classifier.js';
import { loadConfig } from '../config.js';
import { loadJsonl } from '../dataset.js';
import type { LabelledExample } from '../domain/types.js';
import { DocumentStore } from '../store/document-store.js';

const config = loadConfig();
const train = await loadJsonl(join(config.DATASET_DIR, 'train.jsonl'));
const store = new DocumentStore(config.DATABASE_PATH);
const reviewed: LabelledExample[] = store
  .exportReviewedExamples()
  .map((r) => ({ id: `review-${r.id}`, label: r.label, text: r.text, tags: ['human_review'] }));
store.close();

const started = performance.now();
const examples = [...train, ...reviewed];
const embeddings = config.LOCAL_MODEL === 'embeddings';
const path = embeddings ? config.EMBEDDING_MODEL_PATH : config.MODEL_PATH;
const model = embeddings
  ? await EmbeddingClassifier.train(
      examples,
      new TransformersEmbedder(config.EMBEDDING_MODEL, config.HF_CACHE_DIR),
    )
  : LocalClassifier.train(examples);
await model.save(path);
console.log(
  `trained on ${String(train.length)} examples + ${String(reviewed.length)} human reviews in ${(performance.now() - started).toFixed(0)} ms, saved to ${path}`,
);
console.table(
  Object.fromEntries(
    Object.entries(model.thresholds).map(([k, v]) => [k, v > 1 ? 'never auto' : v.toFixed(3)]),
  ),
);
