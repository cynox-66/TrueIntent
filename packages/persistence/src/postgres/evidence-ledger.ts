/**
 * Postgres evidence ledger.
 *
 * Appending takes an advisory lock on the chain for the duration of the
 * transaction. Without it, two concurrent appends would both read sequence N
 * and both write N+1 — forking the chain into two branches that no verifier
 * could reconcile. The `UNIQUE (chain_id, sequence)` constraint is the backstop
 * that turns a lock failure into a rejected write rather than a corrupt ledger.
 *
 * The table also carries triggers rejecting UPDATE and DELETE outright, so
 * "append-only" is a property of the database rather than a habit of the code.
 */

import {
  GENESIS_CHAIN_HASH,
  sealEnvelope,
  verifyChain,
  type AppendEvidenceRequest,
  type ChainVerification,
  type EnvelopeKind,
  type EvidenceEnvelope,
  type EvidenceLedger,
  type EvidenceSigner,
  type EvidenceVerifier,
} from '@capturelock/evidence';
import { asSha256Hex, newEnvelopeId, timestampFromDate, type Sha256Hex } from '@capturelock/core';
import { Database, type Queryable } from './client.js';

interface EnvelopeRow extends Record<string, unknown> {
  envelope_id: string;
  chain_id: string;
  sequence: string;
  prev_chain_hash: string;
  chain_hash: string;
  signature: string;
  public_key_id: string;
  kind: string;
  payload: unknown;
  created_at: Date;
}

function toEnvelope(row: EnvelopeRow): EvidenceEnvelope {
  return {
    envelopeId: row.envelope_id,
    chainId: row.chain_id,
    sequence: Number(row.sequence),
    prevChainHash: asSha256Hex(row.prev_chain_hash),
    chainHash: asSha256Hex(row.chain_hash),
    signature: row.signature,
    publicKeyId: row.public_key_id,
    recordedAt: timestampFromDate(row.created_at),
    kind: row.kind as EnvelopeKind,
    body: row.payload,
  };
}

/** Stable 64-bit key for the per-chain advisory lock. */
function lockKey(chainId: string): string {
  let hash = 0n;
  for (const char of chainId) {
    hash = (hash * 131n + BigInt(char.charCodeAt(0))) % 9_223_372_036_854_775_807n;
  }
  return hash.toString();
}

export class PostgresEvidenceLedger implements EvidenceLedger {
  private readonly ownsTransaction: boolean;

  constructor(
    private readonly db: Queryable | Database,
    private readonly signer: EvidenceSigner,
    private readonly verifier: EvidenceVerifier,
    options: { readonly ownsTransaction?: boolean } = {},
  ) {
    // When built inside a unit of work the enclosing transaction is already
    // open, and opening another would either nest (unsupported) or, worse, run
    // the append on a different connection and commit independently.
    this.ownsTransaction = options.ownsTransaction ?? true;
  }

  async append(request: AppendEvidenceRequest): Promise<EvidenceEnvelope> {
    if (!this.ownsTransaction) return this.appendOn(this.db, request);
    return (this.db as Database).transaction(async client =>
      this.appendOn(Database.queryableOf(client), request),
    );
  }

  private async appendOn(db: Queryable, request: AppendEvidenceRequest): Promise<EvidenceEnvelope> {
    {
      // Serializes appends to this chain for the life of the transaction. Two
      // writers cannot both read the same head.
      await db.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey(request.chainId)]);

      const headRows = await db.query<{ sequence: string; chain_hash: string }>(
        `SELECT sequence, chain_hash FROM evidence_envelopes
         WHERE chain_id = $1 ORDER BY sequence DESC LIMIT 1`,
        [request.chainId],
      );

      const previous = headRows[0];
      const sealed = sealEnvelope(
        {
          envelopeId: newEnvelopeId(),
          chainId: request.chainId,
          sequence: previous === undefined ? 0 : Number(previous.sequence) + 1,
          prevChainHash:
            previous === undefined ? GENESIS_CHAIN_HASH : asSha256Hex(previous.chain_hash),
          recordedAt: request.recordedAt,
          kind: request.kind,
          body: request.body,
        },
        this.signer,
      );

      await db.query(
        `INSERT INTO evidence_envelopes (
           envelope_id, chain_id, sequence, prev_chain_hash, chain_hash,
           signature, public_key_id, kind, payload, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
        [
          sealed.envelopeId,
          sealed.chainId,
          sealed.sequence,
          sealed.prevChainHash,
          sealed.chainHash,
          sealed.signature,
          sealed.publicKeyId,
          sealed.kind,
          JSON.stringify(sealed.body ?? null),
          sealed.recordedAt,
        ],
      );

      return sealed;
    }
  }

  async findById(envelopeId: string): Promise<EvidenceEnvelope | null> {
    const rows = await this.db.query<EnvelopeRow>(
      `SELECT * FROM evidence_envelopes WHERE envelope_id = $1`,
      [envelopeId],
    );
    return rows.length === 0 ? null : toEnvelope(rows[0]!);
  }

  async listByChain(chainId: string): Promise<readonly EvidenceEnvelope[]> {
    const rows = await this.db.query<EnvelopeRow>(
      `SELECT * FROM evidence_envelopes WHERE chain_id = $1 ORDER BY sequence ASC`,
      [chainId],
    );
    return rows.map(toEnvelope);
  }

  async head(chainId: string): Promise<{ sequence: number; chainHash: Sha256Hex } | null> {
    const rows = await this.db.query<{ sequence: string; chain_hash: string }>(
      `SELECT sequence, chain_hash FROM evidence_envelopes
       WHERE chain_id = $1 ORDER BY sequence DESC LIMIT 1`,
      [chainId],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : { sequence: Number(row.sequence), chainHash: asSha256Hex(row.chain_hash) };
  }

  async verifyChain(chainId: string, expectedHead?: Sha256Hex): Promise<ChainVerification> {
    return verifyChain(await this.listByChain(chainId), this.verifier, expectedHead);
  }
}
