import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { EmbeddingClassifier, TransformersEmbedder } from './classifier/embedding-classifier.js';
import { LocalClassifier, type TextClassifier } from './classifier/local-classifier.js';
import { llmAvailable, type Config } from './config.js';
import { loadJsonl } from './dataset.js';
import { InMemoryCoreSystems } from './enrichment/core-systems.js';
import { LlmVisionOcr, SecondReadOcr, type OcrProvider } from './ingest/ocr.js';
import {
  CachedStructuredLlm,
  OpenAiStructuredLlm,
  type StructuredLlm,
} from './llm/structured-llm.js';
import type { ProcessorDeps } from './pipeline/processor.js';
import { calibrateRules, type RulePolicy } from './pipeline/rules.js';

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

export async function loadOrTrainClassifier(
  config: Config,
  logger: Logger,
): Promise<TextClassifier | undefined> {
  const embeddings = config.LOCAL_MODEL === 'embeddings';
  const path = embeddings ? config.EMBEDDING_MODEL_PATH : config.MODEL_PATH;
  const embedder = embeddings
    ? new TransformersEmbedder(config.EMBEDDING_MODEL, config.HF_CACHE_DIR)
    : undefined;
  if (await exists(path))
    return embedder ? EmbeddingClassifier.load(path, embedder) : LocalClassifier.load(path);
  const trainPath = join(config.DATASET_DIR, 'train.jsonl');
  if (!(await exists(trainPath))) {
    logger.warn({ trainPath }, 'no model and no training data: local classifier disabled');
    return undefined;
  }
  logger.info({ trainPath, model: config.LOCAL_MODEL }, 'no saved model, training one now');
  const examples = await loadJsonl(trainPath);
  const model = embedder
    ? await EmbeddingClassifier.train(examples, embedder)
    : LocalClassifier.train(examples);
  await model.save(path);
  return model;
}

export function createLlm(
  config: Config,
  model: string,
  cache = config.LLM_CACHE_ENABLED,
): StructuredLlm | undefined {
  if (!llmAvailable(config) || !config.OPENAI_API_KEY) return undefined;
  const llm = new OpenAiStructuredLlm(config.OPENAI_API_KEY, model);
  return cache ? new CachedStructuredLlm(llm, config.LLM_CACHE_DIR, model) : llm;
}

/** Which rules may decide alone, measured on the training letters; all of them if there are none. */
async function loadRulePolicy(config: Config, logger: Logger): Promise<RulePolicy | undefined> {
  const trainPath = join(config.DATASET_DIR, 'train.jsonl');
  if (!(await exists(trainPath))) return undefined;
  const { policy, stats } = calibrateRules(await loadJsonl(trainPath));
  logger.info(
    { decisive: policy.decisive, demoted: stats.filter((s) => !s.decisive).map((s) => s.id) },
    'rule policy calibrated',
  );
  return policy;
}

/** Composition root: the only place that knows concrete implementations. */
export async function buildProcessorDeps(config: Config, logger: Logger): Promise<ProcessorDeps> {
  const [localClassifier, systems, rulePolicy] = await Promise.all([
    loadOrTrainClassifier(config, logger),
    InMemoryCoreSystems.fromFile(config.CRM_FIXTURE_PATH),
    loadRulePolicy(config, logger),
  ]);
  const llm = createLlm(config, config.LLM_MODEL);
  const ocrLlm = createLlm(config, config.OCR_MODEL);
  const verifierLlm = config.OCR_SECOND_READ_MODEL
    ? createLlm(config, config.OCR_SECOND_READ_MODEL)
    : undefined;
  let ocr: OcrProvider | undefined = ocrLlm ? new LlmVisionOcr(ocrLlm) : undefined;
  if (ocr && verifierLlm) ocr = new SecondReadOcr(ocr, verifierLlm);
  return {
    systems,
    logger,
    llmMinConfidence: config.LLM_MIN_CONFIDENCE,
    ocrQualityFloor: config.OCR_QUALITY_FLOOR,
    ...(localClassifier ? { localClassifier } : {}),
    ...(rulePolicy ? { rulePolicy } : {}),
    ...(llm ? { llm } : {}),
    ...(ocr ? { ocr } : {}),
  };
}
