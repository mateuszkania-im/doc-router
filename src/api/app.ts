import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { requestId } from 'hono/request-id';
import { z } from 'zod';
import { CLASS_DEFINITIONS, DOCUMENT_CLASSES, DocumentClassSchema } from '../domain/classes.js';
import { ChannelSchema } from '../domain/types.js';
import { isSupportedMimeType, mimeTypeFromFilename } from '../ingest/text-extraction.js';
import { processDocument, type ProcessorDeps } from '../pipeline/processor.js';
import { QUEUES } from '../routing/route.js';
import type { DocumentStore } from '../store/document-store.js';
import { reviewPage } from './review-page.js';

export interface AppDeps {
  readonly processor: ProcessorDeps;
  readonly store: DocumentStore;
  readonly maxUploadBytes: number;
  /**
   * Shared secret of the OGNIVO / e-Doręczenia integrations. A structured channel skips the
   * classifier, so claiming one must be authenticated; without a token configured it is refused.
   */
  readonly integrationToken?: string;
}

const STRUCTURED_CHANNELS = new Set(['OGNIVO', 'E_DORECZENIA']);

/** Static queues plus per-handler claim queues created by routing. */
const QueueSchema = z
  .string()
  .refine(
    (q) =>
      (Object.values(QUEUES) as string[]).includes(q) ||
      /^claim-handler:[a-z0-9._-]{1,50}$/.test(q),
    { message: 'unknown queue' },
  );

function tokenMatches(given: string | undefined, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const MetadataSchema = z.object({
  filename: z.string().min(1).max(255).default('letter.txt'),
  channel: ChannelSchema.default('UNKNOWN'),
  receivedAt: z.iso.datetime({ offset: true }).optional(),
  declaredClass: DocumentClassSchema.optional(),
});

const JsonSubmissionSchema = MetadataSchema.extend({
  text: z.string().min(1).max(200_000).optional(),
  contentBase64: z.base64().optional(),
  mimeType: z.string().optional(),
}).refine((v) => (v.text === undefined) !== (v.contentBase64 === undefined), {
  message: 'provide exactly one of "text" or "contentBase64"',
});

const ListQuerySchema = z.object({
  queue: z.string().optional(),
  status: z.enum(['ROUTED', 'NEEDS_REVIEW', 'REVIEWED']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const ReviewSchema = z.object({
  reviewer: z.string().min(1).max(100),
  correctLabel: DocumentClassSchema,
  correctQueue: QueueSchema,
  /** Empty means "not about any customer" or "not confirmed"; the console sends "" for that. */
  customerId: z
    .string()
    .max(64)
    .optional()
    .transform((v) => (v ? v : undefined)),
  note: z.string().max(2000).optional(),
});

function badRequest(error: z.ZodError): never {
  throw new HTTPException(400, {
    res: Response.json(
      { error: 'validation_failed', issues: z.flattenError(error) },
      { status: 400 },
    ),
  });
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.use('*', requestId());

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    deps.processor.logger.error({ err, requestId: c.get('requestId') }, 'unhandled error');
    return c.json({ error: 'internal_error', requestId: c.get('requestId') }, 500);
  });

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  app.get('/classes', (c) =>
    c.json(DOCUMENT_CLASSES.map((id) => ({ id, ...CLASS_DEFINITIONS[id] }))),
  );

  app.get('/queues', (c) =>
    c.json({ queues: Object.values(QUEUES), stats: deps.store.queueStats() }),
  );

  /**
   * Accepts either multipart/form-data (field "file", optional "channel", "receivedAt") or JSON
   * with "text" or "contentBase64". Same content twice returns the first result (idempotent intake).
   */
  app.post('/documents', bodyLimit({ maxSize: deps.maxUploadBytes }), async (c) => {
    const contentType = c.req.header('content-type') ?? '';
    let input: z.infer<typeof MetadataSchema>;
    let content: Uint8Array;
    let mimeType: string | undefined;

    if (contentType.startsWith('multipart/form-data')) {
      const form = await c.req.formData();
      const file = form.get('file');
      if (!(file instanceof File))
        throw new HTTPException(400, { message: 'multipart field "file" is required' });
      const parsed = MetadataSchema.safeParse({
        filename: file.name,
        channel: form.get('channel') ?? undefined,
        receivedAt: form.get('receivedAt') ?? undefined,
        declaredClass: form.get('declaredClass') ?? undefined,
      });
      if (!parsed.success) badRequest(parsed.error);
      input = parsed.data;
      content = new Uint8Array(await file.arrayBuffer());
      mimeType = file.type || mimeTypeFromFilename(file.name);
    } else {
      const parsed = JsonSubmissionSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!parsed.success) badRequest(parsed.error);
      const body = parsed.data;
      input = body;
      content =
        body.text !== undefined
          ? new TextEncoder().encode(body.text)
          : Buffer.from(body.contentBase64 ?? '', 'base64');
      mimeType =
        body.text !== undefined
          ? 'text/plain'
          : (body.mimeType ?? mimeTypeFromFilename(body.filename));
    }

    if (content.byteLength === 0) throw new HTTPException(400, { message: 'empty document' });
    if (!mimeType || !isSupportedMimeType(mimeType)) {
      throw new HTTPException(415, { message: `unsupported media type ${mimeType ?? 'unknown'}` });
    }

    const claimsStructuredChannel =
      STRUCTURED_CHANNELS.has(input.channel) || input.declaredClass !== undefined;
    if (
      claimsStructuredChannel &&
      !tokenMatches(c.req.header('x-integration-token'), deps.integrationToken)
    ) {
      throw new HTTPException(403, {
        message: 'structured channels and declaredClass require a valid X-Integration-Token',
      });
    }

    const sha256 = createHash('sha256').update(content).digest('hex');
    const existing = deps.store.findIdByHash(sha256);
    if (existing) return c.json({ duplicate: true, document: deps.store.get(existing) }, 200);

    const processed = await processDocument(
      {
        id: randomUUID(),
        channel: input.channel,
        receivedAt: input.receivedAt ? new Date(input.receivedAt) : new Date(),
        filename: input.filename,
        mimeType,
        content,
        ...(input.declaredClass ? { declaredClass: input.declaredClass } : {}),
      },
      deps.processor,
    );
    const storedId = deps.store.save(processed, sha256);
    if (storedId !== processed.id) {
      return c.json({ duplicate: true, document: deps.store.get(storedId) }, 200);
    }
    return c.json({ duplicate: false, document: deps.store.get(storedId) }, 201, {
      Location: `/documents/${storedId}`,
    });
  });

  app.get('/documents', (c) => {
    const parsed = ListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) badRequest(parsed.error);
    const { queue, status, limit } = parsed.data;
    return c.json(
      deps.store.list({ limit, ...(queue ? { queue } : {}), ...(status ? { status } : {}) }),
    );
  });

  app.get('/documents/:id', (c) => {
    const doc = deps.store.get(c.req.param('id'));
    return doc ? c.json(doc) : c.json({ error: 'not_found' }, 404);
  });

  app.post('/documents/:id/review', async (c) => {
    const parsed = ReviewSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) badRequest(parsed.error);
    const { note, customerId, ...rest } = parsed.data;
    const ok = deps.store.review(c.req.param('id'), {
      ...rest,
      ...(note ? { note } : {}),
      ...(customerId ? { customerId } : {}),
    });
    return ok ? c.json(deps.store.get(c.req.param('id'))) : c.json({ error: 'not_found' }, 404);
  });

  app.get('/', (c) => c.html(reviewPage()));

  return app;
}
