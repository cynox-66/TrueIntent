import type { PolicyDocument, PolicyRepository } from '@capturelock/policy';

export class InMemoryPolicyRepository implements PolicyRepository {
  private readonly rows = new Map<string, PolicyDocument>();

  private key(policyId: string, version: string): string {
    return `${policyId}@${version}`;
  }

  async insert(document: PolicyDocument): Promise<void> {
    this.rows.set(this.key(document.policyId, document.version), document);
  }

  async findByIdAndVersion(policyId: string, version: string): Promise<PolicyDocument | null> {
    return this.rows.get(this.key(policyId, version)) ?? null;
  }

  /** Test-only: replaces a stored policy in place, to model a substitution attack. */
  substitute(policyId: string, version: string, document: PolicyDocument): void {
    this.rows.set(this.key(policyId, version), document);
  }
}
