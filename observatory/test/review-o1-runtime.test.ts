// Review o1 (round 33), attack 3: the runtime the sixth list's keys are built for (promise P4).
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

describe("review o1: the runtime is named only by a read of System.LastRuntimeUpgrade at the settled block (P4)", () => {
  it("HOLDS: the field the plan uses names seq 21, a read of the System.LastRuntimeUpgrade key at the gateway's settled block, the hash the tape answered at seq 18", () => {
    expect(RUNTIME.field).toBe(field(21));
    expect(entryAt(21).request.params).toEqual([LAST_RUNTIME_UPGRADE_KEY, GATEWAY_SETTLED_HASH]);
    expect(entryAt(18).request.params).toEqual([3479299]);
  });

  it("DEFECT O1-1: specNamed takes a System.LastRuntimeUpgrade read at another block (seq 5, block 3479238) as the runtime of the list", () => {
    // seq 5 reads the same key at the hash of 3479238, which is not a settled block.
    expect(entryAt(5).request.params[0]).toBe(LAST_RUNTIME_UPGRADE_KEY);
    expect(entryAt(5).request.params[1]).not.toBe(GATEWAY_SETTLED_HASH);
    expect(() => specNamed({ file: TAPE, field: field(5), block: RUNTIME.block })).toThrow();
  });

  it("DEFECT O1-2: specNamed takes a state_getStorage of another key (System.Events at seq 20) whose answer is LastRuntimeUpgrade bytes", () => {
    const path = tapeWith(setLine(20, (e) => ({ ...e, answer: { result: entryAt(21).answer.result } })));
    expect(JSON.parse(readFileSync(path, "utf8").split("\n")[21] ?? "null").request.params[0]).toBe(EVENTS_KEY);
    expect(() => specNamed({ file: path, field: field(20), block: RUNTIME.block })).toThrow();
  });

  it("DEFECT O1-3: tapeAnswer takes a call whose request is not an rpc request (kind changed), since only the method is checked", () => {
    const path = tapeWith(setLine(21, (e) => ({ ...e, request: { ...e.request, kind: "not-rpc" } })));
    expect(() => tapeAnswer(path, field(21))).toThrow();
  });

});
