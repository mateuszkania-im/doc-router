import { pino } from 'pino';
import type { z } from 'zod';
import type { DocumentClass } from '../src/domain/classes.js';
import type { ExtractedText, LabelledExample } from '../src/domain/types.js';
import { InMemoryCoreSystems, type CoreSystemsFixture } from '../src/enrichment/core-systems.js';
import type { LlmVerdict } from '../src/llm/llm-classifier.js';
import type {
  StructuredLlm,
  StructuredRequest,
  StructuredResult,
} from '../src/llm/structured-llm.js';

export const silentLogger = pino({ level: 'silent' });

/** Known-valid identifiers (checksums verified in checksums.test.ts). */
export const VALID = {
  pesel: '44051401359',
  nip: '1234563218',
  regon: '123456785',
  iban: 'PL61109010140000071219812874',
} as const;

export const fixture: CoreSystemsFixture = {
  customers: [
    {
      id: 'C1',
      name: 'Jan Kowalski',
      pesel: VALID.pesel,
      ibans: [VALID.iban],
      policies: [
        { number: 'POL/2024/000001', product: 'LIFE', status: 'ACTIVE' },
        { number: 'POL/2024/000002', product: 'MOTOR', status: 'ACTIVE' },
      ],
      flags: [],
    },
    {
      id: 'C2',
      name: 'Anna Nowak',
      nip: VALID.nip,
      ibans: [],
      policies: [{ number: 'POL/2025/000003', product: 'PROPERTY', status: 'ACTIVE' }],
      flags: ['FRAUD'],
    },
  ],
  claims: [
    {
      number: 'SZK/2026/000010',
      customerId: 'C1',
      status: 'OPEN',
      handler: 'a.mazur',
      pendingPayout: true,
    },
    {
      number: 'SZK/2025/000011',
      customerId: 'C2',
      status: 'CLOSED',
      handler: 'k.wrobel',
      pendingPayout: false,
    },
    {
      number: 'SZK/2025/000012',
      customerId: 'C1',
      status: 'CLOSED',
      handler: 'k.wrobel',
      pendingPayout: false,
    },
  ],
  complaints: [{ number: 'REK/2026/00001', customerId: 'C1', status: 'OPEN' }],
  courtCases: [{ caseNumber: 'I C 123/26', owner: 'legal.zajac' }],
};

export const systems = (): InMemoryCoreSystems => new InMemoryCoreSystems(fixture);

export const asText = (text: string, quality = 0.95): ExtractedText => ({
  text,
  source: 'plain',
  quality,
  pageCount: 1,
});

export const LETTERS = {
  seizure: `Komornik Sądowy przy Sądzie Rejonowym dla Warszawy-Mokotowa
Sygn. akt Km 1234/26
ZAWIADOMIENIE O ZAJĘCIU WIERZYTELNOŚCI
Na podstawie art. 889 k.p.c. zajmuję wierzytelność z rachunku bankowego dłużnika Jana Kowalskiego, PESEL ${VALID.pesel}.`,
  inquiry: `Komornik Sądowy przy Sądzie Rejonowym w Krakowie
Sygn. Km 77/26
Wezwanie do udzielenia informacji: proszę o informację, czy dłużnik Jan Kowalski posiada rachunki lub polisy.`,
  complaint: `Szanowni Państwo,
składam reklamację decyzji w sprawie szkody SZK/2026/000010. Odmowa wypłaty jest bezpodstawna, wnoszę o ponowne rozpatrzenie.
Jan Kowalski`,
  invoice: `FAKTURA VAT nr 12/10/2026
Sprzedawca: Serwis IT sp. z o.o., NIP ${VALID.nip}
Nabywca: Vistula Towarzystwo Ubezpieczeń S.A.
Wsparcie systemów IT, 10 000,00 zł netto, termin płatności 14 dni.`,
} as const;

type Responder = (request: StructuredRequest<z.ZodType>) => unknown;

/** Scripted LLM: returns whatever the responder gives, after real schema validation. */
export class FakeLlm implements StructuredLlm {
  calls = 0;
  constructor(private readonly responder: Responder) {}

  parse<T extends z.ZodType>(request: StructuredRequest<T>): Promise<StructuredResult<z.infer<T>>> {
    this.calls++;
    const data = request.schema.parse(this.responder(request));
    return Promise.resolve({
      data,
      usage: { model: 'fake', inputTokens: 100, outputTokens: 20, latencyMs: 1, cached: false },
    });
  }
}

export const verdict = (label: DocumentClass, evidence: string, confidence = 0.9): LlmVerdict => ({
  evidence,
  rationale: 'test',
  label,
  confidence,
});

/** Tiny but separable training set for classifier and cascade tests. */
export function toyDataset(): LabelledExample[] {
  const make = (label: DocumentClass, texts: readonly string[]): LabelledExample[] =>
    texts.map((text, i) => ({ id: `${label}-${String(i)}`, label, text, tags: [] }));
  const variants = (base: string): string[] =>
    [
      '',
      ' Z poważaniem.',
      ' Proszę o pilne potraktowanie.',
      ' W załączeniu dokumenty.',
      ' Dziękuję.',
      ' Pozdrawiam serdecznie.',
      ' Uprzejmie proszę.',
      ' Do wiadomości.',
    ].map((s) => base + s);
  return [
    ...make(
      'INVOICE',
      variants(
        'Faktura VAT za usługi informatyczne, kwota netto, podatek VAT, termin płatności na rachunek sprzedawcy.',
      ),
    ),
    ...make(
      'CLAIM_NOTIFICATION',
      variants(
        'Zgłaszam szkodę komunikacyjną, kolizja samochodu na skrzyżowaniu, proszę o oględziny pojazdu.',
      ),
    ),
    ...make(
      'PERSONAL_DATA_CHANGE',
      variants(
        'Proszę o zmianę adresu korespondencyjnego i numeru telefonu w moich danych klienta.',
      ),
    ),
    ...make(
      'OTHER',
      variants(
        'Zapraszamy na konferencję branżową, program wydarzenia i formularz rejestracji uczestników.',
      ),
    ),
  ];
}
