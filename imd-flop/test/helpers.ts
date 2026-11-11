import { spawnSync } from "node:child_process";
import { chownSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type IO } from "../src/cli.js";
import type { Provider } from "../src/providers.js";

export function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "imd-flop-test-"));
}

/** The unprivileged OS user that tests needing a second user act as. */
export const OTHER_UID = 65534;

let otherUser: boolean | undefined;
/**
 * True when this process can act as a second OS user: give a file to OTHER_UID, start a process as
 * OTHER_UID, and start a process with capabilities dropped. Found by trying each, not from the uid: root
 * that may do all three (this sandbox), not an ordinary user (GitHub, a clone). Tests that need it say so
 * in their name and are skipped where it is false.
 */
export function canActAsAnotherUser(): boolean {
  if (otherUser !== undefined) return otherUser;
  const dir = mkdtempSync(join(tmpdir(), "imd-flop-cap-"));
  try {
    const f = join(dir, "f");
    writeFileSync(f, "");
    chownSync(f, OTHER_UID, OTHER_UID);
    const asOther = spawnSync("setpriv", [`--reuid=${OTHER_UID}`, `--regid=${OTHER_UID}`, "--clear-groups", "true"]);
    const dropped = spawnSync("setpriv", ["--bounding-set=-fowner", "--inh-caps=-fowner", "true"]);
    otherUser = asOther.status === 0 && dropped.status === 0;
  } catch {
    otherUser = false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return otherUser;
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
