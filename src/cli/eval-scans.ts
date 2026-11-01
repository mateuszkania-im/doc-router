/**
 * Evaluation on rendered images (data/scans, built by `pnpm scans:generate`): the whole pipeline
 * from pixels, with the real OCR, the second read and handwriting handling.
 *
 *   pnpm eval:scans
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalClassifier } from '../classifier/local-classifier.js';
import { loadConfig } from '../config.js';
import { createLlm } from '../container.js';
import { loadJsonl } from '../dataset.js';
import { InMemoryCoreSystems } from '../enrichment/core-systems.js';
import { enrich } from '../enrichment/enrich.js';
import { summarize, type EvalRecord } from '../evaluation/metrics.js';
import { ScanEntrySchema, type ScanEntry } from '../evaluation/scans.js';
import { extract, extractIdentifiers } from '../extraction/extract.js';
import { LlmVisionOcr, SecondReadOcr, type OcrProvider } from '../ingest/ocr.js';
import { extractDocumentText } from '../ingest/text-extraction.js';
import { runCascade } from '../pipeline/cascade.js';
import { calibrateRules } from '../pipeline/rules.js';
import { QUEUES, route } from '../routing/route.js';
import { DocumentClassSchema } from '../domain/classes.js';

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const RECEIVED_AT = new Date('2026-10-30T09:00:00Z');
const READ_SENSITIVE = new Set([
  'PESEL',
  'NIP',
  'IBAN',
  'POLICY_NUMBER',
  'CLAIM_NUMBER',
  'COMPLAINT_NUMBER',
]);

interface ScanResult {
  readonly entry: ScanEntry;
  readonly record: EvalRecord;
  readonly handwrittenFlag: boolean;
  readonly idsIntended: number;
  readonly idsReadExactly: number;
  readonly idsUnverified: number;
  readonly quality: number;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const manifest = (await readFile('data/scans/manifest.jsonl', 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => ScanEntrySchema.parse(JSON.parse(l)));
  const [train, systems] = await Promise.all([
    loadJsonl(join(config.DATASET_DIR, 'train.jsonl')),
    InMemoryCoreSystems.fromFile(config.CRM_FIXTURE_PATH),
  ]);
  const classifier = LocalClassifier.train(train);
  const llm = createLlm(config, config.LLM_MODEL, true);
  const ocrLlm = createLlm(config, config.OCR_MODEL, true);
  const verifier = config.OCR_SECOND_READ_MODEL
    ? createLlm(config, config.OCR_SECOND_READ_MODEL, true)
    : undefined;
  if (!llm || !ocrLlm) throw new Error('eval:scans needs OPENAI_API_KEY: OCR is the point of it');
  let ocr: OcrProvider = new LlmVisionOcr(ocrLlm);
  if (verifier) ocr = new SecondReadOcr(ocr, verifier);

  const results: ScanResult[] = [];
  for (const [i, entry] of manifest.entries()) {
    process.stderr.write(`\r${String(i + 1)}/${String(manifest.length)}`);
    const started = performance.now();
    const content = new Uint8Array(await readFile(join('data/scans', entry.file)));
    const text = await extractDocumentText(content, 'image/jpeg', ocr);
    const { classification, llmUsage } = await runCascade(
      { text, channel: 'PAPER_SCAN' },
      {
        localClassifier: classifier,
        llm,
        llmMinConfidence: config.LLM_MIN_CONFIDENCE,
        ocrQualityFloor: config.OCR_QUALITY_FLOOR,
        rulePolicy: calibrateRules(train).policy,
      },
    );
    const extraction = extract(text.text, {
      ...(text.handwritten ? { handwritten: true } : {}),
      ...(text.secondRead ? { secondRead: text.secondRead } : {}),
    });
    const enrichment = await enrich(systems, extraction.identifiers, text.text);
    const routing = route(classification, extraction, enrichment, RECEIVED_AT);
    const intended = extractIdentifiers(entry.text).filter((x) => READ_SENSITIVE.has(x.kind));
    const read = new Set(extraction.identifiers.map((x) => `${x.kind}:${x.value}`));
    results.push({
      entry,
      handwrittenFlag: text.handwritten ?? false,
      idsIntended: intended.length,
      idsReadExactly: intended.filter((x) => read.has(`${x.kind}:${x.value}`)).length,
      idsUnverified: extraction.identifiers.filter(
        (x) =>
          x.uncertain === 'unconfirmed_by_second_read' || x.uncertain === 'handwritten_single_read',
      ).length,
      quality: text.quality,
      record: {
        id: entry.id,
        truth: DocumentClassSchema.parse(entry.label),
        autoLabel: routing.requiresHumanReview ? null : classification.label,
        suggestedLabel: classification.suggestedLabel,
        queue: routing.queue,
        tags: [...entry.tags, `style:${entry.style}`],
        decidedBy: routing.requiresHumanReview ? null : classification.decidedBy,
        processingMs: performance.now() - started,
        llmTokens: llmUsage ? llmUsage.inputTokens + llmUsage.outputTokens : 0,
        truthCustomer: entry.tags.find((t) => t.startsWith('customer:'))?.slice(9) ?? null,
        customer: enrichment.customer?.customerId ?? null,
      },
    });
  }
  process.stderr.write('\n');

  const lines = [
    '# Evaluation on rendered scans',
    '',
    `${String(results.length)} test letters rendered as images with gpt-image-2 (typed scans, phone photos, handwriting), read by ${config.OCR_MODEL} with a second read by ${config.OCR_SECOND_READ_MODEL ?? 'nobody'}, then the full cascade (rules, TF-IDF, ${config.LLM_MODEL}). Identifiers "read exactly" compares what came out of the pipeline with the text the image was rendered from; the image model itself sometimes misrenders a digit, which counts against this number and is exactly the case the matching must survive.`,
    '',
    '| Style | n | Suggestion accuracy | Coverage (no human) | Precision of auto-routed | Critical lost | Wrong customer, auto-routed | Handwriting flagged | Identifiers read exactly | Identifiers held back as unverified |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  const row = (name: string, subset: readonly ScanResult[]): string => {
    const s = summarize(
      subset.map((r) => r.record),
      QUEUES.CRITICAL_REVIEW,
    );
    const intended = subset.reduce((a, r) => a + r.idsIntended, 0);
    const exact = subset.reduce((a, r) => a + r.idsReadExactly, 0);
    const unverified = subset.reduce((a, r) => a + r.idsUnverified, 0);
    const flagged = subset.filter((r) => r.handwrittenFlag).length;
    return `| ${name} | ${String(subset.length)} | ${pct(s.suggestionAccuracy)} | ${pct(s.coverage)} | ${pct(s.autoPrecision)} | ${String(s.criticalLost)} / ${String(s.criticalDocuments)} | ${String(s.wrongCustomerAuto)} | ${String(flagged)} / ${String(subset.length)} | ${String(exact)} / ${String(intended)} | ${String(unverified)} |`;
  };
  for (const style of ['typed_scan', 'phone_photo', 'handwritten'] as const)
    lines.push(
      row(
        style,
        results.filter((r) => r.entry.style === style),
      ),
    );
  lines.push(row('**all**', results), '');
  const lost = summarize(
    results.map((r) => r.record),
    QUEUES.CRITICAL_REVIEW,
  );
  if (lost.criticalLostIds.length)
    lines.push(`Critical letters lost: ${lost.criticalLostIds.join(', ')}.`, '');
  if (lost.wrongCustomerAutoIds.length)
    lines.push(`Auto-routed with the wrong customer: ${lost.wrongCustomerAutoIds.join(', ')}.`, '');

  const report = `${lines.join('\n')}\n`;
  await writeFile('reports/latest-scans.md', report);
  console.log(report);
}

await main();
