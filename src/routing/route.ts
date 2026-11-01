import { CLASS_DEFINITIONS, isCritical, type DocumentClass } from '../domain/classes.js';
import type {
  Classification,
  Enrichment,
  Extraction,
  Priority,
  ReviewReason,
  RoutingDecision,
} from '../domain/types.js';

export const QUEUES = {
  MANUAL_CLASSIFICATION: 'manual-classification',
  CRITICAL_REVIEW: 'critical-review',
  FRAUD: 'fraud',
  ENFORCEMENT: 'enforcement',
  ENFORCEMENT_NOT_CUSTOMER: 'enforcement-not-a-customer',
  LEGAL: 'legal',
  COMPLAINTS: 'complaints',
  REGULATORY: 'regulatory',
  LAW_ENFORCEMENT: 'law-enforcement-restricted',
  DATA_PROTECTION: 'data-protection-officer',
  LIFE_CLAIMS: 'life-claims',
  CUSTOMER_SERVICE: 'customer-service',
  POLICY_ADMIN: 'policy-admin',
  CLAIMS_INTAKE: 'claims-intake',
  CLAIMS_APPEALS: 'claims-appeals',
  ACCOUNTS_PAYABLE: 'accounts-payable',
} as const;

const claimHandlerQueue = (handler: string): string => `claim-handler:${handler}`;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The clock starts at receipt, not at routing: a seizure is effective the moment it is delivered. */
export function deadlineFor(label: DocumentClass, receivedAt: Date): Date | undefined {
  const days = CLASS_DEFINITIONS[label].deadlineDays;
  return days === undefined ? undefined : new Date(receivedAt.getTime() + days * DAY_MS);
}

function earliest(dates: readonly (Date | undefined)[]): Date | undefined {
  const defined = dates.filter((d): d is Date => d !== undefined);
  return defined.length ? new Date(Math.min(...defined.map((d) => d.getTime()))) : undefined;
}

interface Target {
  readonly queue: string;
  readonly reasons: readonly string[];
  readonly alerts?: readonly string[];
}

/** Business rules. Text says what a letter is; core systems say what to do with it. */
function targetFor(label: DocumentClass, extraction: Extraction, e: Enrichment): Target {
  switch (label) {
    case 'BAILIFF_SEIZURE':
    case 'BAILIFF_INQUIRY': {
      if (!e.customer) {
        return {
          queue: QUEUES.ENFORCEMENT_NOT_CUSTOMER,
          reasons: [
            'debtor not found in customer base: "not a customer" reply template, human approves',
          ],
        };
      }
      const alerts =
        label === 'BAILIFF_SEIZURE' && e.claimWithPendingPayout
          ? [
              `hold payout on claim ${e.claimWithPendingPayout.claimNumber}: notify handler ${e.claimWithPendingPayout.handler}`,
            ]
          : [];
      return {
        queue: QUEUES.ENFORCEMENT,
        reasons: [
          `debtor is customer ${e.customer.customerId} (matched on ${e.customer.matchedOn})`,
        ],
        alerts,
      };
    }
    case 'COURT_LETTER':
      return e.knownCourtCase
        ? {
            queue: QUEUES.LEGAL,
            reasons: [`known case ${e.knownCourtCase.caseNumber}, owner ${e.knownCourtCase.owner}`],
          }
        : {
            queue: QUEUES.LEGAL,
            reasons: ['unknown case number: open a new legal case'],
            alerts: ['new court case with a running deadline'],
          };
    case 'COMPLAINT':
      if (extraction.senderType === 'LAW_FIRM') {
        return { queue: QUEUES.LEGAL, reasons: ['complaint sent by a law firm: pre-litigation'] };
      }
      if (e.citedOpenComplaint) {
        return {
          queue: QUEUES.COMPLAINTS,
          reasons: [
            `cites open complaint ${e.citedOpenComplaint.complaintNumber}: attach as a supplement`,
          ],
        };
      }
      // Without a cited number it is a new complaint with its own statutory clock, even if the
      // customer has another one open.
      return {
        queue: QUEUES.COMPLAINTS,
        reasons: ['new complaint'],
        ...(e.otherOpenComplaint
          ? { alerts: [`customer also has open complaint ${e.otherOpenComplaint.complaintNumber}`] }
          : {}),
      };
    case 'REGULATOR_LETTER':
      return {
        queue: QUEUES.REGULATORY,
        reasons: ['regulator letter'],
        ...((e.citedOpenComplaint ?? e.otherOpenComplaint)
          ? {
              alerts: [
                `related complaint ${(e.citedOpenComplaint ?? e.otherOpenComplaint)?.complaintNumber ?? ''}`,
              ],
            }
          : {}),
      };
    case 'LAW_ENFORCEMENT_REQUEST':
      return {
        queue: QUEUES.LAW_ENFORCEMENT,
        reasons: ['bank or insurance secrecy: restricted team only'],
      };
    case 'GDPR_REQUEST':
      return { queue: QUEUES.DATA_PROTECTION, reasons: ['data subject request'] };
    case 'DEATH_NOTIFICATION':
      return e.activeLifePolicy
        ? {
            queue: QUEUES.LIFE_CLAIMS,
            reasons: [`active life policy ${e.activeLifePolicy.policyNumber}: open a death claim`],
          }
        : {
            queue: QUEUES.CUSTOMER_SERVICE,
            reasons: ['no active life policy found: deceased customer handling'],
          };
    case 'CONTRACT_WITHDRAWAL':
      return { queue: QUEUES.POLICY_ADMIN, reasons: ['withdrawal: refund and close'] };
    case 'CLAIM_NOTIFICATION':
      return { queue: QUEUES.CLAIMS_INTAKE, reasons: ['new claim'] };
    case 'CLAIM_DOCUMENTS':
      if (e.openClaim)
        return {
          queue: claimHandlerQueue(e.openClaim.handler),
          reasons: [`documents for open claim ${e.openClaim.claimNumber}: straight to its handler`],
        };
      if (e.closedClaim)
        return {
          queue: QUEUES.CLAIMS_APPEALS,
          reasons: [`documents for closed claim ${e.closedClaim.claimNumber}: reopening or appeal`],
        };
      return {
        queue: QUEUES.CLAIMS_INTAKE,
        reasons: ['claim documents without a known claim number'],
      };
    case 'CONTRACT_TERMINATION':
      return { queue: QUEUES.POLICY_ADMIN, reasons: ['termination'] };
    case 'PERSONAL_DATA_CHANGE': {
      const ibanChange = extraction.identifiers.some((i) => i.kind === 'IBAN');
      return {
        queue: QUEUES.CUSTOMER_SERVICE,
        reasons: ['personal data change'],
        ...(ibanChange ? { alerts: ['bank account change: verify identity before applying'] } : {}),
      };
    }
    case 'POWER_OF_ATTORNEY':
      return { queue: QUEUES.CUSTOMER_SERVICE, reasons: ['power of attorney'] };
    case 'INVOICE':
      return { queue: QUEUES.ACCOUNTS_PAYABLE, reasons: ['supplier invoice'] };
    case 'OTHER':
      return { queue: QUEUES.MANUAL_CLASSIFICATION, reasons: ['no known class'] };
  }
}

const REVIEW_REASON_TEXT: Readonly<Record<ReviewReason, string>> = {
  low_ocr_quality: 'OCR quality below floor',
  text_extraction_failed: 'file could not be read',
  cascade_abstained: 'no stage was confident enough',
  safety_net_conflict: 'critical keyword found that the label does not explain',
  model_conflict: 'local model and LLM disagree',
  suspicious_instructions: 'text contains instructions aimed at the model',
  ungrounded_evidence: 'LLM evidence quote not found in the document',
  ambiguous_customer: 'identifiers in the letter point to different customers',
  unconfirmed_customer:
    'customer found through one reference without a check digit, nothing else confirms it',
  invalid_identifier: 'identifier with a failing checksum',
  unverified_identifier: 'identifier not confirmed by a second read',
};

export function route(
  classification: Classification,
  extraction: Extraction,
  enrichment: Enrichment,
  receivedAt: Date,
): RoutingDecision {
  const reviewReasons = new Set(classification.reviewReasons);
  const hasInvalidId = extraction.identifiers.some((i) => !i.valid);
  const unverified = extraction.identifiers.filter(
    (i) =>
      i.uncertain === 'unconfirmed_by_second_read' || i.uncertain === 'handwritten_single_read',
  );
  if (hasInvalidId && !enrichment.customer) reviewReasons.add('invalid_identifier');
  if (unverified.length && !enrichment.customer) reviewReasons.add('unverified_identifier');
  if (enrichment.otherCustomerIds?.length) reviewReasons.add('ambiguous_customer');
  if (enrichment.customer && enrichment.customer.confirmedBy.length === 0)
    reviewReasons.add('unconfirmed_customer');

  const label = classification.label ?? classification.suggestedLabel;
  const alerts: string[] = [];
  const reasons: string[] = [];

  if (hasInvalidId) {
    const bad = extraction.identifiers.filter((i) => !i.valid).map((i) => `${i.kind} ${i.value}`);
    alerts.push(`failing checksum, not used for matching: ${bad.join(', ')}`);
  }
  if (unverified.length) {
    alerts.push(
      `not confirmed by a second read, not used for matching: ${unverified.map((i) => `${i.kind} ${i.value}`).join(', ')}`,
    );
  }
  const repaired = extraction.identifiers.filter((i) => i.uncertain === 'repaired');
  if (repaired.length) {
    alerts.push(
      `letters read as digits and repaired: ${repaired.map((i) => `${i.kind} ${i.value}`).join(', ')}`,
    );
  }

  const criticalInPlay = [
    ...classification.safetyNet,
    ...(label && isCritical(label) ? [label] : []),
  ];
  const deadline = earliest(
    criticalInPlay.length
      ? criticalInPlay.map((c) => deadlineFor(c, receivedAt))
      : [label ? deadlineFor(label, receivedAt) : undefined],
  );

  const fraud = enrichment.customer?.flags.includes('FRAUD') ?? false;
  if (fraud) alerts.push(`customer ${enrichment.customer?.customerId ?? ''} carries a fraud flag`);

  const requiresHumanReview = classification.label === null || reviewReasons.size > 0;
  let queue: string;
  let priority: Priority;

  // Alerts of the proposed route survive every branch: documents under review or held for fraud
  // are exactly the risky ones, and a payout hold must not wait for the reviewer.
  const proposed = label ? targetFor(label, extraction, enrichment) : undefined;

  if (fraud) {
    queue = QUEUES.FRAUD;
    priority = 'P1';
    reasons.push('fraud flag overrides normal routing');
    if (proposed && label) reasons.push(`proposed: ${label}, queue ${proposed.queue}`);
    alerts.push(...(proposed?.alerts ?? []));
  } else if (requiresHumanReview) {
    // A letter nobody could read might carry a deadline; treat it as critical until a person looks.
    const unreadable =
      reviewReasons.has('text_extraction_failed') || reviewReasons.has('low_ocr_quality');
    const urgent = criticalInPlay.length > 0 || unreadable;
    queue = urgent ? QUEUES.CRITICAL_REVIEW : QUEUES.MANUAL_CLASSIFICATION;
    priority = urgent ? 'P1' : 'P2';
    reasons.push(
      `human review: ${[...reviewReasons].map((r) => REVIEW_REASON_TEXT[r]).join('; ')}`,
    );
    if (proposed && label) reasons.push(`proposed: ${label}, queue ${proposed.queue}`);
    alerts.push(...(proposed?.alerts ?? []));
  } else {
    const target = proposed ?? targetFor('OTHER', extraction, enrichment);
    queue = target.queue;
    priority = label && isCritical(label) ? 'P1' : label === 'INVOICE' ? 'P3' : 'P2';
    reasons.push(
      `${label ?? 'OTHER'} decided by ${classification.decidedBy ?? 'nobody'}`,
      ...target.reasons,
    );
    alerts.push(...(target.alerts ?? []));
  }

  if (deadline) reasons.push(`deadline counted from receipt (${receivedAt.toISOString()})`);

  return {
    queue,
    priority,
    ...(deadline ? { deadline } : {}),
    alerts,
    reasons,
    requiresHumanReview,
  };
}
