import { describe, expect, it } from 'vitest';
import {
  isValidNip,
  isValidPesel,
  isValidPolishIban,
  isValidRegon,
  peselCheckDigit,
} from '../src/extraction/checksums.js';
import { detectSenderType, extractIdentifiers } from '../src/extraction/extract.js';
import { VALID } from './helpers.js';

describe('checksums', () => {
  it('accepts known-valid identifiers', () => {
    expect(isValidPesel(VALID.pesel)).toBe(true);
    expect(isValidNip(VALID.nip)).toBe(true);
    expect(isValidRegon(VALID.regon)).toBe(true);
    expect(isValidPolishIban(VALID.iban)).toBe(true);
  });

  it('rejects a single changed digit', () => {
    expect(isValidPesel('44051401358')).toBe(false);
    expect(isValidNip('1234563219')).toBe(false);
    expect(isValidRegon('123456786')).toBe(false);
    expect(isValidPolishIban('PL61109010140000071219812875')).toBe(false);
  });

  it('accepts an IBAN with spaces or without the PL prefix', () => {
    expect(isValidPolishIban('PL61 1090 1014 0000 0712 1981 2874')).toBe(true);
    expect(isValidPolishIban('61109010140000071219812874')).toBe(true);
  });

  it('rejects wrong lengths and non-digits', () => {
    expect(isValidPesel('4405140135')).toBe(false);
    expect(isValidNip('12345632a8')).toBe(false);
    expect(isValidRegon('12345678')).toBe(false);
  });

  it('computes the PESEL check digit', () => {
    expect(peselCheckDigit('4405140135')).toBe(9);
  });
});

describe('extractIdentifiers', () => {
  it('finds identifiers and marks checksum validity', () => {
    const ids = extractIdentifiers(
      `PESEL 44051401359, drugi PESEL 44051401358, NIP: 123-456-32-18`,
    );
    expect(ids).toContainEqual({ kind: 'PESEL', value: '44051401359', valid: true });
    expect(ids).toContainEqual({ kind: 'PESEL', value: '44051401358', valid: false });
    expect(ids).toContainEqual({ kind: 'NIP', value: '1234563218', valid: true });
  });

  it('does not treat an unlabelled 10-digit number as a NIP', () => {
    expect(extractIdentifiers('tel. 1234563218').filter((i) => i.kind === 'NIP')).toEqual([]);
  });

  it('does not report PESEL candidates that are fragments of an account number', () => {
    const ids = extractIdentifiers(`Rachunek: ${VALID.iban}`);
    expect(ids.map((i) => i.kind)).toEqual(['IBAN']);
  });

  it('finds client reference numbers and case signatures', () => {
    const text =
      'Polisa POL/2024/000001, szkoda SZK/2026/000010, reklamacja REK/2026/00001, sygn. Km 1234/26 oraz sprawa I C 123/26 i VI Nc-e 1234567/26';
    const byKind = Object.fromEntries(
      extractIdentifiers(text).map((i) => [i.kind + i.value, i.valid]),
    );
    expect(byKind).toMatchObject({
      'POLICY_NUMBERPOL/2024/000001': true,
      'CLAIM_NUMBERSZK/2026/000010': true,
      'COMPLAINT_NUMBERREK/2026/00001': true,
      'BAILIFF_CASEKm 1234/26': true,
      'COURT_CASEI C 123/26': true,
      'COURT_CASEVI Nc-e 1234567/26': true,
    });
  });
});

describe('detectSenderType', () => {
  it('reads the letterhead', () => {
    expect(detectSenderType('Komornik Sądowy przy Sądzie Rejonowym w Krakowie')).toBe('BAILIFF');
    expect(detectSenderType('Sąd Rejonowy dla Warszawy, I Wydział Cywilny')).toBe('COURT');
    expect(detectSenderType('Rzecznik Finansowy\nul. Nowogrodzka 47A')).toBe('REGULATOR');
    expect(detectSenderType('Kancelaria Radcy Prawnego Anna Lis')).toBe('LAW_FIRM');
    expect(detectSenderType('Prokuratura Rejonowa Kraków-Krowodrza')).toBe('PROSECUTOR_OR_POLICE');
  });

  it('does not mistake our own name in the addressee block for the sender', () => {
    expect(
      detectSenderType(
        'Nowy Sącz, 25.10.2026\nVistula Towarzystwo Ubezpieczeń S.A.\nSzanowni Państwo',
      ),
    ).toBe('INDIVIDUAL');
  });

  it('ignores institutions mentioned only deep in the body of a private letter', () => {
    const letter = `Szanowni Państwo,\n${'piszę w sprawie mojej polisy. '.repeat(30)}\nSprawa trafi do sądu rejonowego.`;
    expect(detectSenderType(letter)).toBe('INDIVIDUAL');
  });
});
