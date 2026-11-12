/** The test helper withoutKnown (test/helpers.ts), rule T2: random parts are removed by their known values only. */
import { describe, expect, it } from "vitest";
import { withoutKnown } from "./helpers.js";

const ID = "imdflop-42-0a999b1c2d3e4f50";
const HOME = "/tmp/imd-flop-test-a999Zq";

describe("withoutKnown: random parts out by their known values", () => {
  it("a text whose request id holds 999 passes a not-999 assertion once the id is removed", () => {
    const text = `imd-flop: no answer within 60000 ms (non_finite_number). Check later with \`imd-flop receipt ${ID}\`.`;
    expect(text).toContain("999");
    expect(withoutKnown(text, [ID])).not.toContain("999");
  });
  it("a text that echoes 1e999 outside the id still holds 999", () => {
    const text = `bad body {"spare":1e999} for ${ID}`;
    expect(withoutKnown(text, [ID])).toContain("999");
  });
  it("an id that is not in the text changes nothing", () => {
    const text = "refused locally, nothing sent: eth_chainId returned malformed JSON (non_finite_number)";
    expect(withoutKnown(text, ["imdflop-42-ffffffffffffffff"])).toBe(text);
  });
  it("removes the temporary home path too, and ignores empty or missing values", () => {
    const text = `wrote ${HOME}/receipts/${ID}.json`;
    expect(withoutKnown(text, [ID, HOME, "", null, undefined])).toBe("wrote /receipts/.json");
  });
  it("matches as plain text, not as a pattern", () => {
    expect(withoutKnown("a.b axb", ["a.b"])).toBe(" axb");
  });
});
