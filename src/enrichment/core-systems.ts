import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const PolicySchema = z.object({
  number: z.string(),
  product: z.enum(['LIFE', 'MOTOR', 'PROPERTY', 'BANK_ACCOUNT']),
  status: z.enum(['ACTIVE', 'TERMINATED']),
});

const CustomerSchema = z.object({
  id: z.string(),
  name: z.string(),
  pesel: z.string().optional(),
  nip: z.string().optional(),
  ibans: z.array(z.string()).default([]),
  policies: z.array(PolicySchema).default([]),
  flags: z.array(z.enum(['FRAUD', 'VIP', 'VULNERABLE'])).default([]),
});

const ClaimSchema = z.object({
  number: z.string(),
  customerId: z.string(),
  status: z.enum(['OPEN', 'CLOSED']),
  handler: z.string(),
  pendingPayout: z.boolean().default(false),
});

const ComplaintSchema = z.object({
  number: z.string(),
  customerId: z.string(),
  status: z.enum(['OPEN', 'CLOSED']),
});

const CourtCaseSchema = z.object({ caseNumber: z.string(), owner: z.string() });

export const CoreSystemsFixtureSchema = z.object({
  customers: z.array(CustomerSchema),
  claims: z.array(ClaimSchema).default([]),
  complaints: z.array(ComplaintSchema).default([]),
  courtCases: z.array(CourtCaseSchema).default([]),
});

export type Customer = z.infer<typeof CustomerSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type Complaint = z.infer<typeof ComplaintSchema>;
export type CourtCase = z.infer<typeof CourtCaseSchema>;
export type CoreSystemsFixture = z.infer<typeof CoreSystemsFixtureSchema>;

/**
 * Read-only view of CRM, policy admin, claims, complaints and legal systems. Async on purpose:
 * the real thing is a set of network calls, and the router must not care.
 */
export interface CoreSystems {
  findCustomerByPesel(pesel: string): Promise<Customer | undefined>;
  findCustomerByNip(nip: string): Promise<Customer | undefined>;
  findCustomerByIban(iban: string): Promise<Customer | undefined>;
  findCustomerByPolicy(policyNumber: string): Promise<Customer | undefined>;
  findClaim(claimNumber: string): Promise<Claim | undefined>;
  claimsOfCustomer(customerId: string): Promise<readonly Claim[]>;
  findComplaint(complaintNumber: string): Promise<Complaint | undefined>;
  complaintsOfCustomer(customerId: string): Promise<readonly Complaint[]>;
  findCustomer(customerId: string): Promise<Customer | undefined>;
  findCourtCase(caseNumber: string): Promise<CourtCase | undefined>;
}

const compactIban = (iban: string): string => iban.replace(/\s/g, '').toUpperCase();

export class InMemoryCoreSystems implements CoreSystems {
  constructor(private readonly data: CoreSystemsFixture) {}

  static async fromFile(path: string): Promise<InMemoryCoreSystems> {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    return new InMemoryCoreSystems(CoreSystemsFixtureSchema.parse(raw));
  }

  findCustomerByPesel(pesel: string): Promise<Customer | undefined> {
    return Promise.resolve(this.data.customers.find((c) => c.pesel === pesel));
  }
  findCustomerByNip(nip: string): Promise<Customer | undefined> {
    return Promise.resolve(this.data.customers.find((c) => c.nip === nip));
  }
  findCustomerByIban(iban: string): Promise<Customer | undefined> {
    const wanted = compactIban(iban);
    return Promise.resolve(
      this.data.customers.find((c) => c.ibans.some((i) => compactIban(i) === wanted)),
    );
  }
  findCustomerByPolicy(policyNumber: string): Promise<Customer | undefined> {
    return Promise.resolve(
      this.data.customers.find((c) => c.policies.some((p) => p.number === policyNumber)),
    );
  }
  findClaim(claimNumber: string): Promise<Claim | undefined> {
    return Promise.resolve(this.data.claims.find((c) => c.number === claimNumber));
  }
  claimsOfCustomer(customerId: string): Promise<readonly Claim[]> {
    return Promise.resolve(this.data.claims.filter((c) => c.customerId === customerId));
  }
  findComplaint(complaintNumber: string): Promise<Complaint | undefined> {
    return Promise.resolve(this.data.complaints.find((c) => c.number === complaintNumber));
  }
  complaintsOfCustomer(customerId: string): Promise<readonly Complaint[]> {
    return Promise.resolve(this.data.complaints.filter((c) => c.customerId === customerId));
  }
  findCustomer(customerId: string): Promise<Customer | undefined> {
    return Promise.resolve(this.data.customers.find((c) => c.id === customerId));
  }
  findCourtCase(caseNumber: string): Promise<CourtCase | undefined> {
    return Promise.resolve(this.data.courtCases.find((c) => c.caseNumber === caseNumber));
  }
}
