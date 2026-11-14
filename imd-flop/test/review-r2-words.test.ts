/**
 * Review of piece R, second branch (reviewer, not the builder): attack 9, the words against the tests (P9).
 *
 * What the receipt vector shows: in two settles the chain took, the agent's signature verifies over receiptMessage's
 * bytes with payable the stored escrow. What it does not show: that the chain checks that signature at all, or
 * refuses a settle whose signature is over other bytes (no such settle was ever sent; the pallet's source is not
 * public). The lead's finding L1 names the comment's "what the chain accepted". This test holds the comment and the
 * README's "Channel key" section to saying the second part. It also holds them to saying that the two settles carry
 * no number at or above 2^64, so the upper half of each u128 field is not shown by them (RR2-1).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const comment = (() => {
  const t = readFileSync(join(HERE, "..", "src", "channel", "transcript.ts"), "utf8");
  const end = t.indexOf("export function receiptMessage");
  return t.slice(t.lastIndexOf("/**", end), end);
})();
const channelKey = (() => {
  const t = readFileSync(join(HERE, "..", "README.md"), "utf8");
  const a = t.indexOf("What the chain has shown, and what it has not");
  return t.slice(a, t.indexOf("The key:", a));
})();
const notShownRefusal = /not shown[^.]*(?:refuses|rejects|checks|verifies)[^.]*(?:settle|signature)/i;

describe("attack 9: the words of the receipt say what the tests hold and no more", () => {
  it("HOLDS (was DEFECT RR2-5): receiptMessage's comment does not say the chain accepted a payable, and says that a refusal of a wrong receipt is not shown", () => {
    expect(comment).toContain("receipt message");
    expect(comment).not.toMatch(/the[\s*]+chain[\s*]+accepted/i);
    expect(comment).toMatch(notShownRefusal);
  });

  it("HOLDS (was DEFECT RR2-5): the README's Channel key section says that the chain's refusal of a settle whose receipt signature is over other bytes is not shown", () => {
    expect(channelKey).toContain("Shown: the receipt");
    expect(channelKey).toMatch(notShownRefusal);
  });

  it("HOLDS (was DEFECT RR2-1 words): the README's Channel key section says the two settles hold every u128 below 2^64, so the upper half of each u128 is held by the SDK's layout and not by them", () => {
    expect(channelKey).toMatch(/2\^64|64 bits|upper (?:half|8 bytes)|high(?:er)? (?:half|bytes)/i);
  });
});
