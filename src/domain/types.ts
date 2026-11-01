import { z } from 'zod';
import { DocumentClassSchema, type DocumentClass } from './classes.js';

export const ChannelSchema = z.enum([
  'OGNIVO',
  'E_DORECZENIA',
  'EMAIL',
  'PAPER_SCAN',
  'CUSTOMER_PORTAL',
  'UNKNOWN',
]);
export type Channel = z.infer<typeof ChannelSchema>;

export interface IncomingDocument {
  readonly id: string;
  readonly channel: Channel;
  readonly receivedAt: Date;
  readonly filename: string;
  readonly mimeType: string;
  readonly content: Uint8Array;
  /** Document type declared by a structured channel (OGNIVO message type, e-Doręczenia metadata). */
  readonly declaredClass?: DocumentClass;
}

export type TextSource = 'plain' | 'pdf_text_layer' | 'ocr';

export interface ExtractedText {
  readonly text: string;
  readonly source: TextSource;
  /** 0..1 heuristic. Below the configured floor the document goes straight to a human. */
  readonly quality: number;
  readonly pageCount: number;
  /** Set when the file could not be read; the document is still stored and goes to a human. */
  readonly error?: string;
  /** The OCR saw handwriting. Identifiers then need a second, agreeing read before they are trusted. */
  readonly handwritten?: boolean;
  /**
   * Identifier values as read by an independent second OCR pass. Present only when a second read
   * ran; an identifier in the text that this list does not confirm is treated as unverified.
   */
  readonly secondRead?: readonly string[];
}

export type Stage = 'channel' | 'rules' | 'local_model' | 'llm';

export interface StageTrace {
  readonly stage: Stage;
  readonly outcome: 'decided' | 'abstained' | 'skipped';
  readonly label?: DocumentClass;
  readonly confidence?: number;
  readonly detail: string;
  readonly durationMs: number;
}

export type ReviewReason =
  | 'low_ocr_quality'
  | 'text_extraction_failed'
  | 'cascade_abstained'
  | 'safety_net_conflict'
  | 'model_conflict'
  | 'suspicious_instructions'
  | 'ungrounded_evidence'
  | 'ambiguous_customer'
  | 'unconfirmed_customer'
  | 'invalid_identifier'
  | 'unverified_identifier';

export interface Classification {
  /** Null when no stage was confident enough; the document then goes to manual classification. */
  readonly label: DocumentClass | null;
  readonly decidedBy: Stage | null;
  readonly confidence: number;
  /** Best guess shown to the reviewer when no stage was confident enough to decide. */
  readonly suggestedLabel: DocumentClass | null;
  readonly evidence?: string;
  /** Critical classes that the keyword safety net saw in the text, independent of the final label. */
  readonly safetyNet: readonly DocumentClass[];
  readonly reviewReasons: readonly ReviewReason[];
  readonly trace: readonly StageTrace[];
}

export type IdentifierKind =
  | 'PESEL'
  | 'NIP'
  | 'REGON'
  | 'IBAN'
  | 'POLICY_NUMBER'
  | 'CLAIM_NUMBER'
  | 'COMPLAINT_NUMBER'
  | 'BAILIFF_CASE'
  | 'COURT_CASE';

export interface Identifier {
  readonly kind: IdentifierKind;
  readonly value: string;
  /** False when a checksum exists for the kind and it does not match. Never route on an invalid one. */
  readonly valid: boolean;
  /**
   * Why the value cannot be taken at face value even though it parses: letters that OCR confuses
   * with digits were repaired ("POL/2024/O278I1"), the second OCR read did not confirm it, or it
   * comes from handwriting that only one read has seen.
   */
  readonly uncertain?: 'repaired' | 'unconfirmed_by_second_read' | 'handwritten_single_read';
}

export type SenderType =
  | 'BAILIFF'
  | 'COURT'
  | 'PROSECUTOR_OR_POLICE'
  | 'REGULATOR'
  | 'LAW_FIRM'
  | 'TAX_OR_SOCIAL_SECURITY'
  | 'COMPANY'
  | 'INDIVIDUAL';

export interface Extraction {
  readonly identifiers: readonly Identifier[];
  readonly senderType: SenderType;
}

export interface CustomerMatch {
  readonly customerId: string;
  readonly name: string;
  readonly matchedOn: IdentifierKind;
  readonly flags: readonly string[];
  /**
   * What independently confirms the match. Empty means the letter points at this customer through
   * a single reference without a check digit, which one OCR slip can turn into another customer.
   */
  readonly confirmedBy: readonly MatchFactor[];
}

export type MatchFactor = 'checksummed_identifier' | 'second_reference' | 'name_in_letter';

/** A customer the reviewer should consider, and why. Shown next to the letter in the console. */
export interface CustomerCandidate {
  readonly customerId: string;
  readonly name: string;
  readonly evidence: readonly string[];
}

export interface Enrichment {
  readonly customer?: CustomerMatch;
  /** Other customers matched by other identifiers in the same letter (debtor and creditor, etc.). */
  readonly otherCustomerIds?: readonly string[];
  /** Set when the match is not confirmed or is contested: everyone the letter could be about. */
  readonly candidates?: readonly CustomerCandidate[];
  readonly openClaim?: { readonly claimNumber: string; readonly handler: string };
  readonly closedClaim?: { readonly claimNumber: string };
  readonly claimWithPendingPayout?: { readonly claimNumber: string; readonly handler: string };
  /** An open complaint whose number the letter itself cites. */
  readonly citedOpenComplaint?: { readonly complaintNumber: string };
  /** Some other open complaint of the same customer; related maybe, but not proof. */
  readonly otherOpenComplaint?: { readonly complaintNumber: string };
  readonly knownCourtCase?: { readonly caseNumber: string; readonly owner: string };
  readonly activeLifePolicy?: { readonly policyNumber: string };
}

export type Priority = 'P1' | 'P2' | 'P3';

export interface RoutingDecision {
  readonly queue: string;
  readonly priority: Priority;
  readonly deadline?: Date;
  readonly alerts: readonly string[];
  /** Ordered, human-readable reasons. Shown in the review UI so routing is never a black box. */
  readonly reasons: readonly string[];
  readonly requiresHumanReview: boolean;
}

export interface ProcessedDocument {
  readonly id: string;
  readonly channel: Channel;
  readonly receivedAt: Date;
  readonly filename: string;
  readonly text: ExtractedText;
  readonly classification: Classification;
  readonly extraction: Extraction;
  readonly enrichment: Enrichment;
  readonly routing: RoutingDecision;
  readonly processingMs: number;
}

export const LabelledExampleSchema = z.object({
  id: z.string(),
  label: DocumentClassSchema,
  text: z.string().min(1),
  tags: z.array(z.string()).default([]),
});
export type LabelledExample = z.infer<typeof LabelledExampleSchema>;
