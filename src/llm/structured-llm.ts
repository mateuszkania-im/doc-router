import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { ResponseInputContent } from 'openai/resources/responses/responses';
import { z } from 'zod';

export interface LlmUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly cached: boolean;
}

export interface StructuredRequest<T extends z.ZodType> {
  readonly name: string;
  /** Changing the prompt must bump this, otherwise stale cached answers would be served. */
  readonly promptVersion: string;
  readonly schema: T;
  readonly system: string;
  readonly user: readonly ResponseInputContent[];
}

export interface StructuredResult<T> {
  readonly data: T;
  readonly usage: LlmUsage;
}

/**
 * The only door to an LLM in the codebase: one place to trace, cache, swap providers (an EU-hosted
 * or on-prem model is a new implementation of this interface) and enforce output schemas.
 */
export interface StructuredLlm {
  parse<T extends z.ZodType>(request: StructuredRequest<T>): Promise<StructuredResult<z.infer<T>>>;
}

export class OpenAiStructuredLlm implements StructuredLlm {
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
    /** 60 s suits classification; long generation jobs pass more. */
    timeoutMs = 60_000,
  ) {
    // The SDK retries 408/409/429/5xx with exponential backoff; we only bound it.
    this.client = new OpenAI({ apiKey, maxRetries: 3, timeout: timeoutMs });
  }

  async parse<T extends z.ZodType>(
    request: StructuredRequest<T>,
  ): Promise<StructuredResult<z.infer<T>>> {
    const started = performance.now();
    const response = await this.client.responses.parse({
      model: this.model,
      instructions: request.system,
      input: [{ role: 'user', content: [...request.user] }],
      text: { format: zodTextFormat(request.schema, request.name) },
      // Provider-side storage off: letters contain personal data and bank or insurance secrecy.
      store: false,
    });
    if (response.output_parsed === null) {
      throw new Error(
        `LLM returned no parsable output for ${request.name} (status ${response.status ?? 'unknown'})`,
      );
    }
    // Re-validate locally: the SDK checks the JSON shape, Zod also enforces refinements and ranges.
    const data = request.schema.parse(response.output_parsed);
    return {
      data,
      usage: {
        model: response.model,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        latencyMs: Math.round(performance.now() - started),
        cached: false,
      },
    };
  }
}

const CacheEntrySchema = z.object({
  data: z.unknown(),
  usage: z.object({
    model: z.string(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    latencyMs: z.number(),
  }),
});

/**
 * Content-addressed cache: same model, prompt version, schema and input give the same answer from
 * disk. Makes `pnpm eval` reproducible and free to re-run, and never re-sends a letter twice.
 */
export class CachedStructuredLlm implements StructuredLlm {
  constructor(
    private readonly inner: StructuredLlm,
    private readonly dir: string,
    private readonly modelKey: string,
  ) {}

  async parse<T extends z.ZodType>(
    request: StructuredRequest<T>,
  ): Promise<StructuredResult<z.infer<T>>> {
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          this.modelKey,
          request.name,
          request.promptVersion,
          request.system,
          request.user,
          z.toJSONSchema(request.schema),
        ]),
      )
      .digest('hex');
    const path = join(this.dir, `${key}.json`);
    const hit = await readEntry(path);
    if (hit) {
      const data = request.schema.safeParse(hit.data);
      if (data.success) return { data: data.data, usage: { ...hit.usage, cached: true } };
    }
    const result = await this.inner.parse(request);
    await mkdir(this.dir, { recursive: true });
    // Write-then-rename: a crash mid-write must not leave a truncated entry behind.
    const tmp = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`;
    await writeFile(tmp, JSON.stringify({ data: result.data, usage: result.usage }));
    await rename(tmp, path);
    return result;
  }
}

/** Missing, unreadable or corrupt entries are cache misses, never errors. */
async function readEntry(path: string): Promise<z.infer<typeof CacheEntrySchema> | undefined> {
  try {
    const parsed = CacheEntrySchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
