/**
 * The reference sr25519 for cross vectors, in tests only (S36, rule F1): `@polkadot/wasm-crypto` 7.5.4, Rust
 * schnorrkel built to WASM by the polkadot-js maintainers. It shares no code with `@scure/sr25519`. Its WASM is
 * bundled in the package, so it loads with fetch and WebSocket blocked by test/setup.ts (rule F4).
 *
 * Its keypair is 96 bytes: a 64 byte secret in schnorrkel's own form, then the 32 byte public key. Its sign and
 * verify use the substrate signing context, as the chain's sr25519_verify does.
 */
import { blake2b, sr25519KeypairFromSeed, sr25519Sign, sr25519Verify, waitReady } from "@polkadot/wasm-crypto";

export interface ReferencePair {
  readonly publicKey: Uint8Array;
  readonly secret: Uint8Array;
}

/** Loads the WASM. Every other function here needs it to have resolved true. */
export async function referenceReady(): Promise<void> {
  const ok = await waitReady();
  if (ok !== true) throw new Error("the reference sr25519 did not load");
}

/** The reference's keypair from a 32 byte seed. */
export function referencePair(seed: Uint8Array): ReferencePair {
  const pair = sr25519KeypairFromSeed(Uint8Array.from(seed));
  if (pair.length !== 96) throw new Error(`the reference keypair has ${pair.length} bytes, not 96`);
  return Object.freeze({ secret: pair.slice(0, 64), publicKey: pair.slice(64, 96) });
}

/** The reference's signature over a message, 64 bytes. */
export function referenceSign(pair: ReferencePair, message: Uint8Array): Uint8Array {
  return sr25519Sign(Uint8Array.from(pair.publicKey), Uint8Array.from(pair.secret), Uint8Array.from(message));
}

/** The reference's verdict on a signature. */
export function referenceVerify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  return sr25519Verify(Uint8Array.from(signature), Uint8Array.from(message), Uint8Array.from(publicKey));
}

/**
 * The reference's blake2b 256 (the same package's Rust blake2 in WASM), a second implementation beside
 * @noble/hashes for the session commands' call hash (P5b, T6). Needs referenceReady to have resolved.
 */
export function referenceBlake2b256(data: Uint8Array): Uint8Array {
  return blake2b(Uint8Array.from(data), new Uint8Array(), 32);
}
