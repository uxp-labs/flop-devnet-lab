// The one loader of the device's key file, for sign-device.mjs and record-step.mjs (S6, R1).
// The key file must be exactly what `flop-sign.mjs keygen` writes
// (research/2026-11-11-session-deny-list/flop-sign.mjs, the keygen command):
//   JSON.stringify({ v: 0, alg: "ed25519", seed_b64: <base64 of 32 random bytes> }) + "\n"
// Every field it writes is checked, and nothing else may be in the file. Anything else gets the one
// fixed message below: no part of the file's bytes reaches any output or error message.
// The signer is made with @noble/curves from imd-flop/node_modules. The seed lives only in the
// returned closure until wipe() is called.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "./lib.mjs";

const PKG = join(REPO, "imd-flop");
const { ed25519 } = await import(pathToFileURL(createRequire(join(PKG, "package.json")).resolve("@noble/curves/ed25519.js")).href);

/** A refusal about the key file: always these words. */
export const KEY_REFUSAL = "the key file is not exactly what flop-sign.mjs keygen writes";
export class DeviceKeyError extends Error {}

/** Whether a text is exactly a keygen key file; the seed's bytes, or null. */
function seedOf(text) {
  let o;
  try { o = JSON.parse(text); } catch { return null; }
  if (o === null || typeof o !== "object" || Array.isArray(o)) return null;
  if (Object.keys(o).join(",") !== "v,alg,seed_b64") return null;
  if (o.v !== 0 || o.alg !== "ed25519") return null;
  if (typeof o.seed_b64 !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(o.seed_b64)) return null;
  if (text !== JSON.stringify({ v: 0, alg: "ed25519", seed_b64: o.seed_b64 }) + "\n") return null;
  const seed = Uint8Array.from(Buffer.from(o.seed_b64, "base64"));
  return seed.length === 32 ? seed : null;
}

/** The device signer of a key file: { publicKey, sign, wipe }. Every failure is KEY_REFUSAL. */
export function loadDeviceSigner(path) {
  let seed = null;
  try { seed = seedOf(readFileSync(path, "utf8")); } catch { seed = null; }
  if (!seed) throw new DeviceKeyError(KEY_REFUSAL);
  const publicKey = ed25519.getPublicKey(seed);
  return {
    publicKey,
    sign: (message) => ed25519.sign(message, seed),
    wipe: () => { seed.fill(0); seed = undefined; },
  };
}
