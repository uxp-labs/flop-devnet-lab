/**
 * P3, rules E2 and E11: the encoder's table is the derivation from the recorded metadata, byte for byte,
 * and agrees with the pins of the repo; src imports no dev dependency; the reference encoder is pinned
 * exactly as a dev dependency.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { INNER_NAMES, INNER_PALLET, OUTER } from "../src/chain/calls.js";
import { RUNTIMES } from "../src/chain/runtimes.js";
import { runtimeFor } from "../src/chain/table.js";
import { NETWORKS } from "../src/networks.js";
import { deriveRuntime, deriveRuntimes, OUT, readSource, renderRuntimes, SOURCES } from "../scripts/chain-table.mjs";
import { PKG, readJson, RERUN, RUNTIME_ID, source, steps } from "./lib/chain-fixtures.js";

describe("E2: the table is derived from the recorded metadata", () => {
  it("the committed runtimes.ts equals the derivation byte for byte", () => {
    expect(readFileSync(OUT, "utf8")).toBe(renderRuntimes(deriveRuntimes()));
  });

  it("the metadata is the one facts-1014020.json names, by sha256 and length", () => {
    const facts = readJson(`${RERUN}/facts-1014020.json`);
    expect(source.metadataSha256).toBe(facts.metadata_sha256);
    expect(source.metadata.length).toBe(facts.metadata_bytes);
    expect(RUNTIMES[0].metadataSha256).toBe(facts.metadata_sha256);
    expect(RUNTIMES[0].specVersion).toBe(facts.spec_version);
  });

  it("the genesis equals networks.ts and steps.json values.GENESIS", () => {
    expect(RUNTIMES).toHaveLength(1);
    expect(RUNTIMES[0].genesisHash).toBe(NETWORKS.devnet.genesisHash);
    expect(RUNTIMES[0].genesisHash).toBe(steps.values.GENESIS.value);
  });

  it("the transaction version equals steps.json values.TXV", () => {
    expect(String(RUNTIMES[0].transactionVersion)).toBe(steps.values.TXV.value);
  });

  it("the table holds the outer call and exactly the five inner calls", () => {
    const names = RUNTIMES[0].calls.map((c) => `${c.pallet}.${c.name}`);
    expect(names).toEqual([`${OUTER.pallet}.${OUTER.name}`, ...INNER_NAMES.map((n) => `${INNER_PALLET}.${n}`)]);
  });

  it("the table is frozen: the lookup's entry cannot be changed at run time", () => {
    const rt = runtimeFor(RUNTIME_ID);
    expect(Object.isFrozen(rt)).toBe(true);
    expect(Object.isFrozen(rt.calls[0].fields[0])).toBe(true);
  });

  it("the derivation refuses metadata bytes that are not the named ones", () => {
    const bytes = Uint8Array.from(source.metadata);
    bytes[bytes.length - 1] ^= 1;
    expect(() => deriveRuntime({ ...source, metadata: bytes })).toThrow(/sha256/);
  });

  it("the derivation refuses a facts file whose length does not match", () => {
    expect(() => readSource({ ...SOURCES[0], facts: "research/2026-11-11-session-escrow/results.json" })).toThrow(/no metadata/);
  });
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe("E11: the reference encoder is a pinned dev dependency, never imported by src", () => {
  const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(PKG, "package-lock.json"), "utf8"));
  const REF = { "@polkadot-api/metadata-builders": "0.15.2", "@polkadot-api/substrate-bindings": "0.21.2" };

  it("package.json pins both exactly as dev dependencies and not as dependencies", () => {
    for (const [name, version] of Object.entries(REF)) {
      expect(pkg.devDependencies[name]).toBe(version);
      expect(pkg.dependencies[name]).toBeUndefined();
      expect(lock.packages[`node_modules/${name}`].version).toBe(version);
      expect(lock.packages[`node_modules/${name}`].dev).toBe(true);
    }
  });

  it("the runtime dependencies are the five there were before P3, and the lab's own decoder package added by P2 (S5) as file:../observatory", () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@flop-labs/client", "@noble/curves", "@noble/hashes", "@scure/base", "flop-observatory", "viem"]);
    expect(pkg.dependencies["flop-observatory"]).toBe("file:../observatory");
  });

  const dev = Object.keys(pkg.devDependencies);
  /** Every module a text imports, statically, dynamically or by require, that is a dev dependency or under @polkadot-api. */
  const devImports = (text: string) =>
    [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g)]
      .map((m) => m[1])
      .filter((spec) => spec.startsWith("@polkadot-api") || dev.some((d) => spec === d || spec.startsWith(`${d}/`)));

  it("no file under src imports a dev dependency or mentions @polkadot-api", () => {
    const found = files(join(PKG, "src")).flatMap((f) => {
      const text = readFileSync(f, "utf8");
      return [...devImports(text), ...(text.includes("@polkadot-api") ? ["@polkadot-api"] : [])].map((d) => `${relative(PKG, f)}: ${d}`);
    });
    expect(found).toEqual([]);
  });

  it("the scan finds an import of a dev dependency in each form (control)", () => {
    expect(devImports(readFileSync(join(PKG, "scripts", "chain-table.mjs"), "utf8"))).toEqual(["@polkadot-api/metadata-builders", "@polkadot-api/substrate-bindings"]);
    expect(devImports(`const a = await import("@polkadot-api/utils"); const b = require('vitest'); import "typescript";`)).toEqual(["@polkadot-api/utils", "vitest", "typescript"]);
    expect(devImports(`// typescript and vitest named in prose`)).toEqual([]);
  });
});
