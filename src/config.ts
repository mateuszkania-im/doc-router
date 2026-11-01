import { z } from 'zod';

const booleanFromEnv = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const ConfigSchema = z.object({
  OPENAI_API_KEY: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),
  LLM_ENABLED: booleanFromEnv.default(true),
  LLM_MODEL: z.string().min(1).default('gpt-5.4-mini-2026-03-17'),
  OCR_MODEL: z.string().min(1).default('gpt-5.4-mini-2026-03-17'),
  /**
   * A different model reads only the identifiers a second time. Agreement makes a number usable
   * for customer matching. Set to an empty string to switch the second read off.
   */
  OCR_SECOND_READ_MODEL: z
    .string()
    .default('gpt-5.4-2026-03-05')
    .transform((v) => (v ? v : undefined)),
  /** The LLM verdict is only considered at or above this self-reported confidence. */
  LLM_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.7),
  /** Documents whose OCR quality score falls below this go straight to a human. */
  OCR_QUALITY_FLOOR: z.coerce.number().min(0).max(1).default(0.5),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_PATH: z.string().min(1).default('var/doc-router.sqlite'),
  MODEL_PATH: z.string().min(1).default('var/local-classifier.json'),
  /** Stage 2 model: TF-IDF (default, won the evaluation) or frozen multilingual-e5 embeddings. */
  LOCAL_MODEL: z.enum(['tfidf', 'embeddings']).default('tfidf'),
  EMBEDDING_MODEL: z.string().min(1).default('Xenova/multilingual-e5-small'),
  EMBEDDING_MODEL_PATH: z.string().min(1).default('var/embedding-classifier.json'),
  HF_CACHE_DIR: z.string().min(1).default('var/hf-cache'),
  LLM_CACHE_DIR: z.string().min(1).default('var/llm-cache'),
  /**
   * Off for the server: the cache holds letter text and OCR output on disk. The eval harness
   * turns it on for itself so runs are reproducible.
   */
  LLM_CACHE_ENABLED: booleanFromEnv.default(false),
  INTEGRATION_TOKEN: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),
  DATASET_DIR: z.string().min(1).default('data/dataset'),
  CRM_FIXTURE_PATH: z.string().min(1).default('data/crm.json'),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 1024 * 1024),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export function llmAvailable(config: Config): boolean {
  return config.LLM_ENABLED && config.OPENAI_API_KEY !== undefined;
}
