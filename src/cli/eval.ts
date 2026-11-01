/**
 * Offline evaluation on the held-out test split.
 *
 *   pnpm eval                 rules, rules+local, full cascade (LLM if a key is set)
 *   pnpm eval --llm-baseline  also LLM zero-shot on every document, for comparison
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { EmbeddingClassifier, TransformersEmbedder } from '../classifier/embedding-classifier.js';
import { LocalClassifier, type Prediction } from '../classifier/local-classifier.js';
import { shuffle } from '../classifier/softmax.js';
import { mapConcurrent } from '../concurrency.js';
import { loadConfig } from '../config.js';
import { createLlm } from '../container.js';
import { loadJsonl } from '../dataset.js';
import { CLASS_DEFINITIONS } from '../domain/classes.js';
import type { Classification, LabelledExample } from '../domain/types.js';
import {
  CoreSystemsFixtureSchema,
  InMemoryCoreSystems,
  type CoreSystems,
} from '../enrichment/core-systems.js';
import { enrich } from '../enrichment/enrich.js';
import {
  perClassMetrics,
  riskCoverage,
  ruleOfThree,
  summarize,
  wilsonLower,
  type EvalRecord,
  type Summary,
} from '../evaluation/metrics.js';
import { costPerThousand, type CostLine } from '../evaluation/cost.js';
import { buildIdentitySuite, type IdentityCaseKind } from '../evaluation/identity-cases.js';
import { extract } from '../extraction/extract.js';
import { textQuality } from '../ingest/text-extraction.js';
import { classifyWithLlm, evidenceIsGrounded } from '../llm/llm-classifier.js';
import type { StructuredLlm } from '../llm/structured-llm.js';
import { runCascade, type CascadeDeps } from '../pipeline/cascade.js';
import { calibrateRules } from '../pipeline/rules.js';
import { QUEUES, route } from '../routing/route.js';

const { values: args } = parseArgs({
  options: { 'llm-baseline': { type: 'boolean', default: false } },
});

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const truthCustomerOf = (ex: LabelledExample): string | null =>
  ex.tags.find((t) => t.startsWith('customer:'))?.slice('customer:'.length) ?? null;
const RECEIVED_AT = new Date('2026-10-30T09:00:00Z');
const EVAL_CONCURRENCY = 8;

async function evaluate(
  examples: readonly LabelledExample[],
  deps: CascadeDeps,
  systems: CoreSystems,
): Promise<EvalRecord[]> {
  // A few letters in flight: an LLM stage at 1-2 s per call would make a 1000-letter run crawl.
  return mapConcurrent(examples, EVAL_CONCURRENCY, async (ex): Promise<EvalRecord> => {
    const started = performance.now();
    const text = {
      text: ex.text,
      source: 'plain' as const,
      quality: textQuality(ex.text),
      pageCount: 1,
    };
    const { classification, llmUsage } = await runCascade({ text, channel: 'PAPER_SCAN' }, deps);
    const extraction = extract(ex.text);
    const enrichment = await enrich(systems, extraction.identifiers, ex.text);
    const routing = route(classification, extraction, enrichment, RECEIVED_AT);
    return {
      truthCustomer: truthCustomerOf(ex),
      customer: enrichment.customer?.customerId ?? null,
      llmInputTokens: llmUsage?.inputTokens ?? 0,
      llmOutputTokens: llmUsage?.outputTokens ?? 0,
      id: ex.id,
      truth: ex.label,
      autoLabel: routing.requiresHumanReview ? null : classification.label,
      suggestedLabel: classification.suggestedLabel,
      queue: routing.queue,
      tags: ex.tags,
      decidedBy: routing.requiresHumanReview ? null : classification.decidedBy,
      processingMs: performance.now() - started,
      llmTokens: llmUsage ? llmUsage.inputTokens + llmUsage.outputTokens : 0,
    };
  });
}

/**
 * The alternative design: one LLM call per letter, no rules, no local model. Measured twice:
 * the raw suggestion accuracy, and as a router with the same acceptance gates the cascade uses
 * (grounded quote, confidence, not OTHER), so coverage and safety compare like with like.
 */
async function llmOnly(
  llm: StructuredLlm,
  examples: readonly LabelledExample[],
  systems: CoreSystems,
  minConfidence: number,
): Promise<EvalRecord[]> {
  return mapConcurrent(examples, EVAL_CONCURRENCY, async (ex): Promise<EvalRecord> => {
    const started = performance.now();
    const { verdict, usage } = await classifyWithLlm(llm, ex.text);
    const accepted =
      verdict.label !== 'OTHER' &&
      verdict.confidence >= minConfidence &&
      evidenceIsGrounded(verdict.evidence, ex.text);
    const classification: Classification = {
      label: accepted ? verdict.label : null,
      decidedBy: accepted ? 'llm' : null,
      confidence: verdict.confidence,
      suggestedLabel: verdict.label,
      safetyNet: [],
      reviewReasons: accepted ? [] : ['cascade_abstained'],
      trace: [],
    };
    const extraction = extract(ex.text);
    const enrichment = await enrich(systems, extraction.identifiers, ex.text);
    const routing = route(classification, extraction, enrichment, RECEIVED_AT);
    return {
      id: ex.id,
      truth: ex.label,
      autoLabel: routing.requiresHumanReview ? null : classification.label,
      suggestedLabel: verdict.label,
      queue: routing.queue,
      tags: ex.tags,
      decidedBy: routing.requiresHumanReview ? null : 'llm',
      processingMs: performance.now() - started,
      llmTokens: usage.inputTokens + usage.outputTokens,
      llmInputTokens: usage.inputTokens,
      llmOutputTokens: usage.outputTokens,
      truthCustomer: truthCustomerOf(ex),
      customer: enrichment.customer?.customerId ?? null,
    };
  });
}

function summaryRow(name: string, s: Summary): string {
  return `| ${name} | ${pct(s.suggestionAccuracy)} | ${s.macroF1.toFixed(3)} | ${pct(s.coverage)} | ${pct(s.autoPrecision)} | ${String(s.criticalLost)} / ${String(s.criticalDocuments)} | ${String(s.wrongCustomerAuto)} / ${String(s.customerKnown)} | ${String(s.injectionAutoRoutedWrong)} / ${String(s.injectionDocuments)} | ${s.p95ProcessingMs.toFixed(1)} | ${String(s.llmTokens)} |`;
}

/**
 * How much data does each stage-2 model need? Both models are trained on growing stratified
 * samples of the training split and scored on the plain test letters, local model alone.
 */
async function learningCurve(
  train: readonly LabelledExample[],
  test: readonly LabelledExample[],
  embedder: TransformersEmbedder,
): Promise<string[]> {
  const plain = test.filter(
    (e) => !e.tags.some((t) => ['injection', 'ocr_noise', 'id_slip'].includes(t)),
  );
  const byClass = new Map<string, LabelledExample[]>();
  for (const e of shuffle(train, 7)) byClass.set(e.label, [...(byClass.get(e.label) ?? []), e]);
  const sample = (perClass: number): LabelledExample[] =>
    [...byClass.values()].flatMap((xs) => xs.slice(0, perClass));
  const maxPerClass = Math.max(...[...byClass.values()].map((xs) => xs.length));
  const sizes = [15, 30, 60, 120, maxPerClass].filter(
    (n, i, a) => n <= maxPerClass && a.indexOf(n) === i,
  );
  const lines = [
    '## Learning curve: TF-IDF versus multilingual-e5, local model alone',
    '',
    `Trained on stratified samples of the training split, scored on the ${String(plain.length)} plain test letters (unseen scenarios and hard cases). Coverage and precision use each model's own calibrated per-class thresholds.`,
    '',
    '| Training letters | TF-IDF accuracy | TF-IDF coverage | TF-IDF auto precision | e5 accuracy | e5 coverage | e5 auto precision |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const perClass of sizes) {
    const subset = sample(perClass);
    process.stderr.write(`learning curve: ${String(subset.length)} letters\n`);
    const tfidf = LocalClassifier.train(subset);
    const e5 = await EmbeddingClassifier.train(subset, embedder);
    const score = async (predict: (t: string) => Promise<Prediction> | Prediction) => {
      let correct = 0;
      let accepted = 0;
      let acceptedCorrect = 0;
      for (const ex of plain) {
        const p = await predict(ex.text);
        if (p.label === ex.label) correct++;
        if (p.accepted) {
          accepted++;
          if (p.label === ex.label) acceptedCorrect++;
        }
      }
      return `${pct(correct / plain.length)} | ${pct(accepted / plain.length)} | ${pct(acceptedCorrect / Math.max(accepted, 1))}`;
    };
    lines.push(
      `| ${String(subset.length)} | ${await score((t) => tfidf.predict(t))} | ${await score((t) => e5.predict(t))} |`,
    );
  }
  lines.push('');
  return lines;
}

/** Customer matching under OCR damage: exact matching as before versus the hybrid resolver. */
async function identityReport(fixturePath: string): Promise<string[]> {
  const raw: unknown = JSON.parse(await readFile(fixturePath, 'utf8'));
  const { fixture, cases } = buildIdentitySuite(CoreSystemsFixtureSchema.parse(raw));
  const systems = new InMemoryCoreSystems(fixture);
  const terminate: Classification = {
    label: 'CONTRACT_TERMINATION',
    decidedBy: 'local_model',
    confidence: 0.99,
    suggestedLabel: 'CONTRACT_TERMINATION',
    safetyNet: [],
    reviewReasons: [],
    trace: [],
  };
  type Row = {
    exactRight: number;
    exactWrong: number;
    autoRight: number;
    autoWrong: number;
    review: number;
    suggestedFirst: number;
    n: number;
  };
  const rows = new Map<IdentityCaseKind, Row>();
  for (const c of cases) {
    const extraction = extract(c.text);
    const enrichment = await enrich(systems, extraction.identifiers, c.text);
    const routing = route(terminate, extraction, enrichment, RECEIVED_AT);
    const attached = enrichment.customer?.customerId;
    const row = rows.get(c.kind) ?? {
      exactRight: 0,
      exactWrong: 0,
      autoRight: 0,
      autoWrong: 0,
      review: 0,
      suggestedFirst: 0,
      n: 0,
    };
    row.n++;
    // "Exact" is what the previous version did: first exact hit wins, no confirmation asked.
    if (attached === c.truth) row.exactRight++;
    else if (attached) row.exactWrong++;
    if (routing.requiresHumanReview) {
      row.review++;
      if (enrichment.candidates?.[0]?.customerId === c.truth) row.suggestedFirst++;
    } else if (attached === c.truth) row.autoRight++;
    else row.autoWrong++;
    rows.set(c.kind, row);
  }
  const lines = [
    '## Customer matching under OCR damage',
    '',
    `${String(cases.length)} letters generated by code from the CRM fixture, each customer given a neighbouring policy number one OCR confusion away that belongs to someone else (policy numbers are sequential, so this is the realistic case). "Exact" is first-exact-hit matching as in the previous version; "hybrid" accepts a match only when a checksummed identifier, a second reference or the customer's name confirms it.`,
    '',
    '| Case | n | Exact: right customer | Exact: wrong customer | Hybrid: auto, right | Hybrid: auto, wrong | Hybrid: to a person | ...with the right customer suggested first |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const [kind, r] of rows)
    lines.push(
      `| ${kind} | ${String(r.n)} | ${String(r.exactRight)} | ${String(r.exactWrong)} | ${String(r.autoRight)} | ${String(r.autoWrong)} | ${String(r.review)} | ${String(r.suggestedFirst)} |`,
    );
  lines.push('');
  return lines;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const [train, test, systems] = await Promise.all([
    loadJsonl(join(config.DATASET_DIR, 'train.jsonl')),
    loadJsonl(join(config.DATASET_DIR, 'test.jsonl')),
    InMemoryCoreSystems.fromFile(config.CRM_FIXTURE_PATH),
  ]);
  const t0 = performance.now();
  const classifier = LocalClassifier.train(train);
  const trainMs = performance.now() - t0;
  console.error('training: embeddings model (multilingual-e5-small)');
  const t1 = performance.now();
  const embedder = new TransformersEmbedder(config.EMBEDDING_MODEL, config.HF_CACHE_DIR);
  const embeddings = await EmbeddingClassifier.train(train, embedder);
  const embeddingTrainMs = performance.now() - t1;
  const llm = createLlm(config, config.LLM_MODEL, true);
  const rules = calibrateRules(train);
  const base = {
    llmMinConfidence: config.LLM_MIN_CONFIDENCE,
    ocrQualityFloor: config.OCR_QUALITY_FLOOR,
    rulePolicy: rules.policy,
  };

  const modes: [string, CascadeDeps][] = [
    ['rules only', base],
    ['rules + embeddings (e5)', { ...base, localClassifier: embeddings }],
  ];
  if (llm)
    modes.push(['full cascade, embeddings (e5)', { ...base, localClassifier: embeddings, llm }]);
  modes.push(['rules + local model (TF-IDF)', { ...base, localClassifier: classifier }]);
  if (llm)
    modes.push([
      'full cascade (rules + TF-IDF + LLM)',
      { ...base, localClassifier: classifier, llm },
    ]);

  const results: { name: string; summary: Summary; records: EvalRecord[] }[] = [];
  for (const [name, deps] of modes) {
    console.error(`running: ${name}`);
    const records = await evaluate(test, deps, systems);
    results.push({ name, summary: summarize(records, QUEUES.CRITICAL_REVIEW), records });
  }

  const lines: string[] = [];
  lines.push('# Evaluation report', '');
  lines.push(
    `Generated ${new Date().toISOString()} on the synthetic held-out split: ${String(test.length)} test documents (unseen scenario per class, hard cases, prompt-injection and OCR-noise variants), TF-IDF trained on ${String(train.length)} in ${trainMs.toFixed(0)} ms, embeddings head in ${embeddingTrainMs.toFixed(0)} ms including encoding. LLM: ${llm ? config.LLM_MODEL : 'disabled'}.`,
    '',
  );
  lines.push(
    "Synthetic letters are easier than real mail. These numbers validate the mechanics of the cascade, not the production accuracy; that needs the client's labelled sample.",
    '',
  );
  lines.push(
    '| Mode | Suggestion accuracy | Macro-F1 | Coverage (no human) | Precision of auto-routed | Critical lost | Wrong customer, auto-routed | Injection auto-routed wrong | p95 ms (LLM cached) | LLM tokens |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) lines.push(summaryRow(r.name, r.summary));
  lines.push('');

  let baseline: Summary | undefined;
  if (args['llm-baseline'] && llm) {
    console.error('running: LLM only, every letter');
    const records = await llmOnly(llm, test, systems, config.LLM_MIN_CONFIDENCE);
    baseline = summarize(records, QUEUES.CRITICAL_REVIEW);
    lines.push(
      '### LLM only (no rules, no local model)',
      '',
      'One LLM call per letter, with the same acceptance gates as the cascade (grounded quote, confidence, not OTHER), and the same customer matching and routing.',
      '',
      '| Mode | Suggestion accuracy | Macro-F1 | Coverage (no human) | Precision of auto-routed | Critical lost | Wrong customer, auto-routed | Injection auto-routed wrong | p95 ms (LLM cached) | LLM tokens |',
      '|---|---|---|---|---|---|---|---|---|---|',
      summaryRow('LLM only', baseline),
      '',
    );
  }

  const model = config.LLM_MODEL;
  const costLines: CostLine[] = results
    .filter((r) => r.summary.llmTokens > 0)
    .map((r) => ({
      name: r.name,
      documents: r.summary.documents,
      inputTokens: r.summary.llmInputTokens,
      outputTokens: r.summary.llmOutputTokens,
      llmCalls: r.records.filter((x) => x.llmTokens > 0).length,
      toHuman: r.records.filter((x) => x.autoLabel === null).length,
    }));
  if (baseline)
    costLines.push({
      name: 'LLM only',
      documents: baseline.documents,
      inputTokens: baseline.llmInputTokens,
      outputTokens: baseline.llmOutputTokens,
      llmCalls: baseline.documents,
      toHuman: Math.round(baseline.documents * (1 - baseline.coverage)),
    });
  const costs = costLines.map((l) => costPerThousand(l, model)).filter((c) => c !== undefined);
  if (costs.length) {
    lines.push(
      `## Classification cost per 1000 letters (${model}, list prices in src/evaluation/cost.ts)`,
      '',
      'OCR is excluded: it is the same work in every design. Local stages run on the CPU that serves the API.',
      '',
      '| Design | LLM calls | Input tokens | Output tokens | LLM cost (USD) | Letters for a person |',
      '|---|---|---|---|---|---|',
    );
    for (const c of costs)
      lines.push(
        `| ${c.name} | ${String(c.llmCalls)} | ${String(c.inputTokens)} | ${String(c.outputTokens)} | ${c.usd.toFixed(2)} | ${String(c.toHuman)} |`,
      );
    lines.push('');
  }

  const best = results[results.length - 1];
  if (best) {
    const s = best.summary;
    lines.push(`## Details: ${best.name}`, '');
    lines.push(
      `Decided by: ${Object.entries(s.decidedBy)
        .map(([k, v]) => `${k} ${String(v)}`)
        .join(', ')}.`,
      '',
    );
    if (s.criticalLost === 0) {
      lines.push(
        `No critical letter lost out of ${String(s.criticalDocuments)}. Rule of three: with zero misses in n=${String(s.criticalDocuments)}, the 95% upper bound on the miss rate is about ${pct(ruleOfThree(s.criticalDocuments))}. The PoC plan oversamples to 300 per critical class to push that to about 1%.`,
        '',
      );
    } else {
      lines.push(`Critical letters lost: ${s.criticalLostIds.join(', ')}.`, '');
    }
    lines.push(
      '| Class | Critical | Support | Precision | Recall | F1 | Auto-routed | Auto precision | 95% lower bound |',
      '|---|---|---|---|---|---|---|---|---|',
    );
    for (const m of perClassMetrics(best.records)) {
      if (m.support === 0) continue;
      const auto = best.records.filter((r) => r.autoLabel === m.label);
      const right = auto.filter((r) => r.truth === m.label).length;
      lines.push(
        `| ${m.label} | ${CLASS_DEFINITIONS[m.label].critical ? 'yes' : ''} | ${String(m.support)} | ${m.precision.toFixed(2)} | ${m.recall.toFixed(2)} | ${m.f1.toFixed(2)} | ${String(auto.length)} | ${auto.length ? pct(right / auto.length) : '-'} | ${auto.length ? pct(wilsonLower(right, auto.length)) : '-'} |`,
      );
    }
    lines.push('');
    const byTag = (tag: string): string => {
      const subset = best.records.filter((r) => r.tags.includes(tag));
      const ss = summarize(subset, QUEUES.CRITICAL_REVIEW);
      return `| ${tag} | ${String(subset.length)} | ${pct(ss.suggestionAccuracy)} | ${pct(ss.coverage)} | ${pct(ss.autoPrecision)} |`;
    };
    lines.push(
      '| Slice | n | Suggestion accuracy | Coverage | Precision of auto-routed |',
      '|---|---|---|---|---|',
    );
    for (const tag of [
      'hard_case',
      'injection',
      'ocr_noise',
      'id_slip',
      'author:gpt-5.4',
      'author:claude',
    ])
      lines.push(byTag(tag));
    lines.push('');
  }

  lines.push(
    '## Decisive rules, validated on the training split',
    '',
    'A rule may decide alone only if the lower 95% bound of its precision on training letters is at least 95%.',
    '',
    '| Rule | Label | Fired | Correct | Precision | 95% lower bound | Decides alone |',
    '|---|---|---|---|---|---|---|',
    ...rules.stats.map(
      (r) =>
        `| ${r.id} | ${r.label} | ${String(r.fired)} | ${String(r.correct)} | ${r.fired ? pct(r.correct / r.fired) : '-'} | ${pct(r.lowerBound)} | ${r.decisive ? 'yes' : 'no, hint only'} |`,
    ),
    '',
  );
  lines.push(...(await identityReport(config.CRM_FIXTURE_PATH)));
  lines.push(...(await learningCurve(train, test, embedder)));

  const points = test.map((ex) => {
    const p = classifier.predict(ex.text);
    return { confidence: p.confidence, correct: p.label === ex.label };
  });
  lines.push(
    '## Risk-coverage of the local model alone',
    '',
    '| Threshold | Coverage | Accuracy |',
    '|---|---|---|',
  );
  for (const p of riskCoverage(points))
    lines.push(`| ${p.threshold.toFixed(2)} | ${pct(p.coverage)} | ${pct(p.accuracy)} |`);
  lines.push(
    '',
    '## Calibrated per-class thresholds (out-of-fold)',
    '',
    '| Class | Threshold |',
    '|---|---|',
  );
  for (const [label, t] of Object.entries(classifier.thresholds))
    lines.push(`| ${label} | ${t > 1 ? 'never auto' : t.toFixed(3)} |`);

  const report = `${lines.join('\n')}\n`;
  await mkdir('reports', { recursive: true });
  await writeFile('reports/latest-eval.md', report);
  await mkdir('var', { recursive: true });
  await writeFile(
    'var/eval-records.json',
    JSON.stringify(
      results.map((r) => ({ name: r.name, records: r.records })),
      null,
      2,
    ),
  );
  console.log(report);
}

await main();
