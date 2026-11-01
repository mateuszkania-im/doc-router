import { serve } from '@hono/node-server';
import { createApp } from './api/app.js';
import { loadConfig, llmAvailable } from './config.js';
import { buildProcessorDeps } from './container.js';
import { createLogger } from './logger.js';
import { DocumentStore } from './store/document-store.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const processor = await buildProcessorDeps(config, logger);
const store = new DocumentStore(config.DATABASE_PATH);
const app = createApp({
  processor,
  store,
  maxUploadBytes: config.MAX_UPLOAD_BYTES,
  ...(config.INTEGRATION_TOKEN ? { integrationToken: config.INTEGRATION_TOKEN } : {}),
});

const server = serve({ fetch: app.fetch, port: config.PORT, hostname: '127.0.0.1' }, (info) => {
  logger.info(
    {
      url: `http://127.0.0.1:${String(info.port)}`,
      llm: llmAvailable(config) ? config.LLM_MODEL : 'disabled',
      localModel: processor.localClassifier ? 'loaded' : 'none',
    },
    'doc-router listening',
  );
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
