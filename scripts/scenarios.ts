import type { DocumentClass } from '../src/domain/classes.js';

/**
 * Generation briefs per class. The LAST scenario of each class is held out for the test split,
 * so the evaluation measures generalisation to an unseen variant of the class, not memorisation.
 */
export const SCENARIOS: Readonly<Record<DocumentClass, readonly string[]>> = {
  BAILIFF_SEIZURE: [
    'Komornik Sądowy przy Sądzie Rejonowym zawiadamia o zajęciu wierzytelności z rachunku bankowego dłużnika {OSOBA} (PESEL {PESEL}), sygnatura {SYGN_KM}, wzywa do nieprzekazywania środków dłużnikowi i przekazania ich na rachunek komornika.',
    'Komornik zawiadamia ubezpieczyciela o zajęciu świadczenia z polisy {POLISA} przysługującego dłużnikowi {OSOBA}, sygnatura {SYGN_KM}, i wzywa do złożenia oświadczenia w terminie 7 dni.',
    'Naczelnik Urzędu Skarbowego jako administracyjny organ egzekucyjny zawiadamia o zajęciu wierzytelności pieniężnej (należności z umowy ubezpieczenia) zobowiązanego {OSOBA}, PESEL {PESEL}.',
    'Komornik dokonuje zajęcia wynagrodzenia za pracę pracownika firmy {OSOBA} (firma występuje jako pracodawca), sygnatura {SYGN_KM}, z pouczeniem o odpowiedzialności za niewykonanie.',
    'Krótkie, suche pismo komornicze: "Zawiadomienie o zajęciu wierzytelności" z tabelką: dłużnik, PESEL, kwota należności głównej, odsetki, koszty, sygnatura {SYGN_KM}, numer rachunku komornika {IBAN}.',
  ],
  BAILIFF_INQUIRY: [
    'Komornik Sądowy wzywa w trybie art. 761 k.p.c. do udzielenia informacji, czy {OSOBA} (PESEL {PESEL}) posiada rachunki, polisy lub wierzytelności wobec firmy, sygnatura {SYGN_KM}. Bez zajęcia.',
    'Komornik pyta, czy dłużnik {OSOBA} jest ubezpieczony i czy przysługują mu jakiekolwiek świadczenia, prosi o odpowiedź w terminie 7 dni, sygnatura {SYGN_KM}.',
    'Kancelaria komornicza prosi o informację o adresie i danych kontaktowych dłużnika {OSOBA} posiadanych przez firmę, sygnatura {SYGN_KM}, powołując się na obowiązek udzielenia informacji.',
    'Ponaglenie komornika: brak odpowiedzi na wcześniejsze wezwanie do udzielenia informacji o majątku dłużnika {OSOBA}, sygnatura {SYGN_KM}, z pouczeniem o grzywnie.',
  ],
  COURT_LETTER: [
    'Sąd Rejonowy przesyła nakaz zapłaty w postępowaniu upominawczym, sygnatura akt {SYGN_SAD}, pozwany: firma, powód: {OSOBA}, z pouczeniem o sprzeciwie w terminie 14 dni.',
    'Sąd Okręgowy doręcza odpis pozwu {OSOBA} przeciwko firmie o zapłatę odszkodowania z polisy {POLISA}, sygnatura {SYGN_SAD}, i zobowiązuje do odpowiedzi na pozew.',
    'Sąd Rejonowy zawiadamia o terminie rozprawy w sprawie z powództwa {OSOBA}, sygnatura {SYGN_SAD}, wzywa pełnomocnika firmy do stawiennictwa.',
    'Sąd Rejonowy, Wydział Cywilny, zwraca się o nadesłanie akt szkody {SZKODA} w sprawie o sygnaturze {SYGN_SAD} w terminie 14 dni.',
    'Postanowienie sądu o zabezpieczeniu roszczenia, sygnatura {SYGN_SAD}, doręczone firmie jako uczestnikowi postępowania.',
  ],
  COMPLAINT: [
    'Klient {OSOBA} składa reklamację na decyzję o odmowie wypłaty odszkodowania ze szkody {SZKODA}, uważa ją za bezpodstawną i żąda ponownego rozpatrzenia.',
    'Klient pisze, że pobrano mu podwójnie składkę z polisy {POLISA}, jest bardzo zdenerwowany, żąda zwrotu i wyjaśnień. Nie używa słowa reklamacja wprost.',
    'Klient zgłasza zastrzeżenia do zaniżonej wyceny szkody komunikacyjnej {SZKODA}, załącza kosztorys warsztatu i domaga się dopłaty.',
    'Klient skarży się na niegrzeczną obsługę konsultanta i brak odpowiedzi na maile od miesiąca w sprawie polisy {POLISA}, żąda przeprosin i rozpatrzenia sprawy.',
    'Klient wypowiada umowę {POLISA}, ALE w tym samym piśmie zarzuca firmie bezpodstawne naliczenie opłaty likwidacyjnej i żąda jej zwrotu (reklamacja ukryta w wypowiedzeniu).',
  ],
  REGULATOR_LETTER: [
    'Rzecznik Finansowy prosi o zajęcie stanowiska w sprawie skargi klienta {OSOBA} dotyczącej odmowy wypłaty świadczenia z polisy {POLISA}, w terminie 14 dni.',
    'Urząd Komisji Nadzoru Finansowego zwraca się o wyjaśnienia dotyczące praktyki rozpatrywania reklamacji, na podstawie skargi {OSOBA}.',
    'Prezes UOKiK prosi o informacje i kopie wzorców umów w związku z postępowaniem wyjaśniającym dotyczącym klauzul w umowach ubezpieczenia.',
    'Rzecznik Finansowy informuje o wszczęciu postępowania polubownego z wniosku {OSOBA} i przesyła wniosek do ustosunkowania się.',
  ],
  LAW_ENFORCEMENT_REQUEST: [
    'Prokuratura Rejonowa żąda udostępnienia informacji objętych tajemnicą o rachunkach i polisach podejrzanego {OSOBA} (PESEL {PESEL}) w sprawie o sygnaturze PR 1 Ds. 123.2024, na podstawie art. 105 Prawa bankowego.',
    'Komenda Miejska Policji, Wydział do walki z przestępczością gospodarczą, prosi o przekazanie dokumentacji szkody {SZKODA} w związku z podejrzeniem wyłudzenia odszkodowania.',
    'Prokuratura Okręgowa wzywa do wydania dokumentów dotyczących polisy {POLISA} i wypłat z niej na rzecz {OSOBA}, w terminie 7 dni, pod rygorem kary porządkowej.',
    'Komenda Powiatowa Policji prosi o ustalenie danych właściciela rachunku {IBAN} w związku z oszustwem internetowym.',
  ],
  GDPR_REQUEST: [
    '{OSOBA} żąda na podstawie art. 15 RODO dostępu do swoich danych osobowych i kopii danych przetwarzanych przez firmę.',
    '{OSOBA} żąda usunięcia wszystkich swoich danych (prawo do bycia zapomnianym), bo nie jest już klientem i nie zgadza się na dalsze przetwarzanie.',
    '{OSOBA} wnosi sprzeciw wobec przetwarzania danych w celach marketingowych i żąda zaprzestania telefonów z ofertami.',
    '{OSOBA} prosi o informację, komu firma udostępniła jego dane i skąd je pozyskała, powołując się na przepisy o ochronie danych osobowych.',
  ],
  DEATH_NOTIFICATION: [
    'Żona informuje o śmierci męża {OSOBA}, ubezpieczonego z polisy na życie {POLISA}, załącza akt zgonu i prosi o wypłatę świadczenia.',
    'Syn zawiadamia, że jego matka {OSOBA} zmarła, prosi o zamknięcie jej spraw i informację o ewentualnych środkach, załącza skrócony akt zgonu.',
    'Kancelaria notarialna przesyła akt poświadczenia dziedziczenia po zmarłym {OSOBA} i pyta o świadczenia przysługujące spadkobiercom.',
    'Krótka notatka od rodziny: "Uprzejmie informuję, że {OSOBA} zmarł dnia {DATA}. W załączeniu akt zgonu." bez innych żądań.',
  ],
  CONTRACT_WITHDRAWAL: [
    'Klient {OSOBA} odstępuje od umowy ubezpieczenia {POLISA} zawartej 10 dni temu, w ustawowym terminie 30 dni, i prosi o zwrot składki na rachunek {IBAN}.',
    'Klient odstępuje od umowy zawartej na odległość przez internet w terminie 14 dni, bez podania przyczyny, polisa {POLISA}.',
    'Formularz odstąpienia od umowy wypełniony przez klienta: dane, numer umowy {POLISA}, data zawarcia, podpis.',
    'Klient pisze nieformalnie, że rozmyślił się co do świeżo kupionej polisy {POLISA} i chce się z niej wycofać, korzystając z prawa do odstąpienia.',
  ],
  CLAIM_NOTIFICATION: [
    'Klient {OSOBA} zgłasza szkodę komunikacyjną z polisy OC/AC {POLISA}: kolizja na skrzyżowaniu, opis zdarzenia, dane drugiego kierowcy.',
    'Klient zgłasza zalanie mieszkania przez sąsiada z góry, polisa mieszkaniowa {POLISA}, opis zniszczeń, prośba o oględziny.',
    'Poszkodowany w wypadku zgłasza roszczenie z OC sprawcy, który był ubezpieczony w firmie (polisa {POLISA}), opis obrażeń i leczenia.',
    'Zgłoszenie kradzieży roweru i laptopa z mieszkania, polisa {POLISA}, numer notatki policyjnej, lista skradzionych rzeczy.',
    'Rolnik zgłasza szkodę w uprawach po gradobiciu, polisa {POLISA}, powierzchnia upraw i szacunkowe straty.',
  ],
  CLAIM_DOCUMENTS: [
    'Klient przesyła brakujące dokumenty do szkody {SZKODA}: fakturę za naprawę samochodu i zdjęcia uszkodzeń, zgodnie z wezwaniem.',
    'Klient dosyła dokumentację medyczną (karta informacyjna ze szpitala, zaświadczenie lekarskie) do szkody {SZKODA}.',
    'Warsztat naprawczy przesyła kosztorys i fakturę za naprawę pojazdu klienta {OSOBA} do szkody {SZKODA} z prośbą o rozliczenie bezgotówkowe.',
    'Klient przesyła notatkę policyjną i oświadczenie sprawcy do toczącej się szkody {SZKODA}, krótkie pismo przewodnie.',
  ],
  CONTRACT_TERMINATION: [
    'Klient {OSOBA} wypowiada umowę ubezpieczenia {POLISA} z zachowaniem okresu wypowiedzenia, bez podania przyczyny.',
    'Klient informuje, że sprzedał samochód i wypowiada polisę OC {POLISA}, załącza umowę sprzedaży.',
    'Klient rezygnuje z kontynuacji ubezpieczenia na życie {POLISA} od następnego okresu, bo przeszedł do ubezpieczenia grupowego w pracy, dziękuje za współpracę.',
    'Firma (klient biznesowy) wypowiada umowę ubezpieczenia floty pojazdów {POLISA} z końcem roku, pismo podpisane przez zarząd.',
  ],
  PERSONAL_DATA_CHANGE: [
    '{OSOBA} prosi o zmianę adresu korespondencyjnego w polisie {POLISA} w związku z przeprowadzką.',
    '{OSOBA} informuje o zmianie nazwiska po ślubie, załącza odpis aktu małżeństwa, prosi o aktualizację danych.',
    'Klient prosi o zmianę numeru rachunku do wypłat na {IBAN}, polisa {POLISA}.',
    'Klient prosi o aktualizację numeru telefonu i adresu e-mail do kontaktu oraz zgody na korespondencję elektroniczną.',
  ],
  POWER_OF_ATTORNEY: [
    '{OSOBA} udziela pełnomocnictwa córce do reprezentowania go we wszystkich sprawach dotyczących polisy {POLISA}.',
    'Klient odwołuje pełnomocnictwo udzielone wcześniej byłemu małżonkowi i prosi o nieudzielanie mu informacji.',
    'Kancelaria radcy prawnego przedkłada pełnomocnictwo do reprezentowania {OSOBA} w sprawie szkody {SZKODA}, bez dalszych żądań w tym piśmie.',
    'Pełnomocnictwo notarialne ogólne przesłane do wiadomości firmy wraz z krótkim pismem przewodnim.',
  ],
  INVOICE: [
    'Faktura VAT od dostawcy usług IT za wsparcie systemów w miesiącu, z pozycjami, kwotą netto, VAT i brutto, NIP sprzedawcy, termin płatności.',
    'Faktura od agencji ochrony za ochronę biura, z numerem zamówienia i rachunkiem do zapłaty.',
    'Nota obciążeniowa od kontrahenta za opóźnienie w płatności, z NIP i numerem rachunku.',
    'Faktura od firmy rzeczoznawczej za sporządzenie opinii technicznych do szkód (firma jest nabywcą), wiele pozycji.',
  ],
  OTHER: [
    'Oferta handlowa od firmy szkoleniowej proponującej kursy dla pracowników działu likwidacji szkód.',
    'Podziękowanie od klienta za sprawną obsługę i miłą rozmowę z konsultantem, bez żadnych żądań.',
    'Zaproszenie na konferencję branżową ubezpieczeniową z programem i formularzem rejestracji.',
    'List motywacyjny i CV kandydata do pracy na stanowisko likwidatora szkód.',
    'Prośba fundacji o wsparcie finansowe akcji charytatywnej dla dzieci.',
  ],
};

/** Additional hard cases: realistic letters crafted to defeat naive keyword matching. */
export const HARD_CASES: readonly { label: DocumentClass; brief: string }[] = [
  {
    label: 'CLAIM_DOCUMENTS',
    brief:
      'Pismo przewodnie do szkody {SZKODA}, w którym klient wspomina, że "jeśli nie wypłacicie w terminie, rozważę reklamację", ale właściwą treścią jest przesłanie faktur.',
  },
  {
    label: 'CONTRACT_TERMINATION',
    brief:
      'Wypowiedzenie polisy {POLISA}, w którym klient pisze, że wcześniej składał reklamację, która została już pozytywnie rozpatrzona i nie ma żadnych zarzutów.',
  },
  {
    label: 'INVOICE',
    brief:
      'Faktura od kancelarii prawnej za obsługę prawną firmy w sprawach sądowych, z wymienionymi sygnaturami spraw sądowych w pozycjach faktury.',
  },
  {
    label: 'OTHER',
    brief:
      'Newsletter od kancelarii komorniczej z informacjami o zmianach w przepisach egzekucyjnych, bez żadnej konkretnej sprawy.',
  },
  {
    label: 'POWER_OF_ATTORNEY',
    brief:
      'Pełnomocnictwo dla syna do spraw ubezpieczeniowych matki, wzmianka, że ojciec zmarł kilka lat temu.',
  },
];
