import type { Extraction, Identifier, IdentifierKind, SenderType } from '../domain/types.js';
import { isValidNip, isValidPesel, isValidPolishIban, isValidRegon } from './checksums.js';

interface Pattern {
  readonly kind: IdentifierKind;
  readonly regex: RegExp;
  readonly normalize: (match: RegExpExecArray) => string;
  readonly validate?: (value: string) => boolean;
}

/**
 * Letters that OCR returns in place of digits. Reference numbers are digits only, so inside one
 * of them an "O" can only be a misread "0". Repairing it lets the number be found at all; the
 * repair is recorded, because it is a guess.
 */
const DIGIT_LOOKALIKES: Readonly<Record<string, string>> = {
  O: '0',
  o: '0',
  Q: '0',
  D: '0',
  I: '1',
  l: '1',
  i: '1',
  Z: '2',
  z: '2',
  S: '5',
  s: '5',
  G: '6',
  b: '6',
  T: '7',
  B: '8',
  g: '9',
  q: '9',
};
const D = '[0-9OoQDIliZzSsGbTBgq]';
/** Repairs the numeric part only; the "POL/" prefix is letters by definition. */
const repairDigits = (s: string): string => {
  const cut = s.indexOf('/') + 1;
  return s.slice(0, cut) + Array.from(s.slice(cut), (ch) => DIGIT_LOOKALIKES[ch] ?? ch).join('');
};
const reference = (prefix: string, tail: number): RegExp =>
  new RegExp(`\\b(${prefix}\\/${D}{4}\\/${D}{${String(tail)}})(?![0-9A-Za-z])`, 'g');

const onlyDigits = (s: string): string => s.replace(/\D/g, '');
const group = (m: RegExpExecArray, i = 1): string => m[i] ?? m[0];

/**
 * Client-specific reference formats (POL/, SZK/, REK/) are fixtures for this PoC. In a real
 * deployment they come from the policy, claims and complaints systems.
 */
const PATTERNS: readonly Pattern[] = [
  {
    kind: 'PESEL',
    regex: /(?<!\d)(\d{11})(?!\d)/g,
    normalize: (m) => group(m),
    validate: isValidPesel,
  },
  {
    // NIP needs its label: a bare 10-digit number is as likely to be a phone number.
    kind: 'NIP',
    regex: /NIP[:\s]*((?:\d[\s-]?){9}\d)(?!\d)/gi,
    normalize: (m) => onlyDigits(group(m)),
    validate: isValidNip,
  },
  {
    kind: 'REGON',
    regex: /REGON[:\s]*(\d{14}|\d{9})(?!\d)/gi,
    normalize: (m) => group(m),
    validate: isValidRegon,
  },
  {
    kind: 'IBAN',
    regex: /(?<![\dA-Z])((?:PL\s?)?\d{2}(?:\s?\d{4}){6})(?!\d)/g,
    normalize: (m) => {
      const compact = group(m).replace(/\s/g, '').toUpperCase();
      return compact.startsWith('PL') ? compact : `PL${compact}`;
    },
    validate: isValidPolishIban,
  },
  {
    kind: 'POLICY_NUMBER',
    regex: reference('POL', 6),
    normalize: (m) => repairDigits(group(m)),
  },
  {
    kind: 'CLAIM_NUMBER',
    regex: reference('SZK', 6),
    normalize: (m) => repairDigits(group(m)),
  },
  {
    kind: 'COMPLAINT_NUMBER',
    regex: reference('REK', 5),
    normalize: (m) => repairDigits(group(m)),
  },
  {
    kind: 'BAILIFF_CASE',
    regex: /\b((?:G?KmS?|KmP|Kmp|Komp|GKmP)\s+\d{1,6}\/\d{2,4})\b/g,
    normalize: (m) => group(m).replace(/\s+/g, ' '),
  },
  {
    kind: 'COURT_CASE',
    regex:
      /\b([IVXL]{1,6}\s+(?:Nc-e|GNc|Nc|GC|C|Ca|Ns|RC|P|Pa|Co|K|Ko|Kp|Nkd|Ds|GCo)\s+\d{1,7}\/\d{2})\b/g,
    normalize: (m) => group(m).replace(/\s+/g, ' '),
  },
];

export function extractIdentifiers(text: string): Identifier[] {
  const found = new Map<string, Identifier>();
  for (const p of PATTERNS) {
    for (const m of text.matchAll(p.regex)) {
      const value = p.normalize(m);
      const key = `${p.kind}:${value}`;
      const repaired = p.kind.endsWith('_NUMBER') && value !== group(m);
      const previous = found.get(key);
      // A clean occurrence of the same number outweighs a repaired one.
      if (!previous || (previous.uncertain && !repaired))
        found.set(key, {
          kind: p.kind,
          value,
          valid: p.validate?.(value) ?? true,
          ...(repaired ? { uncertain: 'repaired' as const } : {}),
        });
    }
  }
  // A valid PESEL is never also an IBAN fragment, but an 11-digit run inside an account number is
  // a common false positive; drop PESEL candidates that sit inside a matched IBAN.
  const ibans = [...found.values()].filter((i) => i.kind === 'IBAN').map((i) => i.value);
  return [...found.values()].filter(
    (i) => i.kind !== 'PESEL' || !ibans.some((iban) => iban.includes(i.value)),
  );
}

const SENDER_RULES: readonly { type: SenderType; regex: RegExp }[] = [
  { type: 'BAILIFF', regex: /komornik\s+sądowy|kancelaria\s+komornicza/i },
  {
    type: 'PROSECUTOR_OR_POLICE',
    regex:
      /prokuratura|komenda\s+(?:miejska|powiatowa|wojewódzka|główna)\s+policji|centralne\s+biuro/i,
  },
  {
    type: 'REGULATOR',
    regex:
      /rzecznik\s+finansowy|komisja\s+nadzoru\s+finansowego|urząd\s+komisji\s+nadzoru|UOKiK|urząd\s+ochrony\s+konkurencji/i,
  },
  {
    type: 'TAX_OR_SOCIAL_SECURITY',
    regex:
      /urząd\s+skarbowy|zakład\s+ubezpieczeń\s+społecznych|naczelnik\s+(?:\w+\s+)?urzędu\s+skarbowego/i,
  },
  { type: 'COURT', regex: /sąd\s+(?:rejonowy|okręgowy|apelacyjny|najwyższy)/i },
  {
    type: 'LAW_FIRM',
    regex: /kancelaria\s+(?:prawna|radcy|adwokacka|radców)|radca\s+prawny|adwokat/i,
  },
  { type: 'COMPANY', regex: /sp\.\s*z\s*o\.\s*o\.|spółka\s+akcyjna|\bS\.A\.|\bNIP[:\s]/i },
];

/**
 * Our own name appears in the addressee block of almost every letter. Configure it per deployment;
 * otherwise every letter to "... S.A." looks like it was sent by a company.
 */
export const OWN_ORGANISATION = /vistula/i;

/**
 * Sender heuristics read only the letterhead area: a customer letter that mentions a court or a
 * bailiff in its body is still from the customer.
 */
export function detectSenderType(text: string): SenderType {
  const head = text
    .slice(0, 600)
    .split('\n')
    .filter((line) => !OWN_ORGANISATION.test(line))
    .join('\n');
  return SENDER_RULES.find((r) => r.regex.test(head))?.type ?? 'INDIVIDUAL';
}

/** Kinds a person or an OCR can get wrong digit by digit, as opposed to case signatures. */
const READ_SENSITIVE: ReadonlySet<IdentifierKind> = new Set([
  'PESEL',
  'NIP',
  'REGON',
  'IBAN',
  'POLICY_NUMBER',
  'CLAIM_NUMBER',
  'COMPLAINT_NUMBER',
]);

const compact = (value: string): string => value.replace(/\s/g, '').toUpperCase();

export interface ReadEvidence {
  readonly handwritten?: boolean;
  readonly secondRead?: readonly string[];
}

/**
 * A second, independent OCR read is the hallucination check: a vision model that invents a
 * plausible digit rarely invents the same one twice. A value the second read does not confirm is
 * kept for the reviewer but never used to find a customer. Handwriting with no second read gets
 * the same treatment, because that is where single reads go wrong.
 */
export function applyReadEvidence(ids: readonly Identifier[], read: ReadEvidence): Identifier[] {
  const confirmed = read.secondRead ? new Set(read.secondRead.map(compact)) : undefined;
  return ids.map((id) => {
    if (!READ_SENSITIVE.has(id.kind) || id.uncertain) return id;
    if (confirmed && !confirmed.has(compact(id.value)))
      return { ...id, uncertain: 'unconfirmed_by_second_read' as const };
    if (!confirmed && read.handwritten)
      return { ...id, uncertain: 'handwritten_single_read' as const };
    return id;
  });
}

export function extract(text: string, read: ReadEvidence = {}): Extraction {
  return {
    identifiers: applyReadEvidence(extractIdentifiers(text), read),
    senderType: detectSenderType(text),
  };
}
