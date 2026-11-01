import { wilsonLower } from '../stats.js';
import type { DocumentClass } from '../domain/classes.js';
import { CRITICAL_CLASSES } from '../domain/classes.js';

/**
 * A decisive rule is near-certain on its own (a bailiff case number next to "zajęcie"). A signal
 * only says "this might be a critical class"; signals never classify, they veto auto-routing when
 * the final label disagrees with them.
 */
interface Rule {
  readonly id: string;
  readonly label: DocumentClass;
  readonly all: readonly RegExp[];
  readonly none?: readonly RegExp[];
}

const BAILIFF_CASE = /\b(?:G?KmS?|KmP|Kmp|Komp|GKmP)\s+\d{1,6}\/\d{2,4}\b/;
const COURT_CASE = /\b[IVXL]{1,6}\s+(?:Nc-e|GNc|Nc|GC|C|Ca|Ns|RC|P|Pa|Co)\s+\d{1,7}\/\d{2}\b/;
/** Affirmative seizure wording. A bare "zajęcie" also appears in "nie stanowi zajęcia" or "podlegać zajęciu". */
const SEIZURE_ACT =
  /zajmuj[eę]|dokonuj[eę]\s+zajęcia|dokona(?:łem|łam|no|ł)\s+zajęcia|zawiadomienie\s+o\s+zajęciu|zawiadamia\w*\s+o\s+(?:dokonaniu\s+)?zajęci/i;
const INQUIRY_ACT = /udzieleni[ae]\s+informacji|nie\s+stanowi\s+zajęcia|art\.\s*761/i;

const DECISIVE_RULES: readonly Rule[] = [
  {
    id: 'bailiff-seizure',
    label: 'BAILIFF_SEIZURE',
    all: [BAILIFF_CASE, /komornik/i, SEIZURE_ACT],
    none: [INQUIRY_ACT],
  },
  {
    id: 'bailiff-inquiry',
    label: 'BAILIFF_INQUIRY',
    all: [
      BAILIFF_CASE,
      /komornik/i,
      /udzieleni[ae]\s+informacji|wezwanie\s+do\s+udzielenia|zapytanie|art\.\s*761/i,
    ],
    none: [SEIZURE_ACT],
  },
  {
    id: 'court-case-number',
    label: 'COURT_LETTER',
    all: [COURT_CASE, /sąd\s+(?:rejonowy|okręgowy|apelacyjny)/i],
  },
  {
    id: 'tax-office-seizure',
    label: 'BAILIFF_SEIZURE',
    all: [
      /naczelnik\s+(?:\w+\s+)?urzędu\s+skarbowego|zakład\s+ubezpieczeń\s+społecznych/i,
      SEIZURE_ACT,
    ],
    none: [INQUIRY_ACT],
  },
];

/** A signal may cover several classes: a bailiff case number fits both a seizure and an inquiry. */
const SIGNALS: readonly { labels: readonly DocumentClass[]; regex: RegExp }[] = [
  {
    labels: ['BAILIFF_SEIZURE'],
    regex: /zajęci[eua]\s+(?:wierzytelności|rachunku|świadczenia|wynagrodzenia)/i,
  },
  { labels: ['BAILIFF_SEIZURE', 'BAILIFF_INQUIRY'], regex: BAILIFF_CASE },
  {
    labels: ['BAILIFF_INQUIRY'],
    regex: /komornik\s+sądowy[\s\S]{0,400}(?:udzieleni[ae]\s+informacji|zapytanie)/i,
  },
  { labels: ['COURT_LETTER'], regex: /nakaz\s+zapłaty|\bpozw(?:u|em|ie)?\b|\bpozew\b/i },
  { labels: ['COURT_LETTER'], regex: COURT_CASE },
  {
    labels: ['COMPLAINT'],
    regex:
      // Phrases chosen on the training split: each one fires on complaints and almost never on
      // other classes ("skarga" and "sprzeciw" were rejected: regulators and GDPR objections use them).
      /\breklamacj|składam\s+skargę|wnoszę\s+o\s+ponowne\s+rozpatrzenie|nie\s+zgadzam\s+się\s+z\s+decyzją|domagam\s+się|żądam\s+(?:\p{L}+\s+){0,2}zwrotu|(?:dwukrotn|podwójn)\p{L}*\s+(?:\p{L}+\s+){0,3}(?:pobra|obciąż)|nienależnie\s+pobran|bezpodstawnie\s+(?:pobran|nalicz|odmów)|ponown\p{L}*\s+(?:rozpatrzeni|weryfikacj|analiz)/iu,
  },
  {
    labels: ['REGULATOR_LETTER'],
    regex: /rzecznik\s+finansowy|komisj[aię]\s+nadzoru\s+finansowego|\bUOKiK\b/i,
  },
  {
    labels: ['LAW_ENFORCEMENT_REQUEST'],
    regex:
      /prokuratur|komend[aęy]\s+\w*\s*policji|art\.\s*105\s+(?:ust\.\s*1\s+)?(?:pkt\s*\d\s+)?prawa\s+bankowego/i,
  },
  {
    labels: ['GDPR_REQUEST'],
    regex:
      /\bRODO\b|art\.\s*1[5-9]\s|art\.\s*2[01]\s|prawo\s+do\s+(?:usunięcia|bycia\s+zapomnianym|dostępu)|ochronie\s+danych\s+osobowych/i,
  },
  {
    labels: ['DEATH_NOTIFICATION'],
    regex:
      // \b is ASCII-only in JS: after "ł" it never matches, so use a Unicode letter lookahead.
      /akt\s+zgonu|zmarł(?:a|y|e)?(?!\p{L})|śmierci\s+(?:ubezpieczonego|mojego|mojej|męża|żony|ojca|matki)/iu,
  },
  { labels: ['CONTRACT_WITHDRAWAL'], regex: /odstępuję\s+od\s+umowy|odstąpieni[ea]\s+od\s+umowy/i },
];

/**
 * Text that tries to talk to the model. A letter does not normally address an AI or ask for its
 * priority to be changed, so this is a cheap, high-precision tripwire. It never decides a class,
 * it only forces human review.
 */
const SUSPICIOUS_INSTRUCTIONS =
  /ignoruj\s+(?:wszystkie\s+)?(?:poprzednie|wcześniejsze)|zignoruj\s+(?:wszystkie\s+)?(?:poprzednie|wcześniejsze|powyższe)|ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions|system\s*prompt|jesteś\s+(?:modelem|asystentem|AI)|you\s+are\s+(?:an?\s+)?(?:AI|assistant|language\s+model)|sklasyfikuj\s+(?:ten|to)\s+(?:dokument|pismo)\s+jako|classify\s+this\s+(?:document\s+)?as|nadaj\s+(?:najwyższy\s+)?priorytet/i;

export interface RulesResult {
  /** Set only when exactly one class has a decisive match. */
  readonly label?: DocumentClass;
  readonly matchedRules: readonly string[];
  /** The matched rules the calibration allows to decide. */
  readonly trustedRules: readonly string[];
  readonly safetyNet: readonly DocumentClass[];
  /** Label set of each fired signal, kept separate so one broad signal cannot excuse a specific one. */
  readonly firedSignals: readonly (readonly DocumentClass[])[];
  readonly suspiciousInstructions: boolean;
}

/**
 * True when the label accounts for every critical signal in the text. Checked per signal: a bailiff
 * case number fits both bailiff classes, but explicit seizure wording must still veto "inquiry".
 */
export function labelExplainsSignals(rules: RulesResult, label: DocumentClass): boolean {
  return rules.firedSignals.every((labels) => labels.includes(label));
}

/** Which decisive rules may decide on their own. Without a policy, all of them may. */
export interface RulePolicy {
  readonly decisive: readonly string[];
}

export interface RuleStats {
  readonly id: string;
  readonly label: DocumentClass;
  readonly fired: number;
  readonly correct: number;
  readonly lowerBound: number;
  readonly decisive: boolean;
}

const matching = (text: string) =>
  DECISIVE_RULES.filter(
    (r) => r.all.every((re) => re.test(text)) && !(r.none ?? []).some((re) => re.test(text)),
  );

/**
 * A rule earns the right to decide on its own from labelled data, not from the confidence of the
 * person who wrote the regex: it stays decisive only if, on the training letters, the lower 95%
 * bound of its precision clears the bar. A rule that fails becomes a hint for the later stages.
 */
export function calibrateRules(
  examples: readonly { readonly text: string; readonly label: DocumentClass }[],
  minLowerBound = 0.95,
): { policy: RulePolicy; stats: RuleStats[] } {
  const stats = DECISIVE_RULES.map((rule) => {
    const fired = examples.filter((e) => matching(e.text.normalize('NFC')).includes(rule));
    const correct = fired.filter((e) => e.label === rule.label).length;
    const lowerBound = wilsonLower(correct, fired.length);
    return {
      id: rule.id,
      label: rule.label,
      fired: fired.length,
      correct,
      lowerBound,
      decisive: fired.length > 0 && lowerBound >= minLowerBound,
    };
  });
  return { policy: { decisive: stats.filter((s) => s.decisive).map((s) => s.id) }, stats };
}

export function applyRules(rawText: string, policy?: RulePolicy): RulesResult {
  const text = rawText.normalize('NFC');
  const decisive = matching(text);
  const trusted = policy ? decisive.filter((r) => policy.decisive.includes(r.id)) : decisive;
  const labels = new Set(trusted.map((r) => r.label));
  const firedSignals = SIGNALS.filter((s) => s.regex.test(text))
    .map((s) => s.labels.filter((l) => CRITICAL_CLASSES.includes(l)))
    .filter((labels) => labels.length > 0);
  const safetyNet = [...new Set(firedSignals.flat())];

  const [only] = labels;
  return {
    ...(labels.size === 1 && only ? { label: only } : {}),
    matchedRules: decisive.map((r) => r.id),
    trustedRules: trusted.map((r) => r.id),
    safetyNet,
    firedSignals,
    suspiciousInstructions: SUSPICIOUS_INSTRUCTIONS.test(text),
  };
}
