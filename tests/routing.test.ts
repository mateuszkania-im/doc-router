import { describe, expect, it } from 'vitest';
import type { DocumentClass } from '../src/domain/classes.js';
import type { Classification, Enrichment, Extraction } from '../src/domain/types.js';
import { enrich } from '../src/enrichment/enrich.js';
import { extract } from '../src/extraction/extract.js';
import { deadlineFor, QUEUES, route } from '../src/routing/route.js';
import { systems, VALID } from './helpers.js';

const receivedAt = new Date('2026-10-30T09:00:00Z');

const decided = (
  label: DocumentClass,
  overrides: Partial<Classification> = {},
): Classification => ({
  label,
  decidedBy: 'local_model',
  confidence: 0.99,
  suggestedLabel: label,
  safetyNet: [],
  reviewReasons: [],
  trace: [],
  ...overrides,
});

async function routeText(
  label: DocumentClass,
  text: string,
  overrides: Partial<Classification> = {},
) {
  const extraction: Extraction = extract(text);
  const enrichment: Enrichment = await enrich(systems(), extraction.identifiers, text);
  return {
    routing: route(decided(label, overrides), extraction, enrichment, receivedAt),
    enrichment,
  };
}

describe('enrich', () => {
  it('matches a customer on a valid PESEL', async () => {
    const { enrichment } = await routeText('BAILIFF_SEIZURE', `PESEL ${VALID.pesel}`);
    expect(enrichment.customer).toMatchObject({ customerId: 'C1', matchedOn: 'PESEL' });
    expect(enrichment.claimWithPendingPayout?.claimNumber).toBe('SZK/2026/000010');
    expect(enrichment.activeLifePolicy?.policyNumber).toBe('POL/2024/000001');
  });

  it('never matches on an identifier with a failing checksum', async () => {
    const { enrichment } = await routeText('BAILIFF_SEIZURE', 'PESEL 44051401358');
    expect(enrichment.customer).toBeUndefined();
  });

  it('falls back to a claim number when there is no personal identifier', async () => {
    const { enrichment } = await routeText(
      'CLAIM_DOCUMENTS',
      'Dokumenty do szkody SZK/2026/000010',
    );
    expect(enrichment.customer).toMatchObject({ customerId: 'C1', matchedOn: 'CLAIM_NUMBER' });
    expect(enrichment.openClaim).toEqual({ claimNumber: 'SZK/2026/000010', handler: 'a.mazur' });
  });
});

describe('route', () => {
  it('counts the statutory deadline from receipt', () => {
    expect(deadlineFor('BAILIFF_SEIZURE', receivedAt)?.toISOString()).toBe(
      '2026-11-06T09:00:00.000Z',
    );
    expect(deadlineFor('COMPLAINT', receivedAt)?.toISOString()).toBe('2026-11-29T09:00:00.000Z');
    expect(deadlineFor('INVOICE', receivedAt)).toBeUndefined();
  });

  it('sends a seizure for a non-customer to the "not a customer" queue', async () => {
    const { routing } = await routeText('BAILIFF_SEIZURE', 'Zajęcie, PESEL 02070803628');
    expect(routing).toMatchObject({
      queue: QUEUES.ENFORCEMENT_NOT_CUSTOMER,
      priority: 'P1',
      requiresHumanReview: false,
    });
  });

  it('sends a seizure for a customer to enforcement and alerts the claim handler about a pending payout', async () => {
    const { routing } = await routeText('BAILIFF_SEIZURE', `PESEL ${VALID.pesel}`);
    expect(routing.queue).toBe(QUEUES.ENFORCEMENT);
    expect(routing.alerts.join(' ')).toContain('hold payout on claim SZK/2026/000010');
    expect(routing.deadline?.toISOString()).toBe('2026-11-06T09:00:00.000Z');
  });

  it('routes claim documents straight to the handler of the open claim', async () => {
    const { routing } = await routeText(
      'CLAIM_DOCUMENTS',
      'Faktura za naprawę do szkody SZK/2026/000010. Jan Kowalski',
    );
    expect(routing.queue).toBe('claim-handler:a.mazur');
  });

  it('routes documents for a closed claim to appeals', async () => {
    const { routing } = await routeText(
      'CLAIM_DOCUMENTS',
      'Dokumenty do szkody SZK/2025/000012, Jan Kowalski',
    );
    expect(routing.queue).toBe(QUEUES.CLAIMS_APPEALS);
  });

  it('lets the fraud flag win over claim routing', async () => {
    const { routing } = await routeText('CLAIM_DOCUMENTS', 'Dokumenty do szkody SZK/2025/000011');
    expect(routing.queue).toBe(QUEUES.FRAUD);
  });

  it('attaches a complaint only when it cites the open complaint number', async () => {
    const { routing } = await routeText(
      'COMPLAINT',
      `PESEL ${VALID.pesel}, w sprawie reklamacji REK/2026/00001 nadal nie zgadzam się z decyzją`,
    );
    expect(routing.queue).toBe(QUEUES.COMPLAINTS);
    expect(routing.reasons.join(' ')).toContain('cites open complaint REK/2026/00001');
  });

  it('treats an uncited complaint as new, with its own clock, even if another one is open', async () => {
    const { routing } = await routeText(
      'COMPLAINT',
      `PESEL ${VALID.pesel}, składam reklamację składki na polisie POL/2024/000002`,
    );
    expect(routing.reasons).toContain('new complaint');
    expect(routing.alerts.join(' ')).toContain('also has open complaint REK/2026/00001');
    expect(routing.deadline?.toISOString()).toBe('2026-11-29T09:00:00.000Z');
  });

  it('keeps the payout-hold alert when the seizure goes to human review', async () => {
    const { routing } = await routeText('BAILIFF_SEIZURE', `Zajęcie, PESEL ${VALID.pesel}`, {
      reviewReasons: ['suspicious_instructions'],
    });
    expect(routing.queue).toBe(QUEUES.CRITICAL_REVIEW);
    expect(routing.alerts.join(' ')).toContain('hold payout on claim SZK/2026/000010');
  });

  it('asks a human when identifiers point to different customers', async () => {
    const { routing, enrichment } = await routeText(
      'BAILIFF_SEIZURE',
      `Dłużnik PESEL ${VALID.pesel}, wierzyciel NIP ${VALID.nip}`,
    );
    expect(enrichment.otherCustomerIds).toEqual(['C2']);
    expect(routing.requiresHumanReview).toBe(true);
    expect(routing.reasons.join(' ')).toContain('different customers');
  });

  it('sends an unreadable document to the fast queue', async () => {
    const { routing } = await routeText('OTHER', '', {
      label: null,
      decidedBy: null,
      suggestedLabel: null,
      reviewReasons: ['text_extraction_failed', 'cascade_abstained'],
    });
    expect(routing).toMatchObject({ queue: QUEUES.CRITICAL_REVIEW, priority: 'P1' });
  });

  it('treats a complaint from a law firm as pre-litigation', async () => {
    const { routing } = await routeText(
      'COMPLAINT',
      'Kancelaria Radcy Prawnego Lis\nW imieniu klienta składam reklamację.',
    );
    expect(routing.queue).toBe(QUEUES.LEGAL);
  });

  it('opens a death claim when there is an active life policy', async () => {
    const { routing } = await routeText('DEATH_NOTIFICATION', `Akt zgonu, PESEL ${VALID.pesel}`);
    expect(routing.queue).toBe(QUEUES.LIFE_CLAIMS);
  });

  it('lets a fraud flag override normal routing', async () => {
    const { routing } = await routeText('PERSONAL_DATA_CHANGE', `NIP ${VALID.nip}`);
    expect(routing).toMatchObject({ queue: QUEUES.FRAUD, priority: 'P1' });
  });

  it('sends uncertain documents with a critical signal to the fast critical-review queue', async () => {
    const { routing } = await routeText('INVOICE', 'Faktura... złożymy reklamację', {
      label: null,
      decidedBy: null,
      safetyNet: ['COMPLAINT'],
      reviewReasons: ['cascade_abstained'],
    });
    expect(routing).toMatchObject({
      queue: QUEUES.CRITICAL_REVIEW,
      priority: 'P1',
      requiresHumanReview: true,
    });
    expect(routing.deadline?.toISOString()).toBe('2026-11-29T09:00:00.000Z');
  });

  it('sends ordinary uncertain documents to manual classification with a proposal', async () => {
    const { routing } = await routeText('INVOICE', 'Faktura', {
      label: null,
      decidedBy: null,
      reviewReasons: ['cascade_abstained'],
    });
    expect(routing).toMatchObject({
      queue: QUEUES.MANUAL_CLASSIFICATION,
      requiresHumanReview: true,
    });
    expect(routing.reasons.join(' ')).toContain('proposed: INVOICE, queue accounts-payable');
  });

  it('asks a human when the only identifier fails its checksum', async () => {
    const { routing } = await routeText('BAILIFF_SEIZURE', 'Zajęcie, PESEL 44051401358');
    expect(routing.requiresHumanReview).toBe(true);
    expect(routing.alerts.join(' ')).toContain('failing checksum');
  });
});
