/**
 * The channel key C: an sr25519 key made fresh for one run, held in memory only, never written (rules D1 to D10).
 * This is the only file under src that names the sr25519 library, and the only place that holds C's secret.
 *
 * C signs three layouts and nothing else: the receipt and the turn ack of transcript.ts, and the request message
 * of auth.ts. There is no function that signs bytes it is handed, and none that gives out the secret or the seed.
 * Each signature is checked under the key's own public key before it is returned. The key holds no channel id:
 * each signing call names its channel.
 *
 * The library is `@scure/sr25519` at 2.4.0. It signs under the substrate signing context, which is how FLOP's SDK
 * 0.6.0 signs (`dist/compute-channel/crypto.js`, read and not imported). Its signatures are randomized.
 */
import { randomBytes } from "@noble/hashes/utils.js";
import { getPublicKey, secretFromSeed, sign, verify } from "@scure/sr25519";
import { registerSecret } from "../secrets.js";
import { requestHeaders, REQUEST_FIELDS, sessionRequestMessage, type RequestHeaders, type RequestHeadersInput, type SessionRequestInput } from "./auth.js";
import { bytesOf, snapshotOf, takeFields } from "./bytes.js";
import { refuse } from "./errors.js";
import { freezeFunction } from "./freeze.js";
import { receiptMessage, turnAckMessage, type ReceiptInput, type TurnAckInput } from "./transcript.js";

/** A message and the key's signature over it, both fresh. */
export interface Signed {
  readonly message: Uint8Array;
  readonly signature: Uint8Array;
}

/** A signed request: the message, the signature and the five headers, from one reading of the input. */
export interface SignedRequest extends Signed {
  readonly headers: RequestHeaders;
}

/** The channel key. Its only own properties are these four functions. */
export interface ChannelKey {
  /** The 32 byte public key, a fresh copy at each call. It goes into the channel as agent_key. */
  readonly publicKey: () => Uint8Array;
  readonly signReceipt: (fields: ReceiptInput) => Signed;
  readonly signTurnAck: (fields: TurnAckInput) => Signed;
  readonly signRequest: (fields: SessionRequestInput) => SignedRequest;
}

export interface VerifyInput {
  readonly publicKey: Uint8Array;
  readonly message: Uint8Array;
  readonly signature: Uint8Array;
}

const SEED_BYTES = 32;

/** True only when the library's verify returns true. False when it throws or the lengths are not its own. */
function verifies(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    return verify(message, signature, publicKey) === true;
  } catch {
    return false;
  }
}

/** The key made from a 32 byte seed that is already a fresh copy. */
function keyFromSeed(seed: Uint8Array): ChannelKey {
  const secret = secretFromSeed(seed);
  const publicKey = Uint8Array.from(getPublicKey(secret));
  registerSecret(seed);
  registerSecret(secret);
  registerSecret(secret.subarray(0, 32));
  registerSecret(secret.subarray(32, 64));

  const signed = (message: Uint8Array): Signed => {
    let signature: unknown;
    try {
      signature = sign(secret, message);
    } catch {
      return refuse("SIGN_FAILED", "the sr25519 library threw while signing");
    }
    let own: Uint8Array;
    try {
      own = bytesOf(signature, 64, "the signature");
    } catch {
      return refuse("SELF_CHECK", "the sr25519 library did not give a Uint8Array of 64 bytes");
    }
    if (!verifies(publicKey, message, own)) refuse("SELF_CHECK", "the signature does not verify under the key's own public key");
    return Object.freeze({ message: Uint8Array.from(message), signature: own });
  };

  return Object.freeze({
    publicKey: freezeFunction(() => Uint8Array.from(publicKey)),
    signReceipt: freezeFunction((fields: ReceiptInput) => signed(receiptMessage(fields))),
    signTurnAck: freezeFunction((fields: TurnAckInput) => signed(turnAckMessage(fields))),
    signRequest: freezeFunction((fields: SessionRequestInput) => {
      const f = snapshotOf(fields, REQUEST_FIELDS, "request input");
      // The snapshot's values are checked by the two functions it is handed to, as a caller's would be.
      const s = signed(sessionRequestMessage(f as unknown as SessionRequestInput));
      const headers = requestHeaders({ channelId: f.channelId, timestampMs: f.timestampMs, nonce: f.nonce, challenge: f.challenge, signature: s.signature } as unknown as RequestHeadersInput);
      return Object.freeze({ message: s.message, signature: Uint8Array.from(s.signature), headers });
    }),
  });
}

/** A new channel key, from 32 bytes of the system's random source. The seed and the secret are registered with the secret guard. */
export function newChannelKey(): ChannelKey {
  return keyFromSeed(Uint8Array.from(randomBytes(SEED_BYTES)));
}
freezeFunction(newChannelKey);

/**
 * The same key from a given 32 byte seed. For tests alone (S38): no file under src but this one names it, and a
 * source scan holds that. A provider only ever calls newChannelKey.
 */
export function channelKeyFromSeed(input: { readonly seed: Uint8Array }): ChannelKey {
  const f = takeFields(input, ["seed"], "channelKeyFromSeed input");
  return keyFromSeed(bytesOf(f.seed, SEED_BYTES, "channelKeyFromSeed seed"));
}
freezeFunction(channelKeyFromSeed);

/**
 * True only when the library's verify returns true. False when the public key is not 32 bytes, the signature is
 * not 64 bytes, or the library throws on the bytes (it throws when bit 7 of byte 63 of the signature is not set).
 * BAD_INPUT only when a field is not a Uint8Array or the input object is not plain fields. It never throws on any bytes.
 */
export function verifyChannelSignature(input: VerifyInput): boolean {
  const f = takeFields(input, ["publicKey", "message", "signature"], "verify input");
  const publicKey = bytesOf(f.publicKey, null, "verify publicKey");
  const message = bytesOf(f.message, null, "verify message");
  const signature = bytesOf(f.signature, null, "verify signature");
  return verifies(publicKey, message, signature);
}
freezeFunction(verifyChannelSignature);
