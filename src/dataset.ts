import { readFile } from 'node:fs/promises';
import { LabelledExampleSchema, type LabelledExample } from './domain/types.js';

/** Parses JSONL with Zod, reporting the exact line of any bad record instead of failing vaguely. */
export async function loadJsonl(path: string): Promise<LabelledExample[]> {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, n }) => {
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch (error) {
        throw new Error(`${path}:${String(n)}: invalid JSON`, { cause: error });
      }
      const parsed = LabelledExampleSchema.safeParse(json);
      if (!parsed.success) throw new Error(`${path}:${String(n)}: ${parsed.error.message}`);
      return parsed.data;
    });
}
