/**
 * The encodings of a channel key's seed, its secret and each 32 byte half of the secret, which nothing the key
 * shows or writes may hold (P4, T5 and T7). The secret is derived from the seed with @scure/sr25519 itself.
 */
import { base58, base64, base64url } from "@scure/base";
import { secretFromSeed } from "@scure/sr25519";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** The seed, the 64 byte secret and its two halves, each in hex (both cases), base64 (with and without padding), base64url and base58. */
export function forbiddenForms(seed: Uint8Array): string[] {
  const secret = secretFromSeed(seed);
  const parts = [seed, secret, secret.subarray(0, 32), secret.subarray(32, 64)];
  return parts.flatMap((p) => {
    const h = hex(p);
    return [h, h.toUpperCase(), base64.encode(p), base64.encode(p).replace(/=+$/, ""), base64url.encode(p).replace(/=+$/, ""), base58.encode(p)];
  });
}
