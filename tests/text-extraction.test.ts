import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  normaliseRead,
  SecondReadOcr,
  type OcrOutput,
  type OcrProvider,
} from '../src/ingest/ocr.js';
import { FakeLlm } from './helpers.js';
import {
  extractDocumentText,
  mimeTypeFromFilename,
  textQuality,
} from '../src/ingest/text-extraction.js';

/** Builds a valid single-page PDF with a real text layer (Helvetica, ASCII only). */
function pdfWithText(lines: readonly string[]): Uint8Array {
  const stream = `BT /F1 12 Tf 50 750 Td 14 TL ${lines.map((l) => `(${l}) '`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${String(i + 1)} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  body += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

const fakeOcr = (
  text: string,
  extra: Partial<OcrOutput> = {},
): OcrProvider & { calls: number } => ({
  calls: 0,
  recognize() {
    this.calls++;
    return Promise.resolve({ text, handwritten: false, illegibleFragments: 0, ...extra });
  },
});

describe('extractDocumentText', () => {
  it('reads a PDF text layer without calling OCR', async () => {
    const ocr = fakeOcr('should not be used');
    const lines = [
      'Komornik Sadowy przy Sadzie Rejonowym w Krakowie',
      'Sygn. akt Km 1234/26',
      'Zawiadomienie o zajeciu wierzytelnosci z rachunku bankowego dluznika',
    ];
    const result = await extractDocumentText(pdfWithText(lines), 'application/pdf', ocr);
    expect(result.source).toBe('pdf_text_layer');
    expect(result.text).toContain('Km 1234/26');
    expect(result.pageCount).toBe(1);
    expect(ocr.calls).toBe(0);
  });

  it('falls back to OCR for a PDF without a text layer', async () => {
    const ocr = fakeOcr(
      'Komornik Sądowy przy Sądzie Rejonowym, zawiadomienie o zajęciu wierzytelności z rachunku.',
    );
    const result = await extractDocumentText(pdfWithText([]), 'application/pdf', ocr);
    expect(result.source).toBe('ocr');
    expect(ocr.calls).toBe(1);
  });

  it('sends images to OCR, and scores them zero when no OCR is configured', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(
      (
        await extractDocumentText(
          png,
          'image/png',
          fakeOcr('Tekst ze skanu pisma w sprawie polisy i szkody komunikacyjnej.'),
        )
      ).source,
    ).toBe('ocr');
    expect(await extractDocumentText(png, 'image/png', undefined)).toMatchObject({
      quality: 0,
      text: '',
    });
  });

  it('never throws: an OCR outage or a corrupt PDF becomes an error on the result', async () => {
    const failing: OcrProvider = { recognize: () => Promise.reject(new Error('503 upstream')) };
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(await extractDocumentText(png, 'image/png', failing)).toMatchObject({
      text: '',
      quality: 0,
      error: '503 upstream',
    });
    const corrupt = await extractDocumentText(
      new TextEncoder().encode('%PDF-1.4 garbage'),
      'application/pdf',
      failing,
    );
    expect(corrupt.error).toBeDefined();
    expect(corrupt.quality).toBe(0);
  });

  it('carries the handwriting flag and the second read through to the extracted text', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const verifier = new FakeLlm(() => ({
      identifiers: [{ kind: 'IBAN', value: '61 1090 1014 0000 0712 1981 2874' }],
    }));
    const ocr = new SecondReadOcr(
      fakeOcr('Odręczne pismo w sprawie polisy, proszę o zwrot składki na rachunek.', {
        handwritten: true,
      }),
      verifier,
    );
    const r = await extractDocumentText(png, 'image/png', ocr);
    expect(r.handwritten).toBe(true);
    expect(r.secondRead).toEqual(['PL61109010140000071219812874']);
  });

  it('normalises decomposed diacritics to NFC', async () => {
    const nfd =
      'Zawiadomienie o zajęciu wierzytelności, komornik sądowy, sygnatura Km 1/26.'.normalize(
        'NFD',
      );
    const r = await extractDocumentText(new TextEncoder().encode(nfd), 'text/plain', undefined);
    expect(r.text).toBe(r.text.normalize('NFC'));
    expect(r.text).toContain('zajęciu');
  });

  it('decodes plain text as UTF-8', async () => {
    const r = await extractDocumentText(
      new TextEncoder().encode(
        'Zażółć gęślą jaźń, reklamacja polisy POL/2024/000001 z prośbą o odpowiedź.',
      ),
      'text/plain',
      undefined,
    );
    expect(r.text).toContain('Zażółć');
  });
});

describe('normaliseRead', () => {
  it('compacts values and restores the country code of a bare account number', () => {
    expect(normaliseRead('PESEL', '440514 01359')).toBe('44051401359');
    expect(normaliseRead('IBAN', 'pl61 1090 1014 0000 0712 1981 2874')).toBe(
      'PL61109010140000071219812874',
    );
  });
});

describe('textQuality', () => {
  it('scores clean Polish prose high and OCR garbage low', () => {
    expect(
      textQuality(
        'Szanowni Państwo, składam reklamację decyzji w sprawie szkody z dnia 12.10.2026 r.',
      ),
    ).toBeGreaterThan(0.9);
    expect(
      textQuality('#@%^&* ~~~ ||| }{}{ ¤¤¤ ▓▓▓ ░░ §§§ ^^^ ### @@@ *** ¬¬¬ ``` ~~~ ||| }{}{'),
    ).toBeLessThan(0.5);
    expect(textQuality('za krótko')).toBe(0);
  });
});

describe('mimeTypeFromFilename', () => {
  it('maps known extensions and rejects others', () => {
    expect(mimeTypeFromFilename('skan.JPG')).toBe('image/jpeg');
    expect(mimeTypeFromFilename('pismo.pdf')).toBe('application/pdf');
    expect(mimeTypeFromFilename('virus.exe')).toBeUndefined();
  });
});

describe('loadConfig', () => {
  it('applies defaults and coerces types', () => {
    const c = loadConfig({ PORT: '8080', LLM_ENABLED: 'false' });
    expect(c).toMatchObject({ PORT: 8080, LLM_ENABLED: false, OCR_QUALITY_FLOOR: 0.5 });
    expect(c.OPENAI_API_KEY).toBeUndefined();
  });

  it('fails fast with a readable message on bad values', () => {
    expect(() => loadConfig({ PORT: 'abc', LLM_MIN_CONFIDENCE: '7' })).toThrow(
      /PORT[\s\S]*LLM_MIN_CONFIDENCE|LLM_MIN_CONFIDENCE[\s\S]*PORT/,
    );
  });
});
