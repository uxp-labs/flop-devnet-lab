import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT, HireError } from "../src/errors.js";
import { createKeyFile, loadAccount } from "../src/wallet.js";
import { account, TEST_KEY } from "./helpers.js";

const dir = () => mkdtempSync(join(tmpdir(), "imd-hire-wallet-"));

describe("the key file", () => {
  it("is made owner only, is never overwritten, and loads back to the same address", () => {
    const path = join(dir(), "eth.key");
    const made = createKeyFile(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadAccount(path).address).toBe(made.address);
    const before = readFileSync(path, "utf8");
    expect(() => createKeyFile(path)).toThrow(/never overwritten/);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(JSON.parse(before)).toMatchObject({ v: 0, alg: "secp256k1" });
  });

  it("loads the documented format", () => {
    const path = join(dir(), "eth.key");
    writeFileSync(path, JSON.stringify({ v: 0, alg: "secp256k1", key_hex: TEST_KEY }) + "\n", { mode: 0o600 });
    expect(loadAccount(path).address).toBe(account.address);
  });

  it("refuses a file that others can read", () => {
    const path = join(dir(), "eth.key");
    createKeyFile(path);
    for (const mode of [0o644, 0o640, 0o604, 0o660]) {
      chmodSync(path, mode);
      expect(() => loadAccount(path), mode.toString(8)).toThrow(/others can read it/);
    }
  });

  it("refuses a key typed where the path belongs, and does not echo it", () => {
    for (const typed of [TEST_KEY, TEST_KEY.slice(2), ` ${TEST_KEY} `]) {
      for (const use of [loadAccount, createKeyFile]) {
        const e = (() => {
          try {
            use(typed);
            return null;
          } catch (x) {
            return x as HireError;
          }
        })();
        expect(e).toBeInstanceOf(HireError);
        expect(e!.code).toBe(EXIT.USAGE);
        expect(e!.message).toMatch(/never a key/);
        expect(e!.message).not.toContain(TEST_KEY.slice(2, 20));
      }
    }
  });

  it("no message names the path it was given", () => {
    const path = join(dir(), "a-very-recognizable-name.key");
    for (const run of [() => loadAccount(path), () => { createKeyFile(path); createKeyFile(path); }, () => { chmodSync(path, 0o644); loadAccount(path); }]) {
      try {
        run();
        expect.unreachable();
      } catch (x) {
        expect((x as Error).message).not.toContain("recognizable");
      }
    }
  });

  it("refuses a missing or malformed file with a usage error that quotes none of it", () => {
    const d = dir();
    expect(() => loadAccount(join(d, "none.key"))).toThrow(/no key file/);
    const cases = ["not json", JSON.stringify({ v: 1, alg: "secp256k1", key_hex: TEST_KEY }), JSON.stringify({ v: 0, alg: "ed25519", key_hex: TEST_KEY }), JSON.stringify({ v: 0, alg: "secp256k1", key_hex: TEST_KEY.slice(0, 40) }), JSON.stringify(null)];
    for (const [i, text] of cases.entries()) {
      const path = join(d, `bad-${i}.key`);
      writeFileSync(path, text, { mode: 0o600 });
      const e = (() => {
        try {
          loadAccount(path);
          return null;
        } catch (x) {
          return x as HireError;
        }
      })();
      expect(e, text).toBeInstanceOf(HireError);
      expect(e!.code).toBe(EXIT.USAGE);
      expect(e!.message).not.toContain(TEST_KEY.slice(2, 30));
    }
  });
});
