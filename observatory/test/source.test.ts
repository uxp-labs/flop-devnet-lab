// How the fixture reader reads a scenario folder (src/source.ts, src/files.ts): only regular files
// are read, so a pipe, a device or a folder at a file's path is refused with a reason instead of
// blocking the command (third IMD audit J4), and an event-pages folder that is there but cannot be
// read or listed is a page file problem, never an empty folder (J8, RULES.md 3.1 clauses 15 and 16).
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { census } from "../src/census.js";
import { escrowStates } from "../src/escrow.js";
import { NotARegularFile, readRegularFile } from "../src/files.js";
import { FixtureSource } from "../src/source.js";
import { DEVNET_GENESIS, networkStatus } from "../src/status.js";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
/** A copy of a fixture folder to change. */
function copyOf(name: string): string {
  const d = mkdtempSync(join(tmpdir(), "obs-source-"));
  made.push(d);
  cpSync(fixture(name), d, { recursive: true });
  return d;
}

describe("readRegularFile reads a regular file and refuses anything else", () => {
  it("reads a regular file's bytes", () => {
    const d = mkdtempSync(join(tmpdir(), "obs-source-"));
    made.push(d);
    writeFileSync(join(d, "a.json"), "{}\n");
    expect(readRegularFile(join(d, "a.json")).toString("utf8")).toBe("{}\n");
  });

  it("refuses a folder and a device, without reading them", () => {
    const d = mkdtempSync(join(tmpdir(), "obs-source-"));
    made.push(d);
    expect(() => readRegularFile(d)).toThrow(NotARegularFile);
    // A device is opened but never read: /dev/null would read as an empty file.
    expect(() => readRegularFile("/dev/null")).toThrow(NotARegularFile);
  });

  it("gives the system's error for a path that is not there", () => {
    expect(() => readRegularFile(join(tmpdir(), "obs-no-such-file.json"))).toThrow(/ENOENT/);
  });
});

describe("a saved reading that is not a regular file counts as nothing read, with the reason (RULES.md 1.1)", () => {
  it("a faucet health reading that is a folder leaves the faucet unknown, naming the file", async () => {
    const d = copyOf("status-healthy");
    rmSync(join(d, "faucet-health.json"));
    mkdirSync(join(d, "faucet-health.json"));
    const s = await networkStatus(FixtureSource.fromDir(d), { pinnedGenesis: DEVNET_GENESIS, now: "2026-11-09T23:47:53Z" });
    expect(s.faucet.health).toBe("unknown");
    expect(s.faucet.detail).toBe("faucet-health.json: not a regular file");
  });

  it("a meta.json that is a folder refuses the scenario", () => {
    const d = copyOf("status-healthy");
    rmSync(join(d, "meta.json"));
    mkdirSync(join(d, "meta.json"));
    expect(() => FixtureSource.fromDir(d)).toThrow(/has no readable meta\.json/);
  });
});

/**
 * Runs read with one node:fs function failing with code for paths that end in suffix, as a
 * folder the reader may not open does for a user without the right (root opens any folder, so a
 * real permission cannot be shown here). The real function is put back afterwards.
 */
function failing<T>(name: "lstatSync" | "readdirSync", suffix: string, code: string, read: () => T): T {
  const fs = createRequire(import.meta.url)("node:fs") as Record<string, (...a: unknown[]) => unknown>;
  const real = fs[name] as (...a: unknown[]) => unknown;
  fs[name] = (...args: unknown[]) => {
    if (String(args[0]).endsWith(suffix)) throw Object.assign(new Error(`${code}: refused for the test`), { code });
    return real(...args);
  };
  syncBuiltinESMExports();
  try {
    return read();
  } finally {
    fs[name] = real;
    syncBuiltinESMExports();
  }
}

describe("an event-pages folder that cannot be read or listed is a page file problem (RULES.md 3.1 clauses 15 and 16)", () => {
  for (const [name, call, what] of [
    ["cannot be listed", "readdirSync", "event-pages: cannot be listed (EACCES)"],
    ["cannot be read", "lstatSync", "event-pages: cannot be read (EACCES)"],
  ] as const) {
    it(`a folder that ${name} refuses the census as a page file problem and leaves every escrow unverified`, () => {
      const d = copyOf("census-complete");
      const src = failing(call, join(d, "event-pages"), "EACCES", () => FixtureSource.fromDir(d));
      expect(src.data.pageErrors).toEqual([what]);
      const req = src.data.meta.census_request as { from_block: number; to_block: number };
      expect(() =>
        census(src.data.eventPages ?? [], {
          pinnedGenesis: src.data.meta.pinned_genesis ?? DEVNET_GENESIS,
          requested: req,
          observedAt: "2026-11-10T00:00:00Z",
          trust: "fixture",
          unreadablePages: src.data.pageErrors,
        }),
      ).toThrow(/census refused \(page-file\): unusable event page file\(s\): event-pages: cannot be/);
      const states = escrowStates(["0x" + "6f".repeat(32)], src.data.eventPages ?? [], {
        pinnedGenesis: DEVNET_GENESIS,
        finalizedHeight: null,
        observedAt: "2026-11-10T00:00:00Z",
        trust: "fixture",
        unreadablePages: src.data.pageErrors,
      });
      expect(states.map((e) => e.state)).toEqual(["unverified"]);
    });
  }

  it("a scenario with no event-pages folder at all has no pages and no page problem", () => {
    const d = copyOf("status-healthy");
    const src = FixtureSource.fromDir(d);
    expect(src.data.eventPages).toBeUndefined();
    expect(src.data.pageErrors).toEqual([]);
  });
});
