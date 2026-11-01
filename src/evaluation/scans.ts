import { z } from 'zod';

/** One rendered test letter: the image file plus the ground truth it was rendered from. */
export const ScanEntrySchema = z.object({
  file: z.string(),
  id: z.string(),
  label: z.string(),
  style: z.enum(['typed_scan', 'phone_photo', 'handwritten']),
  text: z.string(),
  tags: z.array(z.string()),
});
export type ScanEntry = z.infer<typeof ScanEntrySchema>;
