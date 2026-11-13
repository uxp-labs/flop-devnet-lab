// Review of decoder-shape@3 (round 29), attack 4: where a door answer becomes text in the session
// rerun's fill (test/helpers/rerun-fill.ts). Four cases: DelegateSessions with no stored value and
// with a stored empty list; FailedAcks stored as 0 and not stored. The blocks are the fourth
// recording's A9 and A10, with one answer changed.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RERUN_RESULTS, recordedRerun } from "./helpers/recorded-rerun.js";
import { ERRORS_FILE, fillStep } from "./helpers/rerun-fill.js";
import type { ReadField } from "./helpers/requests/list-4.js";

// biome-ignore lint/suspicious/noExplicitAny: the record as JSON
type Rec = Record<string, any>;
const REPO = new URL("../../", import.meta.url);
const repoText = (path: string) => readFileSync(new URL(path, REPO), "utf8");
const RESULTS = JSON.parse(repoText(RERUN_RESULTS)) as Rec;
const R = recordedRerun();
const ERRORS = (JSON.parse(repoText(ERRORS_FILE)) as { errors: Rec[] }).errors as never[];
const stepOf = (id: string) => (RESULTS.steps as Rec[]).find((s) => s.step === id) as Rec;
const blockOf = (id: string) => R.blocks.find((b) => b.step.id === id) as (typeof R.blocks)[number];

/** The fill of a step with the answer to one read set to these bytes (null: the node holds nothing there). */
function fillWith(step: string, entry: string, answer: Uint8Array | null) {
  const b = blockOf(step);
  const s = stepOf(step);
  if (!b.answer.read) throw new Error(`${step} was read`);
  const j = b.reads.findIndex((r) => r.entry === entry);
  const values = new Map(b.answer.values);
  values.set(b.keys[j] as string, answer);
  return fillStep({ ...b, answer: { read: true, values } }, R.inputs, R.metadata, s.extrinsic_index, Object.keys(s.reads_after) as ReadField[], ERRORS);
}

describe("review shape 3: default against stored where the fill writes text", () => {
  it("DelegateSessions stored as an empty list (0x00) is written empty", () => {
    expect(fillWith("A10", "DelegateSessions", new Uint8Array([0])).reads_after.delegate_sessions_of_device).toBe("empty");
  });

  it("review defect F1, fixed: DelegateSessions with no stored value is written absent, not as a stored empty list", () => {
    const absent = fillWith("A10", "DelegateSessions", null).reads_after.delegate_sessions_of_device;
    const storedEmpty = fillWith("A10", "DelegateSessions", new Uint8Array([0])).reads_after.delegate_sessions_of_device;
    // A stored value and an absent one must be told apart (P4); FailedAcks writes "absent" for its own.
    expect(absent).toBe("absent");
    expect(absent).not.toBe(storedEmpty);
  });

  it("FailedAcks stored as 0 is written 0, not absent", () => {
    expect(fillWith("A9", "FailedAcks", new Uint8Array([0, 0, 0, 0])).reads_after.failed_acks_of_named).toBe("0");
  });

  it("FailedAcks with no stored value is written absent", () => {
    expect(fillWith("A9", "FailedAcks", null).reads_after.failed_acks_of_named).toBe("absent");
  });
});
