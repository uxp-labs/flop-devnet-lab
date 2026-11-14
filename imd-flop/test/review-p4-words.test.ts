/**
 * Review of P4 (reviewer): the words (attack 13, P14). A test's title is a claim about what it holds.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("P14: the words are true", () => {
  it("DEFECT R9 (L2): the title of the runtime dependency test in chain-table.test.ts counts the names its list holds", () => {
    const t = readFileSync(join(PKG, "test/chain-table.test.ts"), "utf8");
    const m = t.match(/it\("the runtime dependencies are the five there were before P3, and the lab's own decoder package[^"]*", \(\) => \{\s*expect\(Object\.keys\(pkg\.dependencies\)\.sort\(\)\)\.toEqual\(\[([^\]]*)\]\)/);
    expect(m).not.toBeNull(); // control: the test is where the brief says, with the title it quotes
    const listed = m![1]!.split(",").filter((s) => s.trim() !== "").length;
    const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
    expect(listed).toBe(Object.keys(pkg.dependencies).length);
    // "the five there were before P3, and the lab's own decoder package": six names.
    expect(listed).toBe(6);
  });

  it("HOLDS: the README's count of seeds in the cross vectors is the count the test pins", () => {
    const readme = readFileSync(join(PKG, "README.md"), "utf8");
    const cross = readFileSync(join(PKG, "test/channel-cross.test.ts"), "utf8");
    expect(readme).toContain("over 34 seeds");
    expect(cross).toContain("expect(SEEDS.length).toBe(34)");
  });
});
