import { describe, expect, it } from 'vitest';
import { enrich } from '../src/enrichment/enrich.js';
import { confusableVariants, nameInLetter } from '../src/enrichment/match.js';
import { applyReadEvidence, extract, extractIdentifiers } from '../src/extraction/extract.js';
import { route } from '../src/routing/route.js';
import type { Classification } from '../src/domain/types.js';
import { InMemoryCoreSystems } from '../src/enrichment/core-systems.js';
import { systems, VALID } from './helpers.js';

/**
 * Policy numbers are issued in sequence, so neighbours one OCR confusion apart (3 and 8) belong to
 * different people. Neither customer carries a fraud flag, so routing shows the matching logic.
 */
const neighbours = new InMemoryCoreSystems({
  customers: [
    {
      id: 'N1',
      name: 'Jan Kowalski',
      ibans: [],
      policies: [{ number: 'POL/2024/000013', product: 'MOTOR', status: 'ACTIVE' }],
      flags: [],
    },
    {
      id: 'N2',
      name: 'Ewa Wiśniewska',
      ibans: [],
      policies: [{ number: 'POL/2024/000018', product: 'MOTOR', status: 'ACTIVE' }],
      flags: [],
    },
  ],
  claims: [],
  complaints: [],
  courtCases: [],
});

const decided: Classification = {
  label: 'CLAIM_DOCUMENTS',
  decidedBy: 'local_model',
  confidence: 0.99,
  suggestedLabel: 'CLAIM_DOCUMENTS',
  safetyNet: [],
  reviewReasons: [],
  trace: [],
};

async function run(
  text: string,
  read: Parameters<typeof extract>[1] = {},
  core: InMemoryCoreSystems = systems(),
) {
  const extraction = extract(text, read);
  const enrichment = await enrich(core, extraction.identifiers, text);
  return { extraction, enrichment, routing: route(decided, extraction, enrichment, new Date()) };
}

describe('nameInLetter', () => {
  it('accepts declined Polish names', () => {
    expect(nameInLetter('W imieniu Joanny Nowak składam', 'Joanna Nowak')).toBe(true);
    expect(nameInLetter('dotyczy Pani Agnieszki Kamińskiej', 'Agnieszka Kamińska')).toBe(true);
    expect(nameInLetter('Kowalski Jan, ul. Polna 3', 'Jan Kowalski')).toBe(true);
  });

  it('recognises a company by its core name, declined', () => {
    expect(
      nameInLetter(
        'W imieniu Witkowski Logistyka sp. z o.o. wypowiadam',
        'Witkowski Logistyka sp. z o.o.',
      ),
    ).toBe(true);
    expect(nameInLetter('Logistyka Witkowski', 'Witkowski Logistyka sp. z o.o.')).toBe(false);
  });

  it('survives OCR that dropped diacritics', () => {
    expect(nameInLetter('Agnieszka Kaminska', 'Agnieszka Kamińska')).toBe(true);
  });

  it('needs first name and surname together, so a common word is not a name', () => {
    expect(nameInLetter('nowa umowa została zawarta', 'Anna Nowak')).toBe(false);
    expect(nameInLetter('Pan Kowalski dzwonił', 'Jan Kowalski')).toBe(false);
  });
});

describe('confusableVariants', () => {
  it('lists single OCR confusions and adjacent swaps, never the value itself', () => {
    const v = confusableVariants('SZK/2026/000010');
    expect(v).toContain('SZK/2026/000070');
    expect(v).toContain('SZK/2025/000010');
    expect(v).toContain('SZK/2026/000001');
    expect(v).not.toContain('SZK/2026/000010');
  });
});

describe('extraction of OCR-damaged references', () => {
  it('repairs letters read in place of digits and records the repair', () => {
    const [id] = extractIdentifiers('dotyczy polisy POL/2O24/OOOOOl');
    expect(id).toMatchObject({ value: 'POL/2024/000001', uncertain: 'repaired' });
  });

  it('marks identifiers the second read did not confirm', () => {
    const ids = applyReadEvidence(extractIdentifiers(`PESEL ${VALID.pesel}, SZK/2026/000010`), {
      secondRead: [VALID.pesel],
    });
    expect(ids.find((i) => i.kind === 'PESEL')?.uncertain).toBeUndefined();
    expect(ids.find((i) => i.kind === 'CLAIM_NUMBER')?.uncertain).toBe(
      'unconfirmed_by_second_read',
    );
  });

  it('distrusts every read-sensitive identifier in handwriting read only once', () => {
    const ids = applyReadEvidence(extractIdentifiers(`PESEL ${VALID.pesel}`), {
      handwritten: true,
    });
    expect(ids[0]?.uncertain).toBe('handwritten_single_read');
  });
});

describe('resolveCustomer', () => {
  it('confirms a reference match with the name in the letter', async () => {
    const { enrichment, routing } = await run('Dokumenty do szkody SZK/2026/000010. Jan Kowalski');
    expect(enrichment.customer?.confirmedBy).toEqual(['name_in_letter']);
    expect(routing.requiresHumanReview).toBe(false);
  });

  it('confirms with a checksummed identifier alone', async () => {
    const { enrichment } = await run(`PESEL ${VALID.pesel}`);
    expect(enrichment.customer?.confirmedBy).toContain('checksummed_identifier');
  });

  it('confirms with two independent references of the same customer', async () => {
    const { enrichment } = await run('polisa POL/2024/000001, szkoda SZK/2026/000010');
    expect(enrichment.customer?.confirmedBy).toEqual(['second_reference']);
  });

  it('sends a lone reference with nothing to confirm it to review, with candidates', async () => {
    const { enrichment, routing } = await run('Wypowiadam polisę POL/2024/000018.', {}, neighbours);
    expect(enrichment.customer?.confirmedBy).toEqual([]);
    expect(routing.requiresHumanReview).toBe(true);
    expect(routing.reasons.join(' ')).toMatch(/nothing else confirms it/);
    expect(enrichment.candidates?.map((c) => c.customerId).sort()).toEqual(['N1', 'N2']);
  });

  it('catches the OCR slip that lands on another real customer, and names the likely one', async () => {
    // Jan Kowalski holds POL/2024/000013; OCR read the 3 as an 8, which is Ewa Wiśniewska's
    // policy. Exact matching alone would quietly attach his letter to her account.
    const { enrichment, routing } = await run(
      'Wypowiadam umowę ubezpieczenia POL/2024/000018. Z poważaniem, Jan Kowalski',
      {},
      neighbours,
    );
    expect(enrichment.customer?.customerId).toBe('N2');
    expect(enrichment.customer?.confirmedBy).toEqual([]);
    expect(routing.requiresHumanReview).toBe(true);
    const [first] = enrichment.candidates ?? [];
    expect(first?.customerId).toBe('N1');
    expect(first?.evidence.join(' ')).toMatch(/one OCR slip away.*name appears/);
  });

  it('lets a name confirm nothing when a namesake is one OCR slip away', async () => {
    const namesakes = new InMemoryCoreSystems({
      customers: [
        {
          id: 'A',
          name: 'Barbara Dudek',
          ibans: [],
          policies: [{ number: 'POL/2024/000013', product: 'MOTOR', status: 'ACTIVE' }],
          flags: [],
        },
        {
          id: 'B',
          name: 'Barbara Dudek',
          ibans: [],
          policies: [{ number: 'POL/2024/000018', product: 'MOTOR', status: 'ACTIVE' }],
          flags: [],
        },
      ],
      claims: [],
      complaints: [],
      courtCases: [],
    });
    const { enrichment, routing } = await run(
      'Wypowiadam polisę POL/2024/000018. Barbara Dudek',
      {},
      namesakes,
    );
    expect(enrichment.customer?.confirmedBy).toEqual([]);
    expect(routing.requiresHumanReview).toBe(true);
  });

  it('does not match on a value the second read contradicted', async () => {
    const { enrichment, routing } = await run('Dokumenty do szkody SZK/2026/000010. Jan Kowalski', {
      secondRead: ['SZK/2026/000016'],
    });
    expect(enrichment.customer).toBeUndefined();
    expect(routing.requiresHumanReview).toBe(true);
    expect(routing.alerts.join(' ')).toMatch(/not confirmed by a second read/);
    expect(enrichment.candidates?.[0]?.customerId).toBe('C1');
  });
});
