/**
 * Renders test letters as images (typed scans, phone photos, handwriting) with gpt-image-2 on
 * fal.ai, so OCR, the second read and handwriting handling are tested on pixels, not on text.
 *
 *   FAL_API_KEY=... pnpm scans:generate              8 letters per class (128 images)
 *   FAL_API_KEY=... pnpm scans:generate --per-class 2
 *
 * Ground truth is the letter's class and customer. The image model may itself misrender a digit:
 * that is kept on purpose, because the system must then refuse to match on it, exactly as with a
 * smudged real scan. Already rendered images are skipped, so the script resumes after a failure.
 */
import { execFileSync } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { DocumentClass } from '../src/domain/classes.js';
import { loadJsonl } from '../src/dataset.js';
import type { LabelledExample } from '../src/domain/types.js';
import type { ScanEntry } from '../src/evaluation/scans.js';
import { detectSenderType } from '../src/extraction/extract.js';
import { pool } from './synthetic.js';

const { values: args } = parseArgs({
  options: {
    'per-class': { type: 'string', default: '8' },
    quality: { type: 'string', default: 'medium' },
    concurrency: { type: 'string', default: '6' },
    limit: { type: 'string' },
  },
});

const OUT = 'data/scans';
const FAL_SYNC = 'https://fal.run/fal-ai/gpt-image-2';

/** Classes where letters are commonly written by hand by private persons. */
const HANDWRITTEN_CLASSES: ReadonlySet<DocumentClass> = new Set([
  'COMPLAINT',
  'CONTRACT_WITHDRAWAL',
  'CONTRACT_TERMINATION',
  'DEATH_NOTIFICATION',
  'PERSONAL_DATA_CHANGE',
  'POWER_OF_ATTORNEY',
  'CLAIM_NOTIFICATION',
  'CLAIM_DOCUMENTS',
  'GDPR_REQUEST',
  'OTHER',
]);

const STYLE_PROMPT: Readonly<Record<ScanEntry['style'], string>> = {
  typed_scan:
    'a flatbed office scan of a printed A4 letter: slightly grey paper, faint scanner noise, the page a little skewed, a printed letterhead where the text has one, a handwritten signature in blue ink at the end',
  phone_photo:
    'a smartphone photo of a printed A4 letter lying on a wooden desk, shot slightly from an angle, soft shadow of the phone across one corner, the paper folded in thirds and flattened',
  handwritten:
    'a handwritten letter in blue ballpoint pen on lined A4 paper, ordinary adult cursive handwriting that is legible but not perfect, photographed flat under room light',
};

function promptFor(entry: { style: ScanEntry['style']; text: string }): string {
  return `Photorealistic image: ${STYLE_PROMPT[entry.style]}. The page contains exactly the following Polish text, verbatim, line breaks as given, every Polish diacritic, digit and slash exactly as written, nothing added or translated:\n\n${entry.text}`;
}

const words = (t: string): number => t.split(/\s+/).filter(Boolean).length;

function choose(test: readonly LabelledExample[], perClass: number): Omit<ScanEntry, 'file'>[] {
  const byClass = new Map<string, LabelledExample[]>();
  for (const ex of test) {
    const plain = !ex.tags.some((t) =>
      ['injection', 'ocr_noise', 'id_slip', 'hard_case'].includes(t),
    );
    // Long letters do not fit legibly on one rendered page.
    if (!plain || words(ex.text) > 170 || words(ex.text) < 30) continue;
    byClass.set(ex.label, [...(byClass.get(ex.label) ?? []), ex]);
  }
  const out: Omit<ScanEntry, 'file'>[] = [];
  for (const [label, items] of byClass) {
    // Prefer letters about a known customer: they exercise matching under OCR.
    const sorted = [...items].sort(
      (a, b) =>
        Number(b.tags.some((t) => t.startsWith('customer:'))) -
        Number(a.tags.some((t) => t.startsWith('customer:'))),
    );
    sorted.slice(0, perClass).forEach((ex, i) => {
      const canHandwrite =
        HANDWRITTEN_CLASSES.has(ex.label) && detectSenderType(ex.text) === 'INDIVIDUAL';
      const style: ScanEntry['style'] =
        canHandwrite && i % 3 === 0 ? 'handwritten' : i % 3 === 1 ? 'phone_photo' : 'typed_scan';
      out.push({ id: ex.id, label, style, text: ex.text, tags: ex.tags });
    });
  }
  return out;
}

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  );

async function render(prompt: string, key: string, quality: string): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(FAL_SYNC, {
      method: 'POST',
      headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, image_size: { width: 1024, height: 1536 }, quality }),
      signal: AbortSignal.timeout(600_000),
    });
    const body = (await res.json().catch(() => ({}))) as { images?: { url?: string }[] };
    const url = body.images?.[0]?.url;
    if (res.ok && url) {
      const img = await fetch(url);
      return new Uint8Array(await img.arrayBuffer());
    }
    console.error(
      `fal attempt ${String(attempt)} failed: ${res.status} ${JSON.stringify(body).slice(0, 200)}`,
    );
    await new Promise((r) => setTimeout(r, 4000 * attempt));
  }
  throw new Error('fal gpt-image-2 failed three times');
}

async function main(): Promise<void> {
  const key = process.env.FAL_API_KEY;
  if (!key) throw new Error('FAL_API_KEY is required');
  await mkdir(OUT, { recursive: true });
  const test = await loadJsonl('data/dataset/test.jsonl');
  const all = choose(test, Number(args['per-class']));
  const chosen = args.limit ? all.slice(0, Number(args.limit)) : all;
  console.error(`rendering ${String(chosen.length)} letters`);
  let done = 0;
  const entries = await pool(chosen, Number(args.concurrency), async (entry) => {
    const file = `${entry.id}-${entry.style}.jpg`;
    const path = join(OUT, file);
    try {
      if (!(await exists(path))) {
        const png = await render(promptFor(entry), key, args.quality);
        const tmp = `${path}.png`;
        await writeFile(tmp, png);
        // JPEG at q72 keeps the repo small and is what a mailroom scanner produces anyway.
        execFileSync(
          'sips',
          ['-s', 'format', 'jpeg', '-s', 'formatOptions', '72', tmp, '--out', path],
          {
            stdio: 'ignore',
          },
        );
        execFileSync('rm', [tmp]);
      }
      return { ...entry, file } satisfies ScanEntry;
    } catch (error) {
      console.error(`\n${entry.id}: ${String(error)}`);
      return undefined;
    } finally {
      done++;
      process.stderr.write(`\r${String(done)}/${String(chosen.length)}`);
    }
  });
  process.stderr.write('\n');
  const ok = entries.filter((e) => e !== undefined);
  await writeFile(join(OUT, 'manifest.jsonl'), `${ok.map((e) => JSON.stringify(e)).join('\n')}\n`);
  console.log(`${String(ok.length)} images in ${OUT}`);
}

await main();
