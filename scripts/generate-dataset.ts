/**
 * Builds the synthetic corpus and the core-systems fixture.
 *
 *   pnpm dataset:generate                    about 5000 letters (305 per class + hard cases)
 *   pnpm dataset:generate --per-class 30     a quick small corpus
 *
 * Stages, each cached under var/llm-cache so a re-run costs nothing:
 *   1. briefs:   the hand-written scenarios plus ~14 new ones per class and 2 hard cases per class,
 *                written by the generator model from the class definition
 *   2. letters:  5 letters per call, each call with a random "variation card" (sender, register,
 *                format, length, extras), so 60 calls per class do not produce 60 copies of a letter
 *   3. filling:  identifiers come from code, never from the model, so every PESEL and IBAN has a
 *                correct (or deliberately broken) checksum and links to the CRM fixture
 *   4. cleaning: near-duplicates dropped; letters the local model disagrees with are re-read by
 *                the generator model against all class definitions, and dropped if off-class
 *   5. split:    test letters come from briefs never used for training (unseen scenarios), plus
 *                hard cases and injection, OCR-noise and identifier-slip variants of test letters
 *
 * A stand-in for the 1500-3000 real, double-labelled letters the PoC plan calls for.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { LocalClassifier } from '../src/classifier/local-classifier.js';
import {
  CLASS_DEFINITIONS,
  DOCUMENT_CLASSES,
  DocumentClassSchema,
  type DocumentClass,
} from '../src/domain/classes.js';
import type { LabelledExample } from '../src/domain/types.js';
import { CoreSystemsFixtureSchema } from '../src/enrichment/core-systems.js';
import {
  CachedStructuredLlm,
  OpenAiStructuredLlm,
  type StructuredLlm,
} from '../src/llm/structured-llm.js';
import { HARD_CASES, SCENARIOS } from './scenarios.js';
import {
  dropNearDuplicates,
  extendFixture,
  fill,
  identifierSlip,
  INJECTIONS,
  ocrNoise,
  pick,
  pool,
  rnd,
} from './synthetic.js';

const { values: args } = parseArgs({
  options: {
    'per-class': { type: 'string', default: '305' },
    customers: { type: 'string', default: '400' },
    concurrency: { type: 'string', default: '12' },
    /**
     * No paid generation calls: cached OpenAI answers are used, every other batch is exported as a
     * job for Claude subagents (var/claude/jobs), and their letters are imported from
     * var/claude/letters. Same for the label check (var/claude/judge).
     */
    offline: { type: 'boolean', default: false },
  },
});
const PER_CLASS = Number(args['per-class']);
const CUSTOMERS = Number(args.customers);
const GEN_MODEL = process.env.GEN_MODEL ?? 'gpt-5.4-2026-03-05';
const LETTERS_PER_CALL = 5;
const TEST_SHARE = 0.25;
const OUT_DIR = 'data/dataset';

const SYSTEM = `Generujesz realistyczne, różnorodne polskie pisma przychodzące do firmy "Vistula Towarzystwo Ubezpieczeń S.A." (ul. Marszałkowska 100, 00-026 Warszawa), która prowadzi też działalność bankową (Vistula Bank).
Zasady:
- Każde pismo w odpowiedzi ma inny układ, słownictwo, długość i nadawcę. Nie powtarzaj szablonu między pismami.
- NIE wymyślaj numerów PESEL, rachunków, polis, szkód ani sygnatur. Używaj DOKŁADNIE tych placeholderów, gdy są potrzebne: {OSOBA}, {PESEL}, {POLISA}, {SZKODA}, {IBAN}, {SYGN_KM}, {SYGN_SAD}, {DATA}, {ADRES}.
- Pismo musi jednoznacznie należeć do opisanej kategorii, nawet jeśli wspomina inne sprawy.
- Nie dodawaj komentarzy ani nagłówków typu "Pismo 1". Zwróć tylko treść pism.`;

const LettersSchema = z.object({
  letters: z.array(z.object({ text: z.string().describe('Pełna treść pisma z placeholderami.') })),
});

const BriefsSchema = z.object({
  briefs: z.array(z.string()).describe('Nowe, różnorodne opisy scenariuszy pism tej kategorii.'),
  hardCases: z
    .array(z.string())
    .describe(
      'Scenariusze tej kategorii celowo mylące: słowa kluczowe innej kategorii, ale treść jednoznacznie tej.',
    ),
});

const JudgeSchema = z.object({
  reasoning: z.string(),
  label: z.union([DocumentClassSchema, z.literal('AMBIGUOUS')]),
});

// ---------- variation cards ----------
const SENDERS = [
  'osoba starsza, pisze prosto i trochę chaotycznie',
  'młoda osoba, krótko i konkretnie, mailowo',
  'profesjonalny pełnomocnik lub kancelaria, język prawniczy',
  'urzędnik instytucji publicznej, formalnie, z podstawą prawną',
  'przedsiębiorca lub księgowa firmy, rzeczowo',
  'zdenerwowana osoba, emocjonalnie, z wykrzyknikami',
  'członek rodziny piszący w czyimś imieniu',
  'osoba słabo znająca procedury, opisuje sprawę okrężnie',
];
const FORMATS = [
  'klasyczny list papierowy z miejscowością, datą, adresatem i podpisem',
  'e-mail z tematem i stopką',
  'formularz lub druk z polami do wypełnienia (pole: wartość)',
  'pismo urzędowe z nagłówkiem instytucji, sygnaturą i pouczeniem',
  'krótka notatka, prawie bez formatowania',
  'pismo z wypunktowaniem lub tabelką',
];
const LENGTHS = ['krótkie: 40-90 słów', 'średnie: 90-200 słów', 'długie: 200-350 słów'];
const EXTRAS = [
  'lista załączników na końcu',
  'odwołanie do wcześniejszej korespondencji lub rozmowy telefonicznej',
  'poboczny wątek, który nie zmienia kategorii pisma',
  'kilka literówek i błędów interpunkcyjnych',
  'prośba o pilną odpowiedź z podanym terminem',
  'brak dodatków',
  'brak dodatków',
];
const card = (): string =>
  `Wariant stylu dla tej partii (każde pismo może go interpretować po swojemu): nadawca: ${pick(SENDERS)}; forma: ${pick(FORMATS)}; długość: ${pick(LENGTHS)}; dodatek: ${pick(EXTRAS)}. Jeśli opis wskazuje instytucję (komornik, sąd, urząd, prokuratura, regulator), zachowaj jej urzędowy charakter i zastosuj wariant tylko do formy, długości i dodatków.`;

interface Job {
  readonly label: DocumentClass;
  readonly brief: string;
  readonly split: 'train' | 'test';
  readonly tag: string;
  readonly card: string;
}

class NotCachedError extends Error {}

/** Stands in for the provider in offline mode: a cache miss becomes a job for Claude. */
const offlineProvider: StructuredLlm = {
  parse: () => Promise.reject(new NotCachedError('not cached')),
};

const CLAUDE_DIR = 'var/claude';

const ClaudeVerdictSchema = z.object({
  id: z.string(),
  label: z.union([DocumentClassSchema, z.literal('AMBIGUOUS')]),
});

async function readJsonlDir<T>(dir: string, schema: z.ZodType<T>): Promise<T[]> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const out: T[] = [];
  for (const f of files.filter((x) => x.endsWith('.jsonl')).sort()) {
    const lines = (await readFile(join(dir, f), 'utf8')).split('\n').filter((l) => l.trim());
    for (const [i, line] of lines.entries()) {
      try {
        out.push(schema.parse(JSON.parse(line)));
      } catch (error) {
        console.error(`${dir}/${f}:${String(i + 1)} skipped: ${String(error).slice(0, 120)}`);
      }
    }
  }
  return out;
}

/**
 * Claude subagents write plain text, which survives quoting far better than hand-written JSON:
 *
 *   ### JOB 123
 *   first letter...
 *   -----
 *   second letter...
 */
async function readClaudeLetters(dir: string): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  const files = await readdir(dir).catch(() => [] as string[]);
  for (const f of files.filter((x) => x.endsWith('.txt')).sort()) {
    const raw = (await readFile(join(dir, f), 'utf8')).replace(/\r\n/g, '\n');
    for (const block of raw.split(/^### JOB (?=\d+\s*$)/m).slice(1)) {
      const [head = '', ...rest] = block.split('\n');
      const letters = rest
        .join('\n')
        .split(/^-{5,}\s*$/m)
        .map((l) => l.trim())
        .filter((l) => l.split(/\s+/).length >= 15);
      if (letters.length) out.set(Number(head.trim()), letters);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  const offline = args.offline;
  if (!apiKey && !offline) throw new Error('OPENAI_API_KEY is required (or pass --offline)');
  const llm = new CachedStructuredLlm(
    offline || !apiKey ? offlineProvider : new OpenAiStructuredLlm(apiKey, GEN_MODEL, 300_000),
    'var/llm-cache',
    GEN_MODEL,
  );
  const concurrency = Number(args.concurrency);

  // ---------- fixture ----------
  const base = CoreSystemsFixtureSchema.parse(
    JSON.parse(await readFile('data/crm-base.json', 'utf8')) as unknown,
  );
  const fixture = extendFixture(base, CUSTOMERS);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile('data/crm.json', `${JSON.stringify(fixture, null, 2)}\n`);

  // ---------- 1. briefs ----------
  console.error('stage 1: briefs');
  const briefSets = await pool(DOCUMENT_CLASSES, concurrency, async (label) => {
    const def = CLASS_DEFINITIONS[label];
    const result = await llm.parse({
      name: 'scenario_briefs',
      promptVersion: 'briefs-v1',
      schema: BriefsSchema,
      system: SYSTEM,
      user: [
        {
          type: 'input_text',
          text: `Kategoria: ${label} (${def.label}). Definicja: ${def.definition}\n\nIstniejące scenariusze:\n${SCENARIOS[label].map((s) => `- ${s}`).join('\n')}\n\nNapisz 14 NOWYCH scenariuszy tej kategorii, wyraźnie różnych od istniejących i od siebie: inni nadawcy, sytuacje, produkty (polisa komunikacyjna, majątkowa, na życie, rachunek bankowy), stopień formalności, przypadki brzegowe. Każdy scenariusz to 1-2 zdania z placeholderami. Do tego 2 scenariusze "trudne": z mylącymi słowami kluczowymi innej kategorii, ale treścią jednoznacznie tej kategorii.`,
        },
      ],
    });
    return { label, briefs: result.data.briefs, hardCases: result.data.hardCases };
  });
  await writeFile('data/briefs.json', `${JSON.stringify(briefSets, null, 2)}\n`);

  // ---------- 2. letters ----------
  const jobs: Job[] = [];
  for (const { label, briefs } of briefSets) {
    const all = [...SCENARIOS[label], ...briefs];
    const testCount = Math.max(1, Math.round(all.length * TEST_SHARE));
    // The last hand-written scenario and the last generated ones never appear in training.
    const testBriefs = new Set([SCENARIOS[label].at(-1) ?? '', ...briefs.slice(-(testCount - 1))]);
    const trainBriefs = all.filter((b) => !testBriefs.has(b));
    const testList = all.filter((b) => testBriefs.has(b));
    const testCalls = Math.ceil((PER_CLASS * TEST_SHARE) / LETTERS_PER_CALL);
    const trainCalls = Math.ceil((PER_CLASS * (1 - TEST_SHARE)) / LETTERS_PER_CALL);
    for (let i = 0; i < trainCalls; i++) {
      const brief = trainBriefs[i % trainBriefs.length] ?? '';
      jobs.push({
        label,
        brief,
        split: 'train',
        tag: `brief:${String(all.indexOf(brief))}`,
        card: card(),
      });
    }
    for (let i = 0; i < testCalls; i++) {
      const brief = testList[i % testList.length] ?? '';
      jobs.push({
        label,
        brief,
        split: 'test',
        tag: `brief:${String(all.indexOf(brief))}`,
        card: card(),
      });
    }
  }
  for (const { label, hardCases } of briefSets)
    for (const brief of hardCases)
      jobs.push({ label, brief, split: 'test', tag: 'hard_case', card: card() });
  for (const hc of HARD_CASES)
    jobs.push({ label: hc.label, brief: hc.brief, split: 'test', tag: 'hard_case', card: card() });

  console.error(`stage 2: ${String(jobs.length)} generation calls`);
  const fromClaude = await readClaudeLetters(join(CLAUDE_DIR, 'letters'));
  const pending: number[] = [];
  let done = 0;
  const batches = await pool(jobs, concurrency, async (job, index) => {
    const n = job.tag === 'hard_case' ? 3 : LETTERS_PER_CALL;
    const claude = fromClaude.get(index);
    if (claude) return { job, letters: claude.map((text) => ({ text })), source: 'claude' };
    try {
      const result = await llm.parse({
        name: 'synthetic_letters',
        promptVersion: 'gen-v2',
        schema: LettersSchema,
        system: SYSTEM,
        user: [
          {
            type: 'input_text',
            text: `Napisz ${String(n)} różne pisma kategorii ${job.label} (${CLASS_DEFINITIONS[job.label].label}) według opisu:\n${job.brief}\n\n${job.card}`,
          },
        ],
      });
      return { job, letters: result.data.letters, source: 'gpt-5.4' };
    } catch (error) {
      if (error instanceof NotCachedError) pending.push(index);
      else console.error(`\ngeneration failed for ${job.label}: ${String(error)}`);
      return { job, letters: [], source: 'none' };
    } finally {
      done++;
      if (done % 20 === 0 || done === jobs.length)
        process.stderr.write(`\r${String(done)}/${String(jobs.length)} calls`);
    }
  });
  process.stderr.write('\n');

  if (pending.length) {
    // Hand the missing batches to Claude, one file per class, and stop: the corpus is built on
    // the next run, once the letters are in var/claude/letters.
    await mkdir(join(CLAUDE_DIR, 'jobs'), { recursive: true });
    for (const label of DOCUMENT_CLASSES) {
      const mine = pending
        .filter((i) => jobs[i]?.label === label)
        .map((i) => {
          const job = jobs[i];
          if (!job) throw new Error(`job ${String(i)} missing`);
          return {
            job: i,
            split: job.split,
            letters: job.tag === 'hard_case' ? 3 : LETTERS_PER_CALL,
            brief: job.brief,
            style: job.card,
          };
        });
      if (!mine.length) continue;
      const def = CLASS_DEFINITIONS[label];
      await writeFile(
        join(CLAUDE_DIR, 'jobs', `${label}.json`),
        `${JSON.stringify({ label, name: def.label, definition: def.definition, system: SYSTEM, jobs: mine }, null, 2)}\n`,
      );
    }
    const fromCache = jobs.length - pending.length - fromClaude.size;
    console.log(
      `${String(pending.length)} batches exported to ${CLAUDE_DIR}/jobs (${String(fromCache)} from cache, ${String(fromClaude.size)} from Claude). Write the letters to ${CLAUDE_DIR}/letters and run again.`,
    );
    return;
  }

  // ---------- 3. filling ----------
  let n = 0;
  const generated = batches.flatMap(({ job, letters, source }) =>
    letters.map((l) => {
      const { text, tags } = fill(l.text, fixture);
      return {
        split: job.split,
        example: {
          id: `${job.label.toLowerCase()}-${String(++n).padStart(5, '0')}`,
          label: job.label,
          text,
          tags: [job.tag, `author:${source}`, ...tags],
        } satisfies LabelledExample,
      };
    }),
  );

  // ---------- 4. cleaning ----------
  const { kept, dropped } = dropNearDuplicates(generated.map((g) => g.example));
  const keptIds = new Set(kept.map((k) => k.id));
  const unique = generated.filter((g) => keptIds.has(g.example.id));
  console.error(`stage 4: ${String(dropped)} near-duplicates dropped`);

  // Letters the local model disagrees with (out of fold) get a second opinion from the generator
  // model against every class definition. Only those are judged, so the test set is not filtered
  // by agreement with the LLM that later competes on it.
  const folds = 4;
  const suspects: LabelledExample[] = [];
  for (let k = 0; k < folds; k++) {
    const trainFold = unique.filter((_, i) => i % folds !== k).map((g) => g.example);
    const model = LocalClassifier.train(trainFold, { folds: 2 });
    unique
      .filter((_, i) => i % folds === k)
      .forEach((g) => {
        if (model.predict(g.example.text).label !== g.example.label) suspects.push(g.example);
      });
    process.stderr.write(`\rcleaning fold ${String(k + 1)}/${String(folds)}`);
  }
  process.stderr.write('\n');
  const definitions = DOCUMENT_CLASSES.map((c) => `${c}: ${CLASS_DEFINITIONS[c].definition}`).join(
    '\n',
  );
  const claudeVerdicts = new Map(
    (await readJsonlDir(join(CLAUDE_DIR, 'judge'), ClaudeVerdictSchema)).map((v) => [
      v.id,
      v.label,
    ]),
  );
  const unjudged: LabelledExample[] = [];
  const judged = await pool(suspects, concurrency, async (ex) => {
    const fromClaudeVerdict = claudeVerdicts.get(ex.id);
    if (fromClaudeVerdict) return { id: ex.id, intended: ex.label, judged: fromClaudeVerdict };
    try {
      return await judge(ex);
    } catch (error) {
      if (!(error instanceof NotCachedError)) throw error;
      unjudged.push(ex);
      return undefined;
    }
  });
  if (unjudged.length) {
    await mkdir(join(CLAUDE_DIR, 'judge-input'), { recursive: true });
    await writeFile(
      join(CLAUDE_DIR, 'judge-input', 'suspects.json'),
      `${JSON.stringify({ definitions, letters: unjudged.map((u) => ({ id: u.id, text: u.text })) }, null, 2)}\n`,
    );
    console.log(
      `${String(unjudged.length)} letters need a label check: ${CLAUDE_DIR}/judge-input/suspects.json. Write verdicts to ${CLAUDE_DIR}/judge and run again.`,
    );
    return;
  }
  const verdicts = judged.filter((v) => v !== undefined);
  async function judge(ex: LabelledExample) {
    const r = await llm.parse({
      name: 'label_judge',
      promptVersion: 'judge-v1',
      schema: JudgeSchema,
      system: `Jesteś starszym pracownikiem kancelarii przyjmującej korespondencję. Przypisz pismu jedną kategorię z listy albo AMBIGUOUS, jeśli pismo pasuje równie dobrze do dwóch. Kategorie:\n${definitions}`,
      user: [{ type: 'input_text', text: ex.text }],
    });
    return { id: ex.id, intended: ex.label, judged: r.data.label };
  }
  const offClass = new Set(verdicts.filter((v) => v.judged !== v.intended).map((v) => v.id));
  const clean = unique.filter((g) => !offClass.has(g.example.id));
  console.error(
    `stage 4: ${String(suspects.length)} letters re-read, ${String(offClass.size)} dropped as off-class or ambiguous`,
  );

  // ---------- 5. split and augment ----------
  const train = clean.filter((g) => g.split === 'train').map((g) => g.example);
  const test = clean.filter((g) => g.split === 'test').map((g) => g.example);
  const baseTest = test.filter((e) => e.label !== 'OTHER' && !e.tags.includes('hard_case'));
  const variants: LabelledExample[] = [];
  for (let i = 0; i < 40; i++) {
    const src = pick(baseTest);
    variants.push({
      ...src,
      id: `${src.id}-inj${String(i)}`,
      text: src.text + pick(INJECTIONS),
      tags: [...src.tags, 'injection'],
    });
  }
  for (let i = 0; i < 40; i++) {
    const src = pick(baseTest);
    variants.push({
      ...src,
      id: `${src.id}-ocr${String(i)}`,
      text: ocrNoise(src.text),
      tags: [...src.tags, 'ocr_noise'],
    });
  }
  const slips = baseTest
    .filter(() => rnd() < 0.5)
    .map((e) => identifierSlip(e, fixture))
    .filter((e) => e !== undefined)
    .slice(0, 40);
  test.push(...variants, ...slips);

  const toJsonl = (xs: readonly LabelledExample[]): string =>
    `${xs.map((x) => JSON.stringify(x)).join('\n')}\n`;
  await writeFile(join(OUT_DIR, 'train.jsonl'), toJsonl(train));
  await writeFile(join(OUT_DIR, 'test.jsonl'), toJsonl(test));
  const report = {
    generatedAt: new Date().toISOString(),
    model: GEN_MODEL,
    calls: jobs.length,
    lettersGenerated: generated.length,
    nearDuplicatesDropped: dropped,
    reRead: suspects.length,
    droppedOffClass: offClass.size,
    offClassExamples: verdicts.filter((v) => v.judged !== v.intended).slice(0, 30),
    train: train.length,
    test: test.length,
    testVariants: { injection: 40, ocrNoise: 40, identifierSlip: slips.length },
    customers: fixture.customers.length,
  };
  await writeFile(join(OUT_DIR, 'generation-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

await main();
