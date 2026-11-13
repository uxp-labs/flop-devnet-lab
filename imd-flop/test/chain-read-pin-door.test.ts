/**
 * The P2 fix round, rule Y1: the two checks of provenPin (src/chain-read/door.ts) that come after the door's answer.
 *
 * THIS FILE PUTS A STAND IN FOR THE DOOR'S MODULE. vi.mock replaces flop-observatory/scale/block: every export is the
 * real one (vi.importActual) except decodeStorageValue, which answers what a test tells it, and otherwise the real
 * answer. Why: once the real door accepts a pin, it always answers a stored record of the pin's own spec, so no pin
 * reaches check 1 (the value is not a stored record) or check 2 (the record names another spec) through the real
 * door. Without this file nothing fails if either check is removed (CLAUDE.md rule 10). The real door is tested with
 * the real module in chain-read-pin.test.ts.
 *
 * The pin is A6's, built as chain-read-pin.test.ts builds it, from research/2026-11-12-session-rerun-1014020/results.json
 * and the recording it names (test/lib/recorded-node.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const stand = vi.hoisted(() => ({ answer: null as null | ((real: () => unknown) => unknown) }));

vi.mock("flop-observatory/scale/block", async () => {
  const actual = await vi.importActual<typeof import("flop-observatory/scale/block")>("flop-observatory/scale/block");
  return {
    ...actual,
    decodeStorageValue: (input: Parameters<typeof actual.decodeStorageValue>[0]) => (stand.answer ? stand.answer(() => actual.decodeStorageValue(input)) : actual.decodeStorageValue(input)),
  };
});

import { bytesOf, hexOf } from "../src/chain-read/bytes.js";
import { provenPin, runtimeOf } from "../src/chain-read/door.js";
import { KEY_TABLE } from "../src/chain-read/key-table.js";
import { lastRuntimeUpgradeKey } from "../src/chain-read/keys.js";
import { shapeFileText } from "../src/chain-read/shape-file.js";
import { RERUN_RESULTS, repoJson, rerunScript } from "./lib/recorded-node.js";

const A6 = repoJson(RERUN_RESULTS).steps.find((s: any) => s.step === "A6");
const LRU = KEY_TABLE.system.last_runtime_upgrade;
const AT = { pallet: LRU.pallet, entry: LRU.entry, key: lastRuntimeUpgradeKey() };
const reasonOf = (g: { kind: string }) => (g as { reason?: string }).reason ?? "";
const parentOf = (s: ReturnType<typeof rerunScript>, hash: string) => (s.headers.get(hash) as { parentHash: string }).parentHash;

/** A6's pin, built as pinAt builds it. */
function a6Pin() {
  const s = rerunScript(A6.block_hash);
  const lru = bytesOf(s.storage.get(`${A6.block_hash} ${hexOf(lastRuntimeUpgradeKey())}`) as string);
  const runtime = (runtimeOf(lru) as any).value;
  return { runtime, metadata: bytesOf(s.metadata.get(parentOf(s, A6.block_hash)) as string), lastRuntimeUpgrade: lru, shapeText: (shapeFileText(runtime.shapeFile) as any).value as string };
}

/** The stand in answers a stored value `value`, whatever the bytes. */
const answers = (value: unknown) => {
  stand.answer = () => ({ decoded: true, stored: true, value });
};
const record = (over: Record<string, unknown>) => {
  const pin = a6Pin();
  return { spec_name: pin.runtime.specName, spec_version: pin.runtime.specVersion, ...over };
};

beforeEach(() => {
  stand.answer = null;
});

describe("Y1: the stand in for the door's module is honest", () => {
  it("control: the stand in answering exactly what the real door answers gives a known pin", () => {
    stand.answer = (real) => real();
    const g = provenPin(a6Pin(), AT);
    expect(g.kind).toBe("known");
  });

  it("control: the real answer for A6's pin is a stored record of the pin's spec, so the two checks hold here", () => {
    const pin = a6Pin();
    let seen: any;
    stand.answer = (real) => (seen = real());
    provenPin(pin, AT);
    expect(seen.decoded).toBe(true);
    expect(seen.stored).toBe(true);
    expect(seen.value.spec_name).toBe(pin.runtime.specName);
    expect(seen.value.spec_version).toBe(pin.runtime.specVersion);
  });

  it("the stand in's refusal is unknown, with the door's words", () => {
    stand.answer = () => ({ decoded: false, refused: "not decoded: scripted refusal" });
    const g = provenPin(a6Pin(), AT);
    expect(g.kind).toBe("unknown");
    expect(reasonOf(g)).toBe("the decoder: not decoded: scripted refusal");
  });
});

describe("Y1, check 1: the door's value must be a stored record", () => {
  const cases: [string, () => void][] = [
    ["stored: false", () => (stand.answer = () => ({ decoded: true, stored: false, value: record({}) }))],
    ["a value that is null", () => answers(null)],
    ["a list", () => answers([record({})])],
    ["a text", () => answers("spec")],
  ];
  for (const [name, set] of cases) {
    it(`${name} is unknown, not a stored record`, () => {
      set();
      const g = provenPin(a6Pin(), AT);
      expect(g.kind).toBe("unknown");
      expect(reasonOf(g)).toContain("is not a stored record");
    });
  }
});

describe("Y1, check 2: the record must name the spec name and spec version of the pin's runtime", () => {
  const pin = a6Pin();
  const named = `the spec ${JSON.stringify(pin.runtime.specName)} ${pin.runtime.specVersion}`;
  const cases: [string, Record<string, unknown>, string][] = [
    ["another spec_name", { spec_name: `${pin.runtime.specName}-other` }, `the door reads spec ${JSON.stringify(`${pin.runtime.specName}-other`)} ${pin.runtime.specVersion}`],
    ["another spec_version", { spec_version: pin.runtime.specVersion + 1 }, `the door reads spec ${JSON.stringify(pin.runtime.specName)} ${pin.runtime.specVersion + 1}`],
    ["spec_version as a text of the right digits", { spec_version: String(pin.runtime.specVersion) }, `the door reads spec ${JSON.stringify(pin.runtime.specName)} ${JSON.stringify(String(pin.runtime.specVersion))}`],
  ];
  for (const [name, over, read] of cases) {
    it(`${name} is unknown, and the reason names both specs`, () => {
      answers(record(over));
      const g = provenPin(a6Pin(), AT);
      expect(g.kind).toBe("unknown");
      expect(reasonOf(g)).toContain(read);
      expect(reasonOf(g)).toContain(named);
    });
  }
});
