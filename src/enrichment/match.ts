import type {
  CustomerCandidate,
  Identifier,
  IdentifierKind,
  MatchFactor,
} from '../domain/types.js';
import type { CoreSystems, Customer } from './core-systems.js';

/** Identifiers with a check digit: one misread digit breaks the checksum instead of the match. */
const CHECKSUMMED: ReadonlySet<IdentifierKind> = new Set(['PESEL', 'NIP', 'IBAN']);

/**
 * Digits that OCR (and hurried handwriting) confuses with each other. Client reference numbers
 * have no check digit, and they are issued sequentially, so a single confusion very often lands
 * on a real number that belongs to somebody else.
 */
const CONFUSABLE: Readonly<Record<string, readonly string[]>> = {
  '0': ['8', '6', '9'],
  '1': ['7', '4'],
  '2': ['7'],
  '3': ['8', '5'],
  '4': ['1', '9'],
  '5': ['6', '3', '8'],
  '6': ['5', '8', '0'],
  '7': ['1', '2'],
  '8': ['0', '3', '6', '5'],
  '9': ['0', '4'],
};

/**
 * Every number one OCR slip away from `value`: one confusable digit, or two adjacent digits
 * swapped. Exact lookups of these variants work against any core system that can look a number
 * up, which is why this is done here and not as a fuzzy index.
 */
export function confusableVariants(value: string): string[] {
  const prefix = value.slice(0, value.indexOf('/') + 1);
  const digits = value.slice(prefix.length);
  const variants = new Set<string>();
  Array.from(digits).forEach((ch, i) => {
    for (const alt of CONFUSABLE[ch] ?? [])
      variants.add(`${prefix}${digits.slice(0, i)}${alt}${digits.slice(i + 1)}`);
    const next = digits[i + 1];
    if (next && next !== ch && /\d/.test(next) && /\d/.test(ch))
      variants.add(`${prefix}${digits.slice(0, i)}${next}${ch}${digits.slice(i + 2)}`);
  });
  variants.delete(value);
  return [...variants];
}

const fold = (s: string): string =>
  s.normalize('NFD').replace(/\p{M}/gu, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').toLowerCase();

const stem = (word: string, keep: number, min: number): string =>
  word.slice(0, Math.max(min, word.length - keep));

/**
 * Does the letter name this customer? Polish declines names ("Kowalskiej", "Joanny Nowak"), so
 * both the first name and the surname are compared by stem, and they must stand next to each
 * other: a lone "nowa" in "nowa umowa" is not Mrs Nowak. A morphological analyser (Morfeusz) and
 * probabilistic record linkage replace this in production; it stays a second factor, never the
 * only one.
 */
export function nameInLetter(text: string, fullName: string): boolean {
  const tokens = fold(text)
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
  const company = COMPANY_FORM.exec(fold(fullName));
  if (company) {
    // A company is named by its core name ("Witkowski Logistyka" in "Witkowski Logistyka sp. z o.o."),
    // every word in order, each allowed its Polish case ending.
    const core = fold(fullName)
      .slice(0, company.index)
      .split(/[^\p{L}]+/u)
      .filter((w) => w.length > 1 && w !== 'i');
    if (core.length === 0) return false;
    const stems = core.map((w) => stem(w, 2, 3));
    const words = tokens.filter((t) => t !== 'i');
    return words.some((_, i) => stems.every((st, k) => words[i + k]?.startsWith(st) ?? false));
  }
  const parts = fold(fullName).split(/\s+/).filter(Boolean);
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!first || !last || parts.length < 2) return false;
  const firstStem = stem(first, 2, 3);
  const lastStem = stem(last, 3, 4);
  return tokens.some(
    (t, i) =>
      t.startsWith(lastStem) &&
      [tokens[i - 2], tokens[i - 1], tokens[i + 1], tokens[i + 2]].some(
        (n) => n?.startsWith(firstStem) ?? false,
      ),
  );
}

const COMPANY_FORM =
  /\b(?:sp\.?\s*z\s*o\.?\s*o|s\.?\s*a\.?$|sp\.?\s*j\b|sp\.?\s*k\b|s\.?\s*c\b|spółka)/;

interface Hit {
  readonly customer: Customer;
  readonly id: Identifier;
}

export interface CustomerResolution {
  readonly customer: Customer;
  readonly matchedOn: IdentifierKind;
  readonly confirmedBy: readonly MatchFactor[];
  /** Other customers that trusted identifiers in the same letter point to. */
  readonly others: readonly string[];
}

export interface ResolutionResult {
  readonly resolution?: CustomerResolution;
  /** Present when the reviewer has a choice to make: unconfirmed, contested, or near-miss. */
  readonly candidates: readonly CustomerCandidate[];
}

const ORDER: readonly IdentifierKind[] = [
  'PESEL',
  'NIP',
  'POLICY_NUMBER',
  'CLAIM_NUMBER',
  'COMPLAINT_NUMBER',
  'IBAN',
];

async function lookup(
  systems: CoreSystems,
  kind: IdentifierKind,
  value: string,
): Promise<Customer | undefined> {
  switch (kind) {
    case 'PESEL':
      return systems.findCustomerByPesel(value);
    case 'NIP':
      return systems.findCustomerByNip(value);
    case 'IBAN':
      return systems.findCustomerByIban(value);
    case 'POLICY_NUMBER':
      return systems.findCustomerByPolicy(value);
    case 'CLAIM_NUMBER': {
      const claim = await systems.findClaim(value);
      return claim ? systems.findCustomer(claim.customerId) : undefined;
    }
    case 'COMPLAINT_NUMBER': {
      const complaint = await systems.findComplaint(value);
      return complaint ? systems.findCustomer(complaint.customerId) : undefined;
    }
    default:
      return undefined;
  }
}

/** A value read once from handwriting, or contradicted by the second read, never decides. */
const trusted = (id: Identifier): boolean =>
  id.uncertain === undefined || id.uncertain === 'repaired';

/**
 * Hybrid customer resolution. Exact lookups find who the letter points at; a match is accepted
 * only when something independent confirms it (a checksummed identifier, a second reference, or
 * the customer's name in the letter). Near-miss lookups find who it might have pointed at before
 * an OCR slip. Everything that is not confirmed becomes a short list for a person, never a guess.
 */
export async function resolveCustomer(
  systems: CoreSystems,
  ids: readonly Identifier[],
  text: string,
): Promise<ResolutionResult> {
  const usable = ids.filter((i) => i.valid && ORDER.includes(i.kind));
  usable.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));

  const hits: Hit[] = [];
  for (const id of usable) {
    const customer = await lookup(systems, id.kind, id.value);
    if (customer) hits.push({ customer, id });
  }

  const evidence = new Map<string, { customer: Customer; notes: string[] }>();
  const note = (customer: Customer, text: string): void => {
    const entry = evidence.get(customer.id) ?? { customer, notes: [] };
    if (!entry.notes.includes(text)) entry.notes.push(text);
    evidence.set(customer.id, entry);
  };
  for (const h of hits)
    note(
      h.customer,
      `${h.id.kind} ${h.id.value}${h.id.uncertain ? ` (${h.id.uncertain.replace(/_/g, ' ')})` : ''}`,
    );

  // Near misses: for every reference without a check digit, who is one OCR slip away?
  for (const id of usable.filter((i) => !CHECKSUMMED.has(i.kind))) {
    for (const variant of confusableVariants(id.value)) {
      const customer = await lookup(systems, id.kind, variant);
      if (customer) note(customer, `${variant} is one OCR slip away from ${id.value}`);
    }
  }

  const trustedHits = hits.filter((h) => trusted(h.id));
  const primary =
    trustedHits.find((h) => CHECKSUMMED.has(h.id.kind) && !h.id.uncertain) ?? trustedHits[0];

  const nameMatches = new Set(
    [...evidence.values()]
      .filter((e) => nameInLetter(text, e.customer.name))
      .map((e) => e.customer.id),
  );
  for (const id of nameMatches) {
    const entry = evidence.get(id);
    if (entry) note(entry.customer, 'name appears in the letter');
  }
  const candidates = (): CustomerCandidate[] =>
    [...evidence.values()]
      .map((e) => ({ customerId: e.customer.id, name: e.customer.name, evidence: e.notes }))
      .sort(
        (a, b) => Number(nameMatches.has(b.customerId)) - Number(nameMatches.has(a.customerId)),
      );

  if (!primary) return { candidates: candidates() };

  const own = trustedHits.filter((h) => h.customer.id === primary.customer.id);
  const confirmedBy: MatchFactor[] = [];
  if (own.some((h) => CHECKSUMMED.has(h.id.kind) && !h.id.uncertain))
    confirmedBy.push('checksummed_identifier');
  if (new Set(own.filter((h) => !CHECKSUMMED.has(h.id.kind)).map((h) => h.id.value)).size >= 2)
    confirmedBy.push('second_reference');
  // A name confirms only if it is unique among the candidates: two Barbara Dudeks one OCR slip
  // apart prove nothing, and that is exactly when the slip is most dangerous.
  if (nameMatches.has(primary.customer.id) && nameMatches.size === 1)
    confirmedBy.push('name_in_letter');

  const others = [...new Set(trustedHits.map((h) => h.customer.id))].filter(
    (id) => id !== primary.customer.id,
  );
  const contested = confirmedBy.length === 0 || others.length > 0;
  return {
    resolution: {
      customer: primary.customer,
      matchedOn: primary.id.kind,
      confirmedBy,
      others,
    },
    candidates: contested ? candidates() : [],
  };
}
