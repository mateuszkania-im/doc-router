import { describe, expect, it } from 'vitest';
import { confusableVariants } from '../src/enrichment/match.js';
import { isValidPesel } from '../src/extraction/checksums.js';
import {
  dropNearDuplicates,
  extendFixture,
  identifierSlip,
  reseed,
  sequence,
} from '../scripts/synthetic.js';
import { fixture } from './helpers.js';

describe('synthetic corpus helpers', () => {
  it('issues reference numbers in sequence, so OCR neighbours exist', () => {
    reseed(1);
    const next = sequence('POL', 6);
    const numbers = Array.from({ length: 400 }, next);
    const taken = new Set(numbers);
    const withNeighbour = numbers.filter((n) => confusableVariants(n).some((v) => taken.has(v)));
    expect(withNeighbour.length).toBeGreaterThan(100);
  });

  it('extends a fixture without touching the customers the demo samples refer to', () => {
    reseed(2);
    const extended = extendFixture(fixture, 60);
    expect(extended.customers).toHaveLength(60);
    expect(extended.customers.slice(0, 2)).toEqual(fixture.customers);
    const pesels = extended.customers.flatMap((c) => (c.pesel ? [c.pesel] : []));
    expect(pesels.every(isValidPesel)).toBe(true);
  });

  it('replaces a customer policy number with a neighbour that belongs to someone else', () => {
    const core = {
      ...fixture,
      customers: [
        {
          name: 'Jan Kowalski',
          ibans: [],
          flags: [],
          id: 'A',
          policies: [
            { number: 'POL/2024/000013', product: 'MOTOR' as const, status: 'ACTIVE' as const },
          ],
        },
        {
          name: 'Ewa Wiśniewska',
          ibans: [],
          flags: [],
          id: 'B',
          policies: [
            { number: 'POL/2024/000018', product: 'MOTOR' as const, status: 'ACTIVE' as const },
          ],
        },
      ],
    };
    const slip = identifierSlip(
      {
        id: 'x',
        label: 'COMPLAINT',
        text: 'Dotyczy polisy POL/2024/000013.',
        tags: ['customer:A'],
      },
      core,
    );
    expect(slip?.text).toBe('Dotyczy polisy POL/2024/000018.');
    expect(slip?.tags).toContain('customer:A');
    expect(slip?.tags).toContain('id_slip');
  });

  it('drops near-duplicates within a class only', () => {
    const text =
      'Szanowni Państwo, wypowiadam umowę ubezpieczenia samochodu z dniem dzisiejszym, proszę o potwierdzenie.';
    const { kept, dropped } = dropNearDuplicates([
      { id: '1', label: 'CONTRACT_TERMINATION', text, tags: [] },
      { id: '2', label: 'CONTRACT_TERMINATION', text: `${text} Dziękuję.`, tags: [] },
      { id: '3', label: 'OTHER', text, tags: [] },
    ]);
    expect(dropped).toBe(1);
    expect(kept.map((k) => k.id)).toEqual(['1', '3']);
  });
});
