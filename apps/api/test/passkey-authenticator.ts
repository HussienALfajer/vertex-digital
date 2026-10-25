import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

/*
 * A software WebAuthn authenticator for the passkey tests (S22 PK2, PK3): one P-256 credential
 * with "none" attestation, its signature counter set by the test, user verification on unless a
 * test turns it off. What a browser and a platform authenticator send, built by hand.
 */

const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

export class TestAuthenticator {
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  private readonly rawId = randomBytes(16);
  counter = 0;
  userVerified = true;

  constructor(
    private readonly rpId: string,
    private readonly origin: string,
  ) {}

  get credentialId(): string {
    return b64url(this.rawId);
  }

  /** The response to registration options (`navigator.credentials.create`). */
  register(options: { challenge: string }, origin = this.origin) {
    const clientData = this.clientData('webauthn.create', options.challenge, origin);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.rawId.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLength, this.rawId, this.coseKey()]);
    const attestationObject = isoCBOR.encode(
      new Map<string, string | Map<string, string> | Uint8Array>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', this.authData(AT, attested)],
      ]),
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientData),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
    };
  }

  /** The response to sign-in options (`navigator.credentials.get`), signed with the counter. */
  assert(options: { challenge: string }, signWith = this.keys.privateKey) {
    const clientData = this.clientData('webauthn.get', options.challenge, this.origin);
    const authenticatorData = this.authData(0);
    const signature = sign(
      'sha256',
      Buffer.concat([authenticatorData, createHash('sha256').update(clientData).digest()]),
      signWith,
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
      },
    };
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  private authData(extraFlags: number, attested = Buffer.alloc(0)): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const flags = UP | (this.userVerified ? UV : 0) | extraFlags;
    return Buffer.concat([
      createHash('sha256').update(this.rpId).digest(),
      Buffer.from([flags]),
      counter,
      attested,
    ]);
  }

  /** The public key as COSE: EC2, ES256, P-256. */
  private coseKey(): Buffer {
    const jwk = this.keys.publicKey.export({ format: 'jwk' });
    return Buffer.from(
      isoCBOR.encode(
        new Map<number, number | Uint8Array>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(jwk.x as string, 'base64url')],
          [-3, Buffer.from(jwk.y as string, 'base64url')],
        ]),
      ),
    );
  }
}

/** Another key, for an assertion signed by someone who copied the credential id only. */
export const strangerKey = () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
