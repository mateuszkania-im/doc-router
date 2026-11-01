/**
 * Polish is heavily inflected ("zajęcie", "zajęciu", "zajęcia"), so a crude prefix stem gets most
 * of what a real lemmatiser would at zero cost. Bigrams keep short phrases such as "nakaz zapłaty".
 */
const STEM_LENGTH = 6;

export function tokenize(text: string): string[] {
  const words = text
    .toLowerCase()
    .normalize('NFC')
    .match(/[a-ząćęłńóśźż]{2,}/g);
  if (!words) return [];
  const stems = words.map((w) => w.slice(0, STEM_LENGTH));
  const bigrams = stems.slice(1).map((s, i) => `${stems[i] ?? ''}_${s}`);
  return [...stems, ...bigrams];
}

export interface Vectorizer {
  readonly vocabulary: readonly string[];
  readonly idf: readonly number[];
}

/** Sparse vector as parallel arrays, L2-normalised. */
export interface SparseVector {
  readonly indices: readonly number[];
  readonly values: readonly number[];
}

export function fitVectorizer(documents: readonly string[], minDocumentFrequency = 2): Vectorizer {
  const df = new Map<string, number>();
  for (const doc of documents) {
    for (const term of new Set(tokenize(doc))) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const vocabulary = [...df.entries()]
    .filter(([, count]) => count >= minDocumentFrequency)
    .map(([term]) => term)
    .sort();
  const n = documents.length;
  const idf = vocabulary.map((t) => Math.log((1 + n) / (1 + (df.get(t) ?? 0))) + 1);
  return { vocabulary, idf };
}

export function buildIndex(vectorizer: Vectorizer): Map<string, number> {
  return new Map(vectorizer.vocabulary.map((t, i) => [t, i]));
}

export function vectorize(
  text: string,
  vectorizer: Vectorizer,
  index: ReadonlyMap<string, number>,
): SparseVector {
  const counts = new Map<number, number>();
  for (const term of tokenize(text)) {
    const i = index.get(term);
    if (i !== undefined) counts.set(i, (counts.get(i) ?? 0) + 1);
  }
  const indices = [...counts.keys()].sort((a, b) => a - b);
  const raw = indices.map((i) => (1 + Math.log(counts.get(i) ?? 1)) * (vectorizer.idf[i] ?? 0));
  const norm = Math.hypot(...raw) || 1;
  return { indices, values: raw.map((v) => v / norm) };
}
