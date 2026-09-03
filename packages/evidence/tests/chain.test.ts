import { describe, it, expect } from 'vitest';
import { asTimestamp, type Timestamp } from '@capturelock/core';
import {
  GENESIS_CHAIN_HASH,
  computeChainHash,
  sealEnvelope,
  verifyChain,
  type EvidenceEnvelope,
} from '../src/envelope.js';
import { createSigner, createVerifier, generateEvidenceKeyPair } from '../src/signing.js';

const keys = generateEvidenceKeyPair();
const signer = createSigner(keys.privateKeyPkcs8Base64);
const verifier = createVerifier(keys.publicKeySpkiBase64);

const AT = asTimestamp('2026-09-03T10:00:00.000Z');

function buildChain(length: number, chainId = 'chn_test'): EvidenceEnvelope[] {
  const out: EvidenceEnvelope[] = [];
  let prev = GENESIS_CHAIN_HASH;
  for (let i = 0; i < length; i += 1) {
    const sealed = sealEnvelope(
      {
        envelopeId: `env_${String(i).padStart(3, '0')}`,
        chainId,
        sequence: i,
        prevChainHash: prev,
        recordedAt: AT,
        kind: 'DECISION',
        body: { verdict: i % 2 === 0 ? 'ALLOW' : 'DENY', index: i },
      },
      signer,
    );
    out.push(sealed);
    prev = sealed.chainHash;
  }
  return out;
}

describe('signing', () => {
  it('produces a signature that verifies under the matching public key', () => {
    const payload = Buffer.from('capturelock', 'utf8');
    expect(verifier.verify(payload, signer.sign(payload))).toBe(true);
  });

  it('rejects a signature from a different key', () => {
    const other = createSigner(generateEvidenceKeyPair().privateKeyPkcs8Base64);
    const payload = Buffer.from('capturelock', 'utf8');
    expect(verifier.verify(payload, other.sign(payload))).toBe(false);
  });

  it('treats a malformed signature as a failure rather than throwing', () => {
    expect(verifier.verify(Buffer.from('x'), 'not-base64-!!!')).toBe(false);
    expect(verifier.verify(Buffer.from('x'), '')).toBe(false);
  });

  it('derives a stable key id shared by signer and verifier', () => {
    expect(signer.publicKeyId).toBe(verifier.publicKeyId);
    expect(signer.publicKeyId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('refuses a non-Ed25519 key', () => {
    expect(() => createSigner('not-a-key')).toThrow();
  });
});

describe('verifyChain on an intact chain', () => {
  it('accepts a well-formed chain', () => {
    const result = verifyChain(buildChain(5), verifier);
    expect(result.valid).toBe(true);
    expect(result.defects).toEqual([]);
    expect(result.verifiedCount).toBe(5);
  });

  it('accepts entries presented out of order, since sequence defines the order', () => {
    const chain = buildChain(5);
    const shuffled = [chain[3]!, chain[0]!, chain[4]!, chain[1]!, chain[2]!];
    expect(verifyChain(shuffled, verifier).valid).toBe(true);
  });

  it('matches an independently held head', () => {
    const chain = buildChain(3);
    const head = chain[2]!.chainHash;
    expect(verifyChain(chain, verifier, head).valid).toBe(true);
  });
});

describe('tamper detection', () => {
  it('detects a modified payload and names the offending entry', () => {
    const chain = buildChain(5);
    const tampered = [...chain];
    tampered[2] = { ...chain[2]!, body: { verdict: 'ALLOW', index: 2, injected: true } };

    const result = verifyChain(tampered, verifier);
    expect(result.valid).toBe(false);
    expect(result.defects.map(d => d.kind)).toContain('PAYLOAD_MODIFIED');
    expect(result.defects.find(d => d.kind === 'PAYLOAD_MODIFIED')?.sequence).toBe(2);
  });

  it('detects a verdict flipped from DENY to ALLOW after the fact', () => {
    const chain = buildChain(2);
    const tampered = [chain[0]!, { ...chain[1]!, body: { verdict: 'ALLOW', index: 1 } }];
    const result = verifyChain(tampered, verifier);
    expect(result.valid).toBe(false);
    expect(result.defects[0]?.kind).toBe('PAYLOAD_MODIFIED');
  });

  it('detects a recomputed hash that was not re-signed', () => {
    // An attacker with database access edits the body AND fixes the chain hash,
    // but cannot produce a valid signature without the key.
    const chain = buildChain(3);
    const forgedBody = { verdict: 'ALLOW', index: 1, injected: true };
    const forgedHash = computeChainHash({ ...chain[1]!, body: forgedBody });
    const tampered = [
      chain[0]!,
      { ...chain[1]!, body: forgedBody, chainHash: forgedHash },
      { ...chain[2]!, prevChainHash: forgedHash },
    ];

    const result = verifyChain(tampered, verifier);
    expect(result.valid).toBe(false);
    expect(result.defects.map(d => d.kind)).toContain('SIGNATURE_INVALID');
  });

  it('detects a deleted entry as a sequence gap', () => {
    const chain = buildChain(5);
    const result = verifyChain([chain[0]!, chain[1]!, chain[3]!, chain[4]!], verifier);
    expect(result.valid).toBe(false);
    expect(result.defects.map(d => d.kind)).toContain('SEQUENCE_GAP');
    expect(result.defects.map(d => d.kind)).toContain('CHAIN_BROKEN');
  });

  it('detects a truncated chain only against an independently held head', () => {
    const chain = buildChain(5);
    const truncated = chain.slice(0, 3);
    // Truncation alone is internally consistent, which is exactly why a witness
    // is required to catch it.
    expect(verifyChain(truncated, verifier).valid).toBe(true);
    const result = verifyChain(truncated, verifier, chain[4]!.chainHash);
    expect(result.valid).toBe(false);
    expect(result.defects.map(d => d.kind)).toContain('HEAD_MISMATCH');
  });

  it('detects a spliced-in entry from another chain', () => {
    const chain = buildChain(3, 'chn_a');
    const foreign = buildChain(3, 'chn_b');
    const result = verifyChain([chain[0]!, chain[1]!, foreign[2]!], verifier);
    expect(result.valid).toBe(false);
    expect(result.defects.map(d => d.kind)).toContain('CHAIN_ID_MISMATCH');
  });

  it('detects duplicate sequence numbers', () => {
    const chain = buildChain(2);
    const result = verifyChain(
      [chain[0]!, chain[1]!, { ...chain[1]!, envelopeId: 'env_dup' }],
      verifier,
    );
    expect(result.valid).toBe(false);
    expect(result.defects.map(d => d.kind)).toContain('DUPLICATE_SEQUENCE');
  });

  it('detects a chain that does not begin at genesis', () => {
    const chain = buildChain(3);
    const result = verifyChain(chain.slice(1), verifier);
    expect(result.valid).toBe(false);
    expect(result.defects.map(d => d.kind)).toContain('SEQUENCE_GAP');
    expect(result.defects.map(d => d.kind)).toContain('BAD_GENESIS');
  });

  it('detects reordering, because position is inside the hashed preimage', () => {
    const chain = buildChain(3);
    const swapped = [chain[0]!, { ...chain[2]!, sequence: 1 }, { ...chain[1]!, sequence: 2 }];
    expect(verifyChain(swapped, verifier).valid).toBe(false);
  });

  it('rejects a chain signed by an unexpected key', () => {
    const strangerVerifier = createVerifier(generateEvidenceKeyPair().publicKeySpkiBase64);
    const result = verifyChain(buildChain(3), strangerVerifier);
    expect(result.valid).toBe(false);
    expect(result.defects.every(d => d.kind === 'SIGNATURE_INVALID')).toBe(true);
  });
});

describe('chain hash', () => {
  it('is stable across key ordering in the body', () => {
    const at: Timestamp = AT;
    const a = computeChainHash({
      envelopeId: 'env_1',
      chainId: 'chn_1',
      sequence: 0,
      prevChainHash: GENESIS_CHAIN_HASH,
      recordedAt: at,
      kind: 'DECISION',
      body: { b: 2, a: 1 },
    });
    const b = computeChainHash({
      envelopeId: 'env_1',
      chainId: 'chn_1',
      sequence: 0,
      prevChainHash: GENESIS_CHAIN_HASH,
      recordedAt: at,
      kind: 'DECISION',
      body: { a: 1, b: 2 },
    });
    expect(a).toBe(b);
  });

  it('changes when the position in the chain changes', () => {
    const base = {
      envelopeId: 'env_1',
      chainId: 'chn_1',
      prevChainHash: GENESIS_CHAIN_HASH,
      recordedAt: AT,
      kind: 'DECISION' as const,
      body: { a: 1 },
    };
    expect(computeChainHash({ ...base, sequence: 0 })).not.toBe(
      computeChainHash({ ...base, sequence: 1 }),
    );
  });
});
