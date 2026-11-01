import type { Logger } from 'pino';
import type { CoreSystems } from '../enrichment/core-systems.js';
import { enrich } from '../enrichment/enrich.js';
import type { IncomingDocument, ProcessedDocument } from '../domain/types.js';
import { extract } from '../extraction/extract.js';
import type { OcrProvider } from '../ingest/ocr.js';
import { extractDocumentText, isSupportedMimeType } from '../ingest/text-extraction.js';
import { route } from '../routing/route.js';
import { runCascade, type CascadeDeps } from './cascade.js';

export interface ProcessorDeps extends CascadeDeps {
  readonly systems: CoreSystems;
  readonly ocr?: OcrProvider;
  readonly logger: Logger;
}

export class UnsupportedDocumentError extends Error {}

export async function processDocument(
  doc: IncomingDocument,
  deps: ProcessorDeps,
): Promise<ProcessedDocument> {
  const started = performance.now();
  if (!isSupportedMimeType(doc.mimeType)) {
    throw new UnsupportedDocumentError(`unsupported media type ${doc.mimeType}`);
  }
  const text = await extractDocumentText(doc.content, doc.mimeType, deps.ocr);
  const { classification, llmUsage } = await runCascade(
    {
      text,
      channel: doc.channel,
      ...(doc.declaredClass ? { declaredClass: doc.declaredClass } : {}),
    },
    deps,
  );
  const extraction = extract(text.text, {
    ...(text.handwritten ? { handwritten: true } : {}),
    ...(text.secondRead ? { secondRead: text.secondRead } : {}),
  });
  const enrichment = await enrich(deps.systems, extraction.identifiers, text.text);
  const routing = route(classification, extraction, enrichment, doc.receivedAt);
  const processingMs = Math.round(performance.now() - started);

  // Log decisions and identifiers' kinds only. Never the letter text or identifier values (PII).
  deps.logger.info(
    {
      documentId: doc.id,
      channel: doc.channel,
      textSource: text.source,
      quality: Number(text.quality.toFixed(2)),
      label: classification.label,
      decidedBy: classification.decidedBy,
      reviewReasons: classification.reviewReasons,
      queue: routing.queue,
      priority: routing.priority,
      identifierKinds: extraction.identifiers.map((i) => i.kind),
      customerMatched: enrichment.customer !== undefined,
      llm: llmUsage,
      processingMs,
    },
    'document routed',
  );

  return {
    id: doc.id,
    channel: doc.channel,
    receivedAt: doc.receivedAt,
    filename: doc.filename,
    text,
    classification,
    extraction,
    enrichment,
    routing,
    processingMs,
  };
}
