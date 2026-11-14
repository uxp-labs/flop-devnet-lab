/**
 * What the owner pins for one run (W5, W6, M-1, M-2): the genesis hash, the miner account, the enclave key and the
 * model identity of eight fields. P7 hands these in from the run's config and the chain. Every proof and every leaf
 * is verified under the pinned enclave key. There is no mode that takes the key from the miner's own answer: the
 * info proof is signed by that key about itself, and no chain entry holds a miner's enclave key.
 *
 * The value is made by one function. The verify functions take only a value it made, through `pinnedOf`, and use
 * the copy held here, so a change to the arrays of the value handed out changes nothing that is checked.
 */
import { freezeFunction } from "../freeze.js";
import { bytesIn, fieldsOf, textIn, u8In } from "./check.js";
import { refuseMiner } from "./errors.js";
import { allZero } from "./forms.js";

/** The model identity as the SDK names it (`modelIdentityHash`, `turnEvidenceHash`). */
export interface ModelIdentity {
  readonly requestedSlug: string;
  readonly registryModel: string;
  readonly registryVersion: string;
  /** 32 bytes. */
  readonly modelHash: Uint8Array;
  /** A u8: the SCALE tag of the registry's precision. */
  readonly precision: number;
  /** 32 bytes, never all zero: the lab pins a policy. */
  readonly decodePolicyHash: Uint8Array;
  /** 32 bytes. */
  readonly measuredRoot: Uint8Array;
  readonly backendModelName: string;
}

export interface ExpectedInput {
  /** 32 bytes. */
  readonly genesis: Uint8Array;
  /** The miner's account, 32 bytes. */
  readonly account: Uint8Array;
  /** The miner's enclave key, 32 bytes, pinned by the owner. Never the identity point. */
  readonly enclaveKey: Uint8Array;
  readonly identity: ModelIdentity;
}

/** The pinned values. A frozen object; its arrays are fresh copies, and the copies the checks use are held apart. */
export interface Expected extends ExpectedInput {}

export const IDENTITY_FIELDS = Object.freeze(["requestedSlug", "registryModel", "registryVersion", "modelHash", "precision", "decodePolicyHash", "measuredRoot", "backendModelName"] as const);
const EXPECTED_FIELDS = Object.freeze(["genesis", "account", "enclaveKey", "identity"] as const);

/** The copies the checks use, by the value handed out. */
const PINNED = new WeakMap<object, Expected>();

/** A model identity from a caller's plain fields, checked and copied. */
export function identityIn(value: unknown, what: string): ModelIdentity {
  const f = fieldsOf(value, IDENTITY_FIELDS, what);
  return Object.freeze({
    requestedSlug: textIn(f.requestedSlug, `${what}.requestedSlug`),
    registryModel: textIn(f.registryModel, `${what}.registryModel`),
    registryVersion: textIn(f.registryVersion, `${what}.registryVersion`),
    modelHash: bytesIn(f.modelHash, 32, `${what}.modelHash`),
    precision: u8In(f.precision, `${what}.precision`),
    decodePolicyHash: bytesIn(f.decodePolicyHash, 32, `${what}.decodePolicyHash`),
    measuredRoot: bytesIn(f.measuredRoot, 32, `${what}.measuredRoot`),
    backendModelName: textIn(f.backendModelName, `${what}.backendModelName`),
  });
}
freezeFunction(identityIn);

/** A fresh copy of an identity, for the value handed out. */
function copyIdentity(i: ModelIdentity): ModelIdentity {
  return Object.freeze({ ...i, modelHash: Uint8Array.from(i.modelHash), decodePolicyHash: Uint8Array.from(i.decodePolicyHash), measuredRoot: Uint8Array.from(i.measuredRoot) });
}

/**
 * The pinned values of one run. Refused (BAD_INPUT): a field missing, extra or of another form; an enclave key that
 * is the identity point (32 zero bytes, the one encoding of the ristretto255 identity), before any signature is
 * checked (S46: the reference sr25519 takes that key with a zero signature for every message); a decode policy hash
 * of 32 zero bytes (the lab pins a policy, and zero means none in the SDK).
 */
export function minerExpected(input: ExpectedInput): Expected {
  const f = fieldsOf(input, EXPECTED_FIELDS, "expected");
  const genesis = bytesIn(f.genesis, 32, "expected.genesis");
  const account = bytesIn(f.account, 32, "expected.account");
  const enclaveKey = bytesIn(f.enclaveKey, 32, "expected.enclaveKey");
  const identity = identityIn(f.identity, "expected.identity");
  if (allZero(enclaveKey)) refuseMiner("BAD_INPUT", "expected.enclaveKey", "expected.enclaveKey must not be the identity point");
  if (allZero(identity.decodePolicyHash)) refuseMiner("BAD_INPUT", "expected.identity.decodePolicyHash", "expected.identity.decodePolicyHash must not be all zero: the lab pins a policy");
  const held: Expected = Object.freeze({ genesis, account, enclaveKey, identity });
  const out: Expected = Object.freeze({ genesis: Uint8Array.from(genesis), account: Uint8Array.from(account), enclaveKey: Uint8Array.from(enclaveKey), identity: copyIdentity(identity) });
  PINNED.set(out, held);
  return out;
}
freezeFunction(minerExpected);

/** The held copy of a value minerExpected made. Anything else is refused (BAD_INPUT). */
export function pinnedOf(value: unknown): Expected {
  const held = typeof value === "object" && value !== null ? PINNED.get(value) : undefined;
  if (held === undefined) return refuseMiner("BAD_INPUT", "expected", "expected must be a value made by minerExpected");
  return held;
}
freezeFunction(pinnedOf);
