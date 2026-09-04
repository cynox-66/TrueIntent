import type { PolicyDocument, PolicyRepository } from '@capturelock/policy';

/**
 * In-memory policy store.
 *
 * `insert` keeps the stored document when the same (id, version) arrives again,
 * matching the `ON CONFLICT DO NOTHING` in the SQL. That is a security
 * behaviour, not a storage detail: an authorization is bound to its policy by
 * hash at issuance, and the kernel refuses when the loaded document no longer
 * hashes to that value. A store that let a re-insert quietly replace the rules
 * would be performing the substitution the hash check exists to detect — and
 * the offline suite would never see it, because Postgres refuses.
 *
 * `substitute` remains, and is the only way to model that attack. It is
 * test-only and named so it cannot be reached by accident.
 */
export class InMemoryPolicyRepository implements PolicyRepository {
  private readonly rows = new Map<string, PolicyDocument>();

  private key(policyId: string, version: string): string {
    return `${policyId}@${version}`;
  }

  async insert(document: PolicyDocument): Promise<void> {
    const key = this.key(document.policyId, document.version);
    if (this.rows.has(key)) return;
    this.rows.set(key, document);
  }

  async findByIdAndVersion(policyId: string, version: string): Promise<PolicyDocument | null> {
    return this.rows.get(this.key(policyId, version)) ?? null;
  }

  /** Test-only: replaces a stored policy in place, to model a substitution attack. */
  substitute(policyId: string, version: string, document: PolicyDocument): void {
    this.rows.set(this.key(policyId, version), document);
  }
}
