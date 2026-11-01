import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { processDocument } from '../src/pipeline/processor.js';
import { DocumentStore } from '../src/store/document-store.js';
import { FakeLlm, LETTERS, silentLogger, systems, verdict } from './helpers.js';

interface DocBody {
  duplicate: boolean;
  document: {
    id: string;
    label: string | null;
    queue: string;
    status: string;
    deadline: string | null;
    result: { classification: { decidedBy: string } };
  };
}

function setup() {
  const store = new DocumentStore(':memory:');
  const llm = new FakeLlm(() => verdict('COMPLAINT', 'składam reklamację decyzji'));
  const app = createApp({
    store,
    maxUploadBytes: 1024 * 1024,
    integrationToken: 'secret-token',
    processor: {
      systems: systems(),
      logger: silentLogger,
      llm,
      llmMinConfidence: 0.7,
      ocrQualityFloor: 0.5,
    },
  });
  const post = (body: unknown) =>
    app.request('/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { app, store, post, llm };
}

describe('HTTP API', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('routes a pasted letter and returns 201 with a Location header', async () => {
    const res = await ctx.post({
      text: LETTERS.seizure,
      channel: 'PAPER_SCAN',
      receivedAt: '2026-10-30T09:00:00Z',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as DocBody;
    expect(res.headers.get('location')).toBe(`/documents/${body.document.id}`);
    expect(body.document).toMatchObject({
      label: 'BAILIFF_SEIZURE',
      queue: 'enforcement',
      status: 'ROUTED',
      deadline: '2026-11-06T09:00:00.000Z',
    });
    expect(body.document.result.classification.decidedBy).toBe('rules');
  });

  it('is idempotent on content: the same letter twice is processed once', async () => {
    const first = (await (await ctx.post({ text: LETTERS.complaint })).json()) as DocBody;
    const res = await ctx.post({ text: LETTERS.complaint });
    expect(res.status).toBe(200);
    const second = (await res.json()) as DocBody;
    expect(second).toMatchObject({ duplicate: true, document: { id: first.document.id } });
    expect(ctx.llm.calls).toBe(1);
  });

  it('accepts multipart file uploads', async () => {
    const form = new FormData();
    form.set('file', new File([LETTERS.invoice], 'faktura.txt', { type: 'text/plain' }));
    form.set('channel', 'EMAIL');
    const res = await ctx.app.request('/documents', { method: 'POST', body: form });
    expect(res.status).toBe(201);
    expect(((await res.json()) as DocBody).document).toMatchObject({
      queue: expect.any(String) as string,
    });
  });

  it('rejects invalid input with field-level issues', async () => {
    const res = await ctx.post({ text: '', channel: 'FAX' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      issues: { fieldErrors: Record<string, unknown> };
    };
    expect(body.error).toBe('validation_failed');
    expect(Object.keys(body.issues.fieldErrors)).toEqual(
      expect.arrayContaining(['text', 'channel']),
    );
  });

  it('requires exactly one of text or contentBase64', async () => {
    expect((await ctx.post({ filename: 'x.txt' })).status).toBe(400);
    expect((await ctx.post({ text: 'a', contentBase64: 'YQ==' })).status).toBe(400);
  });

  it('rejects unsupported media types with 415', async () => {
    const res = await ctx.post({
      contentBase64: Buffer.from('MZ').toString('base64'),
      filename: 'virus.exe',
    });
    expect(res.status).toBe(415);
  });

  it('rejects bodies above the upload limit', async () => {
    const res = await ctx.post({ text: 'a'.repeat(2 * 1024 * 1024) });
    expect(res.status).toBe(413);
  });

  it('lists the review work queue and applies a human correction', async () => {
    const created = (await (
      await ctx.post({
        text: 'Dzień dobry, mam pytanie o ofertę, proszę o kontakt telefoniczny w wolnej chwili.',
      })
    ).json()) as DocBody;
    expect(created.document.status).toBe('NEEDS_REVIEW');

    const list = (await (await ctx.app.request('/documents?status=NEEDS_REVIEW')).json()) as {
      id: string;
    }[];
    expect(list.map((d) => d.id)).toContain(created.document.id);

    const res = await ctx.app.request(`/documents/${created.document.id}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reviewer: 'mateusz',
        correctLabel: 'OTHER',
        correctQueue: 'customer-service',
        customerId: 'C1',
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'REVIEWED',
      label: 'OTHER',
      queue: 'customer-service',
      decidedBy: 'human',
    });
    expect(ctx.store.exportReviewedExamples()).toEqual([
      expect.objectContaining({ label: 'OTHER', customerId: 'C1' }),
    ]);
  });

  it('adds the customer column to a database created before it existed', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'store-')), 'old.sqlite');
    const old = new DatabaseSync(path);
    old.exec(
      'CREATE TABLE reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, reviewer TEXT NOT NULL, correct_label TEXT NOT NULL, correct_queue TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL) STRICT',
    );
    old.close();
    const store = new DocumentStore(path);
    expect(store.exportReviewedExamples()).toEqual([]);
    store.close();
  });

  it('validates review input and returns 404 for unknown documents', async () => {
    const bad = await ctx.app.request('/documents/nope/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewer: 'x', correctLabel: 'NOT_A_CLASS', correctQueue: 'q' }),
    });
    expect(bad.status).toBe(400);
    const missing = await ctx.app.request('/documents/nope/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reviewer: 'x',
        correctLabel: 'OTHER',
        correctQueue: 'customer-service',
      }),
    });
    expect(missing.status).toBe(404);
    expect((await ctx.app.request('/documents/nope')).status).toBe(404);
  });

  it('refuses a structured channel or declaredClass without the integration token', async () => {
    expect(
      (await ctx.post({ text: LETTERS.invoice, channel: 'OGNIVO', declaredClass: 'INVOICE' }))
        .status,
    ).toBe(403);
    expect((await ctx.post({ text: LETTERS.invoice, declaredClass: 'INVOICE' })).status).toBe(403);
    const res = await ctx.app.request('/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-integration-token': 'wrong-token!' },
      body: JSON.stringify({ text: LETTERS.invoice, channel: 'OGNIVO', declaredClass: 'INVOICE' }),
    });
    expect(res.status).toBe(403);
  });

  it('trusts the declared type from an authenticated OGNIVO integration', async () => {
    const res = await ctx.app.request('/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-integration-token': 'secret-token' },
      body: JSON.stringify({
        text: 'Komunikat OGNIVO 5531',
        channel: 'OGNIVO',
        declaredClass: 'BAILIFF_SEIZURE',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as DocBody;
    expect(body.document.result.classification.decidedBy).toBe('channel');
  });

  it('stores an unreadable PDF for a human instead of failing with 500', async () => {
    const res = await ctx.post({
      contentBase64: Buffer.from('%PDF-1.4 definitely not a pdf').toString('base64'),
      filename: 'skan.pdf',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as DocBody;
    expect(body.document).toMatchObject({ status: 'NEEDS_REVIEW', queue: 'critical-review' });
  });

  it('accepts dynamic handler queues and rejects unknown ones in a review', async () => {
    const created = (await (await ctx.post({ text: LETTERS.invoice })).json()) as DocBody;
    const review = (queue: string) =>
      ctx.app.request(`/documents/${created.document.id}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reviewer: 'x',
          correctLabel: 'CLAIM_DOCUMENTS',
          correctQueue: queue,
        }),
      });
    expect((await review('no-such-queue')).status).toBe(400);
    expect((await review('claim-handler:a.mazur')).status).toBe(200);
  });

  it('serves health, classes, queues and the operator console', async () => {
    expect((await ctx.app.request('/healthz')).status).toBe(200);
    expect(((await (await ctx.app.request('/classes')).json()) as unknown[]).length).toBe(16);
    expect((await ctx.app.request('/queues')).status).toBe(200);
    const page = await ctx.app.request('/');
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('Doc Router');
  });
});

describe('DocumentStore.save', () => {
  it('returns the existing id when a concurrent request already stored the same content', async () => {
    const store = new DocumentStore(':memory:');
    const deps = {
      systems: systems(),
      logger: silentLogger,
      llmMinConfidence: 0.7,
      ocrQualityFloor: 0.5,
    };
    const content = new TextEncoder().encode(LETTERS.seizure);
    const incoming = (id: string) => ({
      id,
      channel: 'PAPER_SCAN' as const,
      receivedAt: new Date(),
      filename: 'a.txt',
      mimeType: 'text/plain',
      content,
    });
    // Both requests passed the duplicate check before either saved: the race the constraint resolves.
    const [a, b] = await Promise.all([
      processDocument(incoming('first'), deps),
      processDocument(incoming('second'), deps),
    ]);
    const hash = createHash('sha256').update(content).digest('hex');
    expect(store.save(a, hash)).toBe('first');
    expect(store.save(b, hash)).toBe('first');
    expect(store.list({ limit: 10 })).toHaveLength(1);
  });
});
