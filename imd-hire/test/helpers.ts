import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { parseChallenge, type Challenge } from "../src/challenge.js";
import { main } from "../src/cli.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/job-open/", import.meta.url));
export const fixture = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, name), "utf8")); // eslint-disable-line @typescript-eslint/no-explicit-any

/** The first well-known test key of every local dev chain. Public, holds nothing. */
export const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const account = privateKeyToAccount(TEST_KEY);
export const OTHER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

/** The captured challenge body, as a fresh copy a test may edit. */
export const challengeBody = (): any => structuredClone(fixture("challenge-response.json").body); // eslint-disable-line @typescript-eslint/no-explicit-any
export const challenge = (): Challenge => parseChallenge(challengeBody());
export const request = (): { action: string; input: Record<string, unknown> } => fixture("request.json");

/** Unix seconds: the fixture quote was issued at ISSUED and expires 600 s later. */
export const ISSUED = 1794357918;
export const EXPIRES = 1794358518;

export const IMD = "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7" as const;
export const HALF_IMD = 500000000000000000n;
/** What the owner approved in these tests: IMD, at most 0.5 for one request. */
export const LIMIT = { token: IMD, maxAmount: HALF_IMD } as const;

export function tmpJob(): string {
  const dir = mkdtempSync(join(tmpdir(), "imd-hire-test-"));
  cpSync(join(FIXTURES, "request.json"), join(dir, "request.json"));
  return dir;
}

export const save = (dir: string, name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value));
export const read = (dir: string, name: string): any => JSON.parse(readFileSync(join(dir, name), "utf8")); // eslint-disable-line @typescript-eslint/no-explicit-any

export async function cli(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
