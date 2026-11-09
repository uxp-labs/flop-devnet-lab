import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type IO } from "../src/cli.js";
import type { Provider } from "../src/providers.js";

export function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "imd-flop-test-"));
}

export async function cli(home: string, args: string[], extra: Partial<IO> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { out: (s) => out.push(s), err: (s) => err.push(s), env: { IMD_FLOP_HOME: home }, ...extra });
  return { code, out: out.join("\n"), err: err.join("\n"), json: () => JSON.parse(out.join("\n")) };
}

export async function cliP(home: string, args: string[], provider: Provider) {
  return cli(home, args, { provider });
}

export const readLines = (p: string) =>
  readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

/** init + link + cap, the standard ready state for run tests. */
export async function readySeat(home: string, seat = "42", cap = "1") {
  await cli(home, ["init", "--seat", seat]);
  await cli(home, ["link", "--token", seat, "--agent", "7"]);
  await cli(home, ["cap", "set", cap]);
}
