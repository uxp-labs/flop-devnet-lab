/**
 * P5a, T7 (rules O3 and O12): the table's two constants of FlopSessionKeys equal facts-1014020.json, the script
 * takes the allow list's type and the constants from the metadata and refuses what it does not know, and
 * runtimeIdOf finds the one entry with three names, refuses none and more than one, and reads its names as
 * runtimeFor reads its four.
 */
import { describe, expect, it, vi } from "vitest";
import { OWNER_CONSTANTS, OWNER_PALLET } from "../src/chain/calls.js";
import { ChainEncodeError } from "../src/chain/errors.js";
import { sessionConstants } from "../src/chain/owner-calls.js";
import { RUNTIMES } from "../src/chain/runtimes.js";
import { runtimeIdOf } from "../src/chain/table.js";
import { CONSTANTS } from "../scripts/chain-table.mjs";
import { readJson, RERUN, RT, RUNTIME_ID } from "./lib/chain-fixtures.js";

const facts = readJson(`${RERUN}/facts-1014020.json`);
const NAMES = { specName: RT.specName, specVersion: RT.specVersion, genesisHash: RT.genesisHash };

function codeOf(f: () => unknown): string | null {
  try {
    f();
  } catch (e) {
    return e instanceof ChainEncodeError ? e.refusal : `not a ChainEncodeError: ${String(e)}`;
  }
  return null;
}

describe("O3: the two constants come from the metadata and equal the facts file", () => {
  it("the table's constants are exactly OWNER_CONSTANTS, as the script lists them", () => {
    expect(RT.constants.map((c) => `${c.pallet}.${c.name}`)).toEqual(Object.values(OWNER_CONSTANTS).map((n) => `${OWNER_PALLET}.${n}`));
    expect(CONSTANTS).toEqual(Object.values(OWNER_CONSTANTS).map((n) => [OWNER_PALLET, n]));
  });

  it("each equals facts-1014020.json constants.FlopSessionKeys.<name>, its type and its value", () => {
    for (const c of RT.constants) {
      const f = facts.constants[c.pallet][c.name];
      expect(c.type.kind).toBe(f.type);
      expect(String(c.value)).toBe(f.value);
    }
  });

  it("sessionConstants gives them by the runtime's names (O13)", () => {
    const c = sessionConstants(RUNTIME_ID);
    expect(String(c.maxSessionDuration)).toBe(facts.constants.FlopSessionKeys.MaxSessionDuration.value);
    expect(String(c.sessionEpochLength)).toBe(facts.constants.FlopSessionKeys.SessionEpochLength.value);
    expect(Object.isFrozen(c)).toBe(true);
    expect(codeOf(() => sessionConstants({ ...RUNTIME_ID, transactionVersion: RUNTIME_ID.transactionVersion + 1 }))).toBe("RUNTIME_UNKNOWN");
  });

  it("the allow list of create_session is the one field of the kind bytesList in the table", () => {
    const kinds = RT.calls.flatMap((c) => c.fields.filter((f) => f.type.kind === "bytesList").map((f) => `${c.name}.${f.name}`));
    expect(kinds).toEqual(["create_session.allowed_pallets"]);
  });
});

describe("O12: runtimeIdOf", () => {
  it("found: the four names of the table's entry, a new frozen object", () => {
    const id = runtimeIdOf(NAMES);
    expect(id).toEqual(RUNTIME_ID);
    expect(Object.isFrozen(id)).toBe(true);
    expect(id).not.toBe(RT);
    // A whole entry of the table is names too: other fields are never read.
    expect(runtimeIdOf(RT)).toEqual(RUNTIME_ID);
  });

  it("not found: each of the three changed, missing, of another type, or not an object", () => {
    for (const bad of [
      { ...NAMES, specName: "other" },
      { ...NAMES, specVersion: NAMES.specVersion + 1 },
      { ...NAMES, specVersion: String(NAMES.specVersion) },
      { ...NAMES, genesisHash: NAMES.genesisHash.toUpperCase() },
      { specName: NAMES.specName, specVersion: NAMES.specVersion },
      null,
      "names",
    ]) {
      expect(codeOf(() => runtimeIdOf(bad as never))).toBe("RUNTIME_UNKNOWN");
    }
  });

  it("the names are read as runtimeFor reads its four: an accessor refused, a Proxy's get trap not used, an inherited name not read", () => {
    const getter = { ...NAMES };
    Object.defineProperty(getter, "specVersion", { get: () => NAMES.specVersion, enumerable: true });
    expect(codeOf(() => runtimeIdOf(getter))).toBe("BAD_INPUT");
    let gets = 0;
    const proxy = new Proxy({ ...NAMES }, { get: (t, k) => (gets++, Reflect.get(t, k)) });
    expect(runtimeIdOf(proxy)).toEqual(RUNTIME_ID);
    expect(gets).toBe(0);
    expect(codeOf(() => runtimeIdOf(Object.create(NAMES)))).toBe("RUNTIME_UNKNOWN");
  });

  it("unique: no two entries of the table share the three names", () => {
    const keys = RUNTIMES.map((r) => JSON.stringify([r.specName, r.specVersion, r.genesisHash]));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("two entries with the three names are refused, never one picked (a forged table)", async () => {
    vi.resetModules();
    vi.doMock("../src/chain/runtimes.js", () => ({ RUNTIMES: [RT, { ...structuredClone(RT), transactionVersion: RT.transactionVersion + 1 }] }));
    try {
      const t = await import("../src/chain/table.js");
      const e = await import("../src/chain/errors.js");
      let refusal: unknown = null;
      try {
        t.runtimeIdOf(NAMES);
      } catch (err) {
        refusal = err instanceof e.ChainEncodeError ? err.refusal : String(err);
      }
      expect(refusal).toBe("RUNTIME_UNKNOWN");
    } finally {
      vi.doUnmock("../src/chain/runtimes.js");
      vi.resetModules();
    }
  });
});
