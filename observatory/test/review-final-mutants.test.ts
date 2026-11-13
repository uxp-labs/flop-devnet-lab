// Review of piece F (round 32): rules of the encoder fill that no test of the branch holds. Each
// test here passes on 4ab11aa and kills a mutant of mutants/review-final.json that the author's
// test/encoder-results.test.ts leaves alive. Offline, from committed files.
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pinBlock } from "./helpers/block-fill.js";
import { beforeFill, chainFill, readsOf, sentFill } from "./helpers/encoder-fill.js";
import { ENCODER_RUN_TIME, type EncoderBlock, encoderMetadata, recordedEncoder } from "./helpers/recorded-encoder.js";

type Rec = Record<string, any>;
const RUN = JSON.parse(readFileSync(new URL(`../../${ENCODER_RUN_TIME}`, import.meta.url), "utf8")) as Rec;
const R = recordedEncoder();
const MD = encoderMetadata();
const B = getDynamicBuilder(getLookupFn(unifyMetadata(decAnyMetadata(MD))));
const blockOf = (id: string) => R.blocks.find((b) => b.id === id) as EncoderBlock;

describe("the session's two spent fields are each their own stored field (mutant r32rv-spent-epoch-swapped)", () => {
  it("a stored session whose spent and epoch_spent differ is written spent_raw = spent and epoch_spent_raw = epoch_spent", () => {
    const b = blockOf("T3");
    const p = pinBlock(b.answer, b.keys[0], b.keys[1], MD);
    if (p.state !== "decoded") throw new Error("T3 decodes");
    const j = b.reads.findIndex((r) => r.entry === "Sessions");
    const st = B.buildStorage("FlopSessionKeys", "Sessions");
    const real = st.value.dec(p.values.get(b.keys[j] as string) as Uint8Array) as Rec;
    // On the tape spent equals epoch_spent at every block: a made session tells them apart.
    expect(real.spent).toBe(real.epoch_spent);
    const made = st.value.enc({ ...real, spent: 7n, epoch_spent: 3n });
    const values = new Map(p.values);
    values.set(b.keys[j] as string, made);
    const after = readsOf(b, p.pin, values, R.inputs).after;
    expect(after.session).toEqual({ active: String(real.active), spent_raw: "7", epoch_spent_raw: "3" });
  });
});

describe("a step or the start is filled only from the block whose number the run time record names (mutants r32rv-step-number-unchecked, r32rv-before-number-unchecked)", () => {
  it("T3's chain fields stay empty when the run time record names another number for the same hash", () => {
    const s = (RUN.steps as Rec[]).find((x) => x.step === "T3") as Rec;
    const ext = sentFill(s).extrinsic;
    expect(chainFill(blockOf("T3"), s.run_time.sent, ext, R.inputs, R.metadata)).not.toEqual({});
    expect(chainFill(blockOf("T3"), { ...s.run_time.sent, block_number: s.run_time.sent.block_number + 1 }, ext, R.inputs, R.metadata)).toEqual({});
  });

  it("before stays the run time record's when the start's number is not the block's", () => {
    const start = blockOf("start");
    expect(beforeFill(start, RUN.start.finalized, R.inputs, R.metadata)).not.toBeNull();
    expect(beforeFill(start, { ...RUN.start.finalized, number: RUN.start.finalized.number + 1 }, R.inputs, R.metadata)).toBeNull();
  });
});
