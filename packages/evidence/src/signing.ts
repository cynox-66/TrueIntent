/**
 * Ed25519 signing for evidence envelopes.
 *
 * A hash chain alone answers "was one record altered in isolation?". It does
 * not answer "did someone with write access to the database rewrite the whole
 * chain?", because recomputing every subsequent hash is trivial for them.
 *
 * Signing closes that gap for a database-only adversary: forging history now
 * requires the signing key, which does not live in the database. Ed25519 rather
 * than an HMAC because verification needs only the *public* key, so a dispute
 * reviewer can check the ledger without being handed a secret that would also
 * let them forge it. See ADR-007.
 *
 * What this does NOT protect against, stated plainly: an attacker who obtains
 * the signing key can rewrite history undetectably. In this prototype the key
 * is a local environment variable, so that is a realistic compromise. A
 * production deployment would hold it in an HSM or KMS and would additionally
 * publish chain heads somewhere the operator cannot retroactively edit.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';

export interface EvidenceSigner {
  readonly publicKeyId: string;
  sign(payload: Buffer): string;
}

export interface EvidenceVerifier {
  readonly publicKeyId: string;
  verify(payload: Buffer, signature: string): boolean;
}

export interface EvidenceKeyPair {
  /** Base64 PKCS#8 DER. Secret: never logged, never stored in the database. */
  readonly privateKeyPkcs8Base64: string;
  /** Base64 SPKI DER. Safe to publish; needed by anyone verifying the ledger. */
  readonly publicKeySpkiBase64: string;
  readonly publicKeyId: string;
}

/** Short, stable fingerprint of a public key, recorded on every envelope. */
export function publicKeyFingerprint(publicKey: KeyObject): string {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('hex').slice(0, 16);
}

export function generateEvidenceKeyPair(): EvidenceKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPkcs8Base64: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicKeySpkiBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    publicKeyId: publicKeyFingerprint(publicKey),
  };
}

export function createSigner(privateKeyPkcs8Base64: string): EvidenceSigner {
  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyPkcs8Base64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Evidence signing key must be Ed25519');
  }
  const publicKeyId = publicKeyFingerprint(createPublicKey(privateKey));

  return {
    publicKeyId,
    sign(payload: Buffer): string {
      // Ed25519 takes no separate digest algorithm; it hashes internally.
      return cryptoSign(null, payload, privateKey).toString('base64');
    },
  };
}

export function createVerifier(publicKeySpkiBase64: string): EvidenceVerifier {
  const publicKey = createPublicKey({
    key: Buffer.from(publicKeySpkiBase64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Evidence verification key must be Ed25519');
  }

  return {
    publicKeyId: publicKeyFingerprint(publicKey),
    verify(payload: Buffer, signature: string): boolean {
      try {
        return cryptoVerify(null, payload, publicKey, Buffer.from(signature, 'base64'));
      } catch {
        // A malformed signature is a failed verification, never an exception
        // that a caller might catch and treat as success.
        return false;
      }
    },
  };
}

/** Derives the public half from a stored private key, for serving to verifiers. */
export function publicKeyFromPrivate(privateKeyPkcs8Base64: string): string {
  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyPkcs8Base64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  return createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
}
