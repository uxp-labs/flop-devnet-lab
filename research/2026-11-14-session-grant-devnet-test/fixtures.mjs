// Fixtures for the tests of this folder. Not a test file itself. No network, and no key of the lab:
// a test key is made here from a fixed seed (the sha256 of its label), in a temporary folder, in the
// form flop-sign.mjs keygen writes it. Relay texts are made as the pane makes them.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, loadPlan, sha256Text, V as value } from "./lib.mjs";

export { REPO };
export const plan = loadPlan();
export const V = (name) => value(plan, name);

const { ed25519 } = await import(pathToFileURL(createRequire(join(REPO, "imd-flop", "package.json")).resolve("@noble/curves/ed25519.js")).href);

/** A new empty temporary folder. */
export const tempDir = (name) => mkdtempSync(join(tmpdir(), `${name}-`));

/** A seed of 32 bytes fixed by a label. */
export const seedOf = (label) => createHash("sha256").update(`g19 test key ${label}`).digest();

/** A test key file in the form of flop-sign.mjs keygen, from a fixed seed: { path, public_key, seed_b64 }. */
export function testKey(dir, label) {
  const seed = seedOf(label);
  const path = join(dir, `${label}.json`);
  const seed_b64 = seed.toString("base64");
  writeFileSync(path, JSON.stringify({ v: 0, alg: "ed25519", seed_b64 }) + "\n", { mode: 0o600 });
  return { path, public_key: "0x" + Buffer.from(ed25519.getPublicKey(seed)).toString("hex"), seed_b64 };
}

/** The public key of a fixed seed, as 0x hex. */
export const publicOf = (label) => "0x" + Buffer.from(ed25519.getPublicKey(seedOf(label))).toString("hex");

/** A text and its sha256, as the pane relays them. */
export const relay = (value_) => { const text = JSON.stringify(value_); return { text, sha: sha256Text(text) }; };

const { didKeyFromPub, ss58Encode } = await import(pathToFileURL(join(REPO, "imd-flop", "dist", "ss58.js")).href);
const unhex = (h) => Uint8Array.from(Buffer.from(h.slice(2), "hex"));

/**
 * A run folder whose seat home names a device by its public key: identity.json in the tool's own
 * form (imd-flop/src/keys.ts makeIdentity) and config.json with the plan's caps (A_DAILY_FLOP,
 * A_PER_TX_FLOP), and no key file: an identity is public data, and the session commands read no key.
 * The real batch makes its seat with imd-flop init and cap set instead (H8); this is for a device of
 * a recording, which no init can make.
 */
export function runWithSeat(devicePub, name = "g19-run") {
  const run = tempDir(name);
  const seat = V("SEAT");
  const dir = join(run, "seat", "seats", seat);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pub = unhex(devicePub);
  writeFileSync(join(dir, "identity.json"), JSON.stringify({ v: 0, seat, network: "devnet", did: didKeyFromPub(pub), ss58: ss58Encode(pub, 42), ss58Prefix: 42, createdAt: "recorded" }));
  writeFileSync(join(run, "seat", "config.json"), JSON.stringify({ network: "devnet", seat, payer: "holder", caps: { [seat]: { daily: Number(V("A_DAILY_FLOP")), perCall: Number(V("A_PER_TX_FLOP")) } } }));
  return run;
}
