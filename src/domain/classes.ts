import { z } from 'zod';

export const DOCUMENT_CLASSES = [
  'BAILIFF_SEIZURE',
  'BAILIFF_INQUIRY',
  'COURT_LETTER',
  'COMPLAINT',
  'REGULATOR_LETTER',
  'LAW_ENFORCEMENT_REQUEST',
  'GDPR_REQUEST',
  'DEATH_NOTIFICATION',
  'CONTRACT_WITHDRAWAL',
  'CLAIM_NOTIFICATION',
  'CLAIM_DOCUMENTS',
  'CONTRACT_TERMINATION',
  'PERSONAL_DATA_CHANGE',
  'POWER_OF_ATTORNEY',
  'INVOICE',
  'OTHER',
] as const;

export const DocumentClassSchema = z.enum(DOCUMENT_CLASSES);
export type DocumentClass = z.infer<typeof DocumentClassSchema>;

export interface ClassDefinition {
  /** Polish name used in prompts and in the review UI. */
  readonly label: string;
  /** One-line definition shared by the LLM prompt and the labelling guide. */
  readonly definition: string;
  /**
   * Critical classes carry a statutory or regulatory deadline, so a miss costs far more than a
   * false alarm. They get a recall-first treatment: stricter auto-accept thresholds and a rule
   * safety net that can veto the model.
   */
  readonly critical: boolean;
  /** Calendar days from receipt (not from routing) to the response deadline, if any. */
  readonly deadlineDays?: number;
  readonly deadlineBasis?: string;
}

export const CLASS_DEFINITIONS: Readonly<Record<DocumentClass, ClassDefinition>> = {
  BAILIFF_SEIZURE: {
    label: 'Zajęcie wierzytelności (komornik)',
    definition:
      'Zawiadomienie komornika lub organu egzekucyjnego (ZUS, urząd skarbowy) o zajęciu rachunku, wierzytelności, świadczenia z polisy lub wynagrodzenia.',
    critical: true,
    deadlineDays: 7,
    deadlineBasis: 'art. 889 § 1 i art. 890 § 1 k.p.c.: zajęcie skuteczne z chwilą doręczenia',
  },
  BAILIFF_INQUIRY: {
    label: 'Zapytanie komornika',
    definition:
      'Wezwanie komornika do udzielenia informacji (czy osoba jest klientem, jakie ma rachunki, polisy, należności) bez dokonania zajęcia.',
    critical: true,
    deadlineDays: 7,
    deadlineBasis: 'art. 761 k.p.c.: termin wskazany w wezwaniu, zwykle 7 dni',
  },
  COURT_LETTER: {
    label: 'Pismo sądowe',
    definition:
      'Pismo z sądu: nakaz zapłaty, pozew, wezwanie, postanowienie, zawiadomienie o rozprawie, z sygnaturą akt sądowych.',
    critical: true,
    deadlineDays: 14,
    deadlineBasis: 'sprzeciw od nakazu zapłaty: 14 dni od doręczenia',
  },
  COMPLAINT: {
    label: 'Reklamacja',
    definition:
      'Wystąpienie klienta zgłaszające zastrzeżenia do usługi lub decyzji firmy (także ukryte w innym piśmie, np. w wypowiedzeniu).',
    critical: true,
    deadlineDays: 30,
    deadlineBasis:
      'ustawa z 5.08.2015, art. 6 i 8: po 30 dniach milczenia reklamację uznaje się za rozpatrzoną zgodnie z wolą klienta',
  },
  REGULATOR_LETTER: {
    label: 'Pismo regulatora (Rzecznik Finansowy, KNF, UOKiK)',
    definition:
      'Pismo od Rzecznika Finansowego, KNF lub UOKiK, zwykle z prośbą o stanowisko w sprawie klienta.',
    critical: true,
    deadlineDays: 14,
    deadlineBasis: 'termin wskazany w piśmie, domyślnie 14 dni (do potwierdzenia z compliance)',
  },
  LAW_ENFORCEMENT_REQUEST: {
    label: 'Pismo organu ścigania',
    definition:
      'Żądanie prokuratury, policji lub innej służby o udostępnienie informacji lub dokumentów o kliencie.',
    critical: true,
    deadlineDays: 7,
    deadlineBasis:
      'art. 105 Prawa bankowego: tylko uprawniony zespół; termin wskazany w żądaniu (domyślnie 7 dni)',
  },
  GDPR_REQUEST: {
    label: 'Żądanie RODO',
    definition:
      'Żądanie osoby fizycznej z RODO: dostęp do danych, kopia, sprostowanie, usunięcie, sprzeciw, przeniesienie.',
    critical: true,
    deadlineDays: 30,
    deadlineBasis: 'art. 12 ust. 3 RODO: miesiąc od otrzymania żądania',
  },
  DEATH_NOTIFICATION: {
    label: 'Zgłoszenie zgonu',
    definition:
      'Informacja o śmierci klienta lub ubezpieczonego, zwykle z aktem zgonu, często z wnioskiem o wypłatę świadczenia.',
    critical: true,
    deadlineDays: 30,
    deadlineBasis: 'art. 817 k.c.: 30 dni na wypłatę świadczenia od zawiadomienia',
  },
  CONTRACT_WITHDRAWAL: {
    label: 'Odstąpienie od umowy',
    definition:
      'Oświadczenie o odstąpieniu od umowy (np. w ciągu 30 dni od zawarcia umowy ubezpieczenia lub 14 dni na odległość).',
    critical: true,
    deadlineDays: 30,
    deadlineBasis: 'zwrot składki i rozliczenie po odstąpieniu (do potwierdzenia z prawnikami)',
  },
  CLAIM_NOTIFICATION: {
    label: 'Zgłoszenie szkody',
    definition: 'Nowe zgłoszenie szkody lub roszczenia z polisy, opis zdarzenia.',
    critical: false,
    deadlineDays: 30,
    deadlineBasis: 'art. 817 k.c.: 30 dni na wypłatę od zawiadomienia o szkodzie',
  },
  CLAIM_DOCUMENTS: {
    label: 'Dokumenty do szkody',
    definition:
      'Uzupełnienie istniejącej szkody: faktury za naprawę, dokumentacja medyczna, zdjęcia, notatka policji.',
    critical: false,
  },
  CONTRACT_TERMINATION: {
    label: 'Wypowiedzenie umowy',
    definition:
      'Wypowiedzenie umowy lub polisy, rezygnacja z kontynuacji, bez zarzutów wobec firmy.',
    critical: false,
  },
  PERSONAL_DATA_CHANGE: {
    label: 'Zmiana danych',
    definition: 'Prośba o zmianę adresu, nazwiska, numeru konta, telefonu lub e-maila klienta.',
    critical: false,
  },
  POWER_OF_ATTORNEY: {
    label: 'Pełnomocnictwo',
    definition:
      'Udzielenie, zmiana lub odwołanie pełnomocnictwa do reprezentowania klienta, bez innego żądania.',
    critical: false,
  },
  INVOICE: {
    label: 'Faktura od dostawcy',
    definition:
      'Faktura VAT, nota lub rachunek wystawione firmie przez jej dostawcę lub kontrahenta.',
    critical: false,
  },
  OTHER: {
    label: 'Inne',
    definition: 'Dokument, który nie pasuje do żadnej z powyższych klas.',
    critical: false,
  },
};

export const CRITICAL_CLASSES: readonly DocumentClass[] = DOCUMENT_CLASSES.filter(
  (c) => CLASS_DEFINITIONS[c].critical,
);

export function isCritical(label: DocumentClass): boolean {
  return CLASS_DEFINITIONS[label].critical;
}
