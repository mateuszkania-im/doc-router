/**
 * Runs one file through the whole pipeline and prints the decision with its trace.
 *
 *   pnpm classify samples/zajecie-komornicze.txt [--channel EMAIL]
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { buildProcessorDeps } from '../container.js';
import { ChannelSchema } from '../domain/types.js';
import { mimeTypeFromFilename } from '../ingest/text-extraction.js';
import { createLogger } from '../logger.js';
import { processDocument } from '../pipeline/processor.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { channel: { type: 'string', default: 'PAPER_SCAN' } },
});
const path = positionals[0];
if (!path) {
  console.error('usage: pnpm classify <file> [--channel EMAIL|PAPER_SCAN|...]');
  process.exit(2);
}
const mimeType = mimeTypeFromFilename(path);
if (!mimeType) {
  console.error(`unsupported file type: ${path}`);
  process.exit(2);
}

const config = loadConfig();
const logger = createLogger('warn');
const deps = await buildProcessorDeps(config, logger);
const result = await processDocument(
  {
    id: randomUUID(),
    channel: ChannelSchema.parse(values.channel),
    receivedAt: new Date(),
    filename: basename(path),
    mimeType,
    content: await readFile(path),
  },
  deps,
);

const { classification: c, routing: r, extraction: e, enrichment: en } = result;
console.log(
  `\n${result.filename}  (${result.text.source}, quality ${result.text.quality.toFixed(2)}, ${String(result.processingMs)} ms)`,
);
if (result.text.handwritten) console.log('Handwriting detected.');
if (result.text.secondRead)
  console.log(
    `Second read: ${result.text.secondRead.join(', ') || 'no identifier read with certainty'}`,
  );
console.log('\nCascade:');
for (const s of c.trace) console.log(`  ${s.stage.padEnd(12)} ${s.outcome.padEnd(10)} ${s.detail}`);
console.log(`\nLabel:      ${c.label ?? `none (suggestion: ${c.suggestedLabel ?? 'none'})`}`);
if (c.evidence) console.log(`Evidence:   "${c.evidence}"`);
if (c.safetyNet.length) console.log(`Safety net: ${c.safetyNet.join(', ')}`);
console.log(
  `Identifiers: ${e.identifiers.map((i) => `${i.kind}=${i.value}${i.valid ? '' : ' (INVALID)'}${i.uncertain ? ` (${i.uncertain})` : ''}`).join(', ') || 'none'}`,
);
console.log(`Sender:     ${e.senderType}`);
console.log(
  `Customer:   ${en.customer ? `${en.customer.customerId} ${en.customer.name} (via ${en.customer.matchedOn}; confirmed by: ${en.customer.confirmedBy.join(', ') || 'nothing'})` : 'not matched'}`,
);
for (const k of en.candidates ?? [])
  console.log(`  candidate ${k.customerId} ${k.name}: ${k.evidence.join('; ')}`);
console.log(
  `\nQueue:      ${r.queue}   priority ${r.priority}${r.deadline ? `   deadline ${r.deadline.toISOString().slice(0, 10)}` : ''}`,
);
console.log(`Review:     ${r.requiresHumanReview ? 'YES' : 'no'}`);
for (const reason of r.reasons) console.log(`  - ${reason}`);
for (const alert of r.alerts) console.log(`  ! ${alert}`);
