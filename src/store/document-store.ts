import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { DocumentClassSchema, type DocumentClass } from '../domain/classes.js';
import { ChannelSchema, type ProcessedDocument } from '../domain/types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  id               TEXT PRIMARY KEY,
  content_sha256   TEXT NOT NULL UNIQUE,
  received_at      TEXT NOT NULL,
  channel          TEXT NOT NULL,
  filename         TEXT NOT NULL,
  label            TEXT,
  decided_by       TEXT,
  queue            TEXT NOT NULL,
  priority         TEXT NOT NULL,
  deadline         TEXT,
  status           TEXT NOT NULL CHECK (status IN ('ROUTED', 'NEEDS_REVIEW', 'REVIEWED')),
  result_json      TEXT NOT NULL,
  created_at       TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS documents_queue ON documents (queue, status, deadline);

CREATE TABLE IF NOT EXISTS reviews (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id    TEXT NOT NULL REFERENCES documents (id),
  reviewer       TEXT NOT NULL,
  correct_label  TEXT NOT NULL,
  correct_queue  TEXT NOT NULL,
  customer_id    TEXT,
  note           TEXT,
  created_at     TEXT NOT NULL
) STRICT;
`;

const DocumentRowSchema = z.object({
  id: z.string(),
  received_at: z.string(),
  channel: ChannelSchema,
  filename: z.string(),
  label: DocumentClassSchema.nullable(),
  decided_by: z.string().nullable(),
  queue: z.string(),
  priority: z.enum(['P1', 'P2', 'P3']),
  deadline: z.string().nullable(),
  status: z.enum(['ROUTED', 'NEEDS_REVIEW', 'REVIEWED']),
  result_json: z.string(),
});

export interface DocumentSummary {
  readonly id: string;
  readonly receivedAt: string;
  readonly channel: string;
  readonly filename: string;
  readonly label: DocumentClass | null;
  readonly decidedBy: string | null;
  readonly queue: string;
  readonly priority: string;
  readonly deadline: string | null;
  readonly status: 'ROUTED' | 'NEEDS_REVIEW' | 'REVIEWED';
}

export interface StoredDocument extends DocumentSummary {
  readonly result: unknown;
}

const toSummary = (row: z.infer<typeof DocumentRowSchema>): DocumentSummary => ({
  id: row.id,
  receivedAt: row.received_at,
  channel: row.channel,
  filename: row.filename,
  label: row.label,
  decidedBy: row.decided_by,
  queue: row.queue,
  priority: row.priority,
  deadline: row.deadline,
  status: row.status,
});

export interface ReviewInput {
  readonly reviewer: string;
  readonly correctLabel: DocumentClass;
  readonly correctQueue: string;
  /** The customer the reviewer confirmed, when the letter is about one. */
  readonly customerId?: string;
  readonly note?: string;
}

export class DocumentStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Databases created before customer confirmation existed get the column added in place. */
  private migrate(): void {
    const columns = z
      .array(z.object({ name: z.string() }))
      .parse(this.db.prepare('PRAGMA table_info(reviews)').all());
    if (!columns.some((c) => c.name === 'customer_id'))
      this.db.exec('ALTER TABLE reviews ADD COLUMN customer_id TEXT');
  }

  findIdByHash(sha256: string): string | undefined {
    const row = this.db.prepare('SELECT id FROM documents WHERE content_sha256 = ?').get(sha256);
    return row ? z.object({ id: z.string() }).parse(row).id : undefined;
  }

  /**
   * Returns the id that holds this content: the new one, or the one stored by a concurrent request
   * that won the race on the same hash.
   */
  save(doc: ProcessedDocument, sha256: string): string {
    const result = this.db
      .prepare(
        `INSERT INTO documents (id, content_sha256, received_at, channel, filename, label, decided_by, queue, priority, deadline, status, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (content_sha256) DO NOTHING`,
      )
      .run(
        doc.id,
        sha256,
        doc.receivedAt.toISOString(),
        doc.channel,
        doc.filename,
        doc.classification.label,
        doc.classification.decidedBy,
        doc.routing.queue,
        doc.routing.priority,
        doc.routing.deadline?.toISOString() ?? null,
        doc.routing.requiresHumanReview ? 'NEEDS_REVIEW' : 'ROUTED',
        JSON.stringify(doc),
        new Date().toISOString(),
      );
    if (result.changes === 1) return doc.id;
    const existing = this.findIdByHash(sha256);
    if (!existing) throw new Error('document insert ignored but no row holds its hash');
    return existing;
  }

  get(id: string): StoredDocument | undefined {
    const raw = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    if (!raw) return undefined;
    const row = DocumentRowSchema.parse(raw);
    return { ...toSummary(row), result: JSON.parse(row.result_json) as unknown };
  }

  /** Work list ordered the way a team should work it: nearest deadline first, then priority. */
  list(filter: { queue?: string; status?: string; limit: number }): DocumentSummary[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.queue) {
      where.push('queue = ?');
      params.push(filter.queue);
    }
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    const sql = `SELECT * FROM documents ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY deadline IS NULL, deadline, priority, received_at LIMIT ${String(filter.limit)}`;
    return this.db
      .prepare(sql)
      .all(...params)
      .map((r) => toSummary(DocumentRowSchema.parse(r)));
  }

  queueStats(): { queue: string; status: string; count: number }[] {
    const rows = this.db
      .prepare(
        'SELECT queue, status, COUNT(*) AS count FROM documents GROUP BY queue, status ORDER BY queue',
      )
      .all();
    return z
      .array(z.object({ queue: z.string(), status: z.string(), count: z.number() }))
      .parse(rows);
  }

  /** A human correction closes the review and becomes a training label for the next model. */
  review(id: string, input: ReviewInput): boolean {
    const now = new Date().toISOString();
    this.db.exec('BEGIN');
    try {
      const updated = this.db
        .prepare(
          `UPDATE documents SET label = ?, queue = ?, status = 'REVIEWED', decided_by = 'human' WHERE id = ?`,
        )
        .run(input.correctLabel, input.correctQueue, id);
      if (updated.changes === 0) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.db
        .prepare(
          'INSERT INTO reviews (document_id, reviewer, correct_label, correct_queue, customer_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          id,
          input.reviewer,
          input.correctLabel,
          input.correctQueue,
          input.customerId ?? null,
          input.note ?? null,
          now,
        );
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Reviewed documents with their text, ready to append to the training set. The confirmed
   * customer is a label too: it is the ground truth for tuning customer matching on real mail.
   */
  exportReviewedExamples(): {
    id: string;
    label: DocumentClass;
    text: string;
    customerId: string | null;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT d.id AS id, r.correct_label AS label, r.customer_id AS customer_id, d.result_json AS result_json
        FROM reviews r JOIN documents d ON d.id = r.document_id
        WHERE r.id IN (SELECT MAX(id) FROM reviews GROUP BY document_id)`,
      )
      .all();
    const ResultTextSchema = z.object({ text: z.object({ text: z.string() }) });
    return z
      .array(
        z.object({
          id: z.string(),
          label: DocumentClassSchema,
          customer_id: z.string().nullable(),
          result_json: z.string(),
        }),
      )
      .parse(rows)
      .map((r) => ({
        id: r.id,
        label: r.label,
        customerId: r.customer_id,
        text: ResultTextSchema.parse(JSON.parse(r.result_json)).text.text,
      }))
      .filter((r) => r.text.trim().length > 0);
  }

  close(): void {
    this.db.close();
  }
}
