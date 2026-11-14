// Review o1 (round 33), attack 3, the part that holds: tapeAnswer refuses a tape it cannot read
// as written. Kept apart from review-o1-runtime.test.ts, whose DEFECT tests fail by design, so the
// mutation runner's control passes on this file (promise P4).
// tapeAnswer and specNamed must refuse every field that does not name a read of
// System.LastRuntimeUpgrade at the gateway's settled block. Each tape these tests hand in is the
// committed first recording's tape, or a copy of it with one stated change, written to a fresh
// temporary folder. Nothing here reads the network.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EVENTS_KEY, LAST_RUNTIME_UPGRADE_KEY } from "./helpers/recorded.js";
import { RUNTIME, TAPE } from "./helpers/requests/list-6.js";
import { specNamed, tapeAnswer } from "./helpers/requests-list.js";

const REPO = new URL("../../", import.meta.url);
const TAPE_TEXT = readFileSync(new URL(TAPE, REPO), "utf8");
const LINES = TAPE_TEXT.split("\n");
type Entry = { seq: number; request: { kind: string; method: string; params: unknown[] }; answer: Record<string, unknown> };
const entryAt = (seq: number) => JSON.parse(LINES[seq + 1] ?? "null") as Entry;
const GATEWAY_SETTLED_HASH = entryAt(18).answer.result as string;
const field = (seq: number) => `the answer to the state_getStorage call at seq ${seq}`;

const DIR = mkdtempSync(join(tmpdir(), "review-o1-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));
let n = 0;
/** A copy of the first tape with its lines handed through f, written to the temporary folder; its absolute path. */
function tapeWith(f: (lines: string[]) => string[]): string {
  const path = join(DIR, `tape-${n++}.jsonl`);
  writeFileSync(path, f([...LINES]).join("\n"));
  return path;
}
const setLine = (seq: number, g: (e: Entry) => Entry) => (lines: string[]) => {
  lines[seq + 1] = JSON.stringify(g(entryAt(seq)));
  return lines;
};

describe("review o1: tapeAnswer reads a call only where the tape holds it as written (P4)", () => {
  it("HOLDS: a call with an error answer is refused", () => {
    const path = tapeWith(setLine(21, (e) => ({ ...e, answer: { error: { code: -32000, message: "state pruned" } } })));
    expect(() => tapeAnswer(path, field(21))).toThrow("holds no answer to the call at seq 21");
  });

  it("HOLDS: a seq past the end of the tape is refused", () => {
    expect(() => tapeAnswer(TAPE, field(LINES.length + 5))).toThrow(`holds no state_getStorage call at seq ${LINES.length + 5}`);
  });

  it("HOLDS: a tape whose lines are in another order is refused at the seq that moved (the line's own seq is checked)", () => {
    const path = tapeWith((lines) => {
      const a = lines[21] as string;
      lines[21] = lines[22] as string;
      lines[22] = a;
      return lines;
    });
    expect(() => tapeAnswer(path, field(21))).toThrow("holds no state_getStorage call at seq 21");
  });

  it("HOLDS: a tape without its schema line is refused, not read one line off", () => {
    const path = tapeWith((lines) => lines.slice(1));
    expect(() => tapeAnswer(path, field(20))).toThrow("holds no state_getStorage call at seq 20");
  });

  it("HOLDS: an answer of null (a key that holds nothing) names no runtime", () => {
    const path = tapeWith(setLine(21, (e) => ({ ...e, answer: { result: null } })));
    expect(() => specNamed({ file: path, field: field(21), block: "gateway/settled" })).toThrow();
  });
});
