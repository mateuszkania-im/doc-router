/**
 * Maps over items with at most `size` calls in flight, preserving order. Enough to keep a provider
 * busy without tripping its rate limits; the SDK's own retries handle the occasional 429.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  size: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T, i);
      }
    }),
  );
  return out;
}
