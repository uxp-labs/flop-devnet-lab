/**
 * P4, rules D2, T6 and T7: the channel key's seed and secret are registered with the secret guard, and nothing
 * the key gives reaches a file with any of them in it. This file runs in its own module graph, so the registry
 * starts empty here; it is cleared again at the end, which leaves it as this file found it.
 */
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { base64 } from "@scure/base";
import { secretFromSeed } from "@scure/sr25519";
import { afterAll, describe, expect, it } from "vitest";
import { channelKeyFromSeed } from "../src/channel/key.js";
import { assertNoSecrets, clearSecretRegistry, scanForSecrets } from "../src/secrets.js";
import { appendJsonlSafe, writeJsonSafe } from "../src/store.js";
import { tmpHome } from "./helpers.js";
import { forbiddenForms } from "./lib/channel-secret-forms.js";

const SEED = Uint8Array.from({ length: 32 }, (_, i) => (0x5a ^ (i * 13)) & 0xff);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

afterAll(() => {
  clearSecretRegistry();
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe("T6: the key registers its seed, its secret and the halves of the secret", () => {
  const secret = secretFromSeed(SEED);
  const secretHex = { signature: hex(secret) };
  const seedText = { note: `the run used ${base64.encode(SEED)} as its seed` };
  const halves = [{ signature: hex(secret.subarray(0, 32)) }, { sig: hex(secret.subarray(32, 64)) }];

  it("with the registry cleared and no key made, the guard does not flag the seed's base64 in a text, nor the secret's hex under signature", () => {
    clearSecretRegistry();
    expect(scanForSecrets(seedText)).toEqual([]);
    expect(scanForSecrets(secretHex)).toEqual([]);
    for (const h of halves) expect(scanForSecrets(h)).toEqual([]);
  });

  it("after a key is made from the seed, the guard flags each of them", () => {
    channelKeyFromSeed({ seed: SEED });
    // The secret's hex holds the hex of each half too: three registered forms are found in it.
    expect(scanForSecrets(secretHex).map((f) => f.reason)).toEqual(["contains a loaded secret", "contains a loaded secret", "contains a loaded secret"]);
    expect(scanForSecrets(seedText).map((f) => f.reason)).toContain("contains a loaded secret");
    for (const h of halves) expect(scanForSecrets(h).map((f) => f.reason)).toContain("contains a loaded secret");
    expect(() => assertNoSecrets(secretHex, "a test row")).toThrow(/secret scan blocked writing a test row: signature: contains a loaded secret/);
  });
});

describe("T7: on the file system, nothing the key gives holds the seed, the secret or its halves", () => {
  const home = tmpHome();
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  const forms = forbiddenForms(SEED);

  it("everything the key returned, written through writeJsonSafe and appendJsonlSafe, and every file under the home", () => {
    const key = channelKeyFromSeed({ seed: SEED });
    const channelId = new Uint8Array(32).fill(0x11);
    const receipt = key.signReceipt({ channelId, finalRoot: new Uint8Array(32).fill(0x22), aggregateGn: 38n, payable: 114000000000000002n });
    const ack = key.signTurnAck({ channelId, turnIndex: 0, leafHash: new Uint8Array(32).fill(0x33), agentSendMs: 1n, agentRecvMs: 2n });
    const request = key.signRequest({ channelId, method: "GET", path: "/session/info", body: "", timestampMs: 3n, nonce: new Uint8Array(16).fill(0x44), challenge: "f".repeat(64) });
    // Bytes as arrays of numbers, signatures also as hex under signature, the headers as the code points of their texts:
    // the shapes the secret guard lets through, so that every value the key gave is on disk in some form.
    const bytes = (b: Uint8Array) => Array.from(b);
    const row = {
      public_key_bytes: bytes(key.publicKey()),
      receipt: { message: bytes(receipt.message), signature: hex(receipt.signature) },
      ack: { message: bytes(ack.message), signature: hex(ack.signature) },
      request: { message: bytes(request.message), signature: hex(request.signature), headers: Object.entries(request.headers).map(([k, v]) => [k, Array.from(v, (c) => c.charCodeAt(0))]) },
    };
    writeJsonSafe(join(home, "channel", "run.json"), row);
    appendJsonlSafe(join(home, "channel", "rows.jsonl"), row);
    appendJsonlSafe(join(home, "channel", "rows.jsonl"), { signatures: { signature: hex(ack.signature) } });

    const all = files(home);
    expect(all.length).toBe(2);
    for (const f of all) {
      const text = readFileSync(f, "utf8");
      expect(text).toContain(hex(receipt.signature));
      for (const form of forms) expect(text.includes(form), `${f}`).toBe(false);
    }
  });

  it("the secret itself, through each writer, is refused and no file holds it", () => {
    const secret = secretFromSeed(SEED);
    const tries = [{ signature: hex(secret) }, { sig: hex(secret.subarray(0, 32)) }, { note: `seed ${base64.encode(SEED)}` }, { flopSignature: hex(secret.subarray(32, 64)).toUpperCase() }];
    for (const t of tries) {
      expect(() => writeJsonSafe(join(home, "secret", "a.json"), t)).toThrow(/secret scan blocked/);
      expect(() => appendJsonlSafe(join(home, "secret", "b.jsonl"), t)).toThrow(/secret scan blocked/);
    }
    for (const f of files(home)) {
      const text = readFileSync(f, "utf8");
      for (const form of forms) expect(text.includes(form), `${f}`).toBe(false);
    }
  });
});
