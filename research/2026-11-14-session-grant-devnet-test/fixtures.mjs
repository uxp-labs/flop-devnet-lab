// Fixtures for the tests of this folder. Not a test file itself. No network, and no key of the lab:
// a test key is made here from a fixed seed (the sha256 of its label), in a temporary folder, in the
// form flop-sign.mjs keygen writes it. Relay texts are made as the pane makes them.
import { mkdtempSync, writeFileSync } from "node:fs";
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
