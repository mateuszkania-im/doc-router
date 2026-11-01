import { extractText, getDocumentProxy } from 'unpdf';
import type { ExtractedText } from '../domain/types.js';
import type { OcrProvider } from './ocr.js';

export const SUPPORTED_MIME_TYPES = [
  'text/plain',
  'message/rfc822',
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;
export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];

export function isSupportedMimeType(value: string): value is SupportedMimeType {
  return (SUPPORTED_MIME_TYPES as readonly string[]).includes(value);
}

export function mimeTypeFromFilename(filename: string): SupportedMimeType | undefined {
  const ext = filename.toLowerCase().split('.').pop();
  const map: Record<string, SupportedMimeType> = {
    txt: 'text/plain',
    eml: 'message/rfc822',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
  };
  return ext ? map[ext] : undefined;
}

/** A PDF page with fewer characters than this is treated as a scan without a text layer. */
const MIN_CHARS_PER_PAGE = 80;

/**
 * Cheap OCR-quality heuristic: share of characters that look like Polish prose. Garbage OCR
 * produces symbol soup and broken words. Not a substitute for the engine's own word confidences,
 * which a production OCR (Azure Document Intelligence) returns and should be used instead.
 */
export function textQuality(text: string): number {
  const compact = text.replace(/\s+/g, '');
  if (compact.length < 40) return 0;
  const letters = (compact.match(/[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż0-9.,:;()/\-§"„”]/g) ?? []).length;
  const illegible = (text.match(/\[nieczytelne\]/gi) ?? []).length;
  const words = text.split(/\s+/).filter(Boolean);
  const plausibleWords = words.filter(
    (w) => /^[\p{L}\d.,:;()/\-§"„”!?%]+$/u.test(w) && w.length <= 30,
  ).length;
  const score =
    0.5 * (letters / compact.length) + 0.5 * (plausibleWords / Math.max(words.length, 1));
  return Math.max(0, Math.min(1, score - illegible * 0.05));
}

/**
 * Never throws: an unreadable file or an OCR outage still yields a stored document with an error
 * and quality 0, which sends it to a person. Losing the letter is the one unacceptable outcome.
 * Text is NFC-normalised once here, because some PDF text layers emit decomposed diacritics that
 * would silently defeat every regex downstream.
 */
export async function extractDocumentText(
  content: Uint8Array,
  mimeType: SupportedMimeType,
  ocr: OcrProvider | undefined,
): Promise<ExtractedText> {
  try {
    const extracted = await extractUnsafe(content, mimeType, ocr);
    return { ...extracted, text: extracted.text.normalize('NFC') };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      text: '',
      source: mimeType === 'text/plain' || mimeType === 'message/rfc822' ? 'plain' : 'ocr',
      quality: 0,
      pageCount: 0,
      error: message,
    };
  }
}

async function extractUnsafe(
  content: Uint8Array,
  mimeType: SupportedMimeType,
  ocr: OcrProvider | undefined,
): Promise<ExtractedText> {
  switch (mimeType) {
    case 'text/plain':
    case 'message/rfc822': {
      const text = new TextDecoder('utf-8').decode(content);
      return { text, source: 'plain', quality: textQuality(text), pageCount: 1 };
    }
    case 'application/pdf': {
      // unpdf transfers the buffer to a worker-like context; give it its own copy.
      const pdf = await getDocumentProxy(new Uint8Array(content));
      const { totalPages, text } = await extractText(pdf, { mergePages: true });
      if (text.replace(/\s/g, '').length >= MIN_CHARS_PER_PAGE * totalPages) {
        // A real text layer is exact: no OCR cost, no OCR errors.
        return {
          text,
          source: 'pdf_text_layer',
          quality: textQuality(text),
          pageCount: totalPages,
        };
      }
      return runOcr(content, mimeType, ocr, totalPages);
    }
    case 'image/png':
    case 'image/jpeg':
    case 'image/webp':
      return runOcr(content, mimeType, ocr, 1);
  }
}

async function runOcr(
  content: Uint8Array,
  mimeType: SupportedMimeType,
  ocr: OcrProvider | undefined,
  pageCount: number,
): Promise<ExtractedText> {
  if (!ocr) {
    // No OCR configured: hand the scan to a person rather than guess.
    return { text: '', source: 'ocr', quality: 0, pageCount, error: 'no OCR provider configured' };
  }
  const read = await ocr.recognize(content, mimeType);
  return {
    text: read.text,
    source: 'ocr',
    quality: textQuality(read.text),
    pageCount,
    ...(read.handwritten ? { handwritten: true } : {}),
    ...(read.secondRead ? { secondRead: read.secondRead } : {}),
  };
}
