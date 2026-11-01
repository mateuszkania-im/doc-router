import type { CustomerMatch, Enrichment, Identifier, IdentifierKind } from '../domain/types.js';
import type { CoreSystems } from './core-systems.js';
import { resolveCustomer } from './match.js';

/** Values safe to look up: checksum passes and no second read contradicted them. */
const valuesOf = (ids: readonly Identifier[], kind: IdentifierKind): string[] =>
  ids
    .filter(
      (i) =>
        i.kind === kind && i.valid && (i.uncertain === undefined || i.uncertain === 'repaired'),
    )
    .map((i) => i.value);

export async function enrich(
  systems: CoreSystems,
  ids: readonly Identifier[],
  text: string,
): Promise<Enrichment> {
  const { resolution: match, candidates } = await resolveCustomer(systems, ids, text);
  const referencedClaims = (
    await Promise.all(valuesOf(ids, 'CLAIM_NUMBER').map((n) => systems.findClaim(n)))
  ).filter((c) => c !== undefined);
  const customerClaims = match ? await systems.claimsOfCustomer(match.customer.id) : [];
  const complaints = match ? await systems.complaintsOfCustomer(match.customer.id) : [];
  const courtCases = (
    await Promise.all(valuesOf(ids, 'COURT_CASE').map((n) => systems.findCourtCase(n)))
  ).filter((c) => c !== undefined);

  const openClaim = referencedClaims.find((c) => c.status === 'OPEN');
  const closedClaim = referencedClaims.find((c) => c.status === 'CLOSED');
  const payout = customerClaims.find((c) => c.status === 'OPEN' && c.pendingPayout);
  const citedNumbers = new Set(valuesOf(ids, 'COMPLAINT_NUMBER'));
  const citedOpenComplaint = complaints.find(
    (c) => c.status === 'OPEN' && citedNumbers.has(c.number),
  );
  const otherOpenComplaint = complaints.find(
    (c) => c.status === 'OPEN' && !citedNumbers.has(c.number),
  );
  const lifePolicy = match?.customer.policies.find(
    (p) => p.product === 'LIFE' && p.status === 'ACTIVE',
  );
  const court = courtCases[0];

  const customer: CustomerMatch | undefined = match && {
    customerId: match.customer.id,
    name: match.customer.name,
    matchedOn: match.matchedOn,
    flags: match.customer.flags,
    confirmedBy: match.confirmedBy,
  };

  return {
    ...(customer ? { customer } : {}),
    ...(openClaim
      ? { openClaim: { claimNumber: openClaim.number, handler: openClaim.handler } }
      : {}),
    ...(closedClaim ? { closedClaim: { claimNumber: closedClaim.number } } : {}),
    ...(payout
      ? { claimWithPendingPayout: { claimNumber: payout.number, handler: payout.handler } }
      : {}),
    ...(match?.others.length ? { otherCustomerIds: match.others } : {}),
    ...(candidates.length ? { candidates } : {}),
    ...(citedOpenComplaint
      ? { citedOpenComplaint: { complaintNumber: citedOpenComplaint.number } }
      : {}),
    ...(otherOpenComplaint
      ? { otherOpenComplaint: { complaintNumber: otherOpenComplaint.number } }
      : {}),
    ...(court ? { knownCourtCase: { caseNumber: court.caseNumber, owner: court.owner } } : {}),
    ...(lifePolicy ? { activeLifePolicy: { policyNumber: lifePolicy.number } } : {}),
  };
}
