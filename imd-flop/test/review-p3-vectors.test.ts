/**
 * Review of P3, part J: the reviewer's own reproduction of the five covered real vectors, without the
 * builder's step parser. Every value is read from research/2026-11-12-session-rerun-1014020/steps.json
 * (values, force_open_files) and results.json (steps[].call, the A6 event); the field is named beside it.
 * Passes on 165432c.
 */
import { describe, expect, it } from "vitest";
import type { InnerCall } from "../src/chain/calls.js";
import { encodeSessionCall } from "../src/chain/extrinsic.js";
import { readCall } from "../src/chain/reader.js";
import { hex, results, RT, RUNTIME_ID, steps, unhex } from "./lib/chain-fixtures.js";

const V = (k: string) => steps.values[k].value as string;
const recorded = (id: string) => results.steps.find((s: { step: string }) => s.step === id);
const stepOf = (id: string) => steps.steps.find((s: { id: string }) => s.id === id);

function forceOpen(file: string): InnerCall {
  const f = steps.force_open_files[file] as Record<string, string>;
  const v = (x: string) => V(x.slice(1));
  return {
    call: "force_open",
    miner: unhex(V("NAMED")),
    model_hash: unhex(V("MODEL")),
    measured_root: unhex(V("ROOT")),
    decode_policy_hash: unhex(V("POLICY")),
    precision: V("PRECISION"),
    // results.json accounts.dev1.public_key is $DEV1
    agent_key: unhex(f.agent_key === "$DEV1" ? results.accounts.dev1.public_key : "?"),
    sla: { max_turns: Number(V("MAX_TURNS")), max_duration: Number(V("MAX_DURATION")), reattest_every: Number(V("REATTEST")) },
    escrow: BigInt(v(f.escrow)),
    nonce: BigInt(v(f.nonce)),
  };
}

// results.json steps[A6].events: ComputeChannel.ForceOpenRequested.channel_id, which A9 expires.
const a6Channel = recorded("A6").events.find((e: { pallet: string; name: string }) => e.pallet === "ComputeChannel" && e.name === "ForceOpenRequested").fields.channel_id as string;

const cases: [string, InnerCall][] = [
  ["A3", { call: "timeout", channel_id: unhex(V("CH_PROBE")) }],
  ["A7", forceOpen("fo-2.json")],
  ["A8", forceOpen("fo-3.json")],
  ["A9", { call: "expire_force_open", channel_id: unhex(a6Channel) }],
  ["B9", { call: "timeout", channel_id: unhex(V("CH_DENY")) }],
];

describe("J (P1): the five covered vectors, reproduced from the recorded files", () => {
  for (const [id, inner] of cases) {
    it(`${id}: the call bytes equal results.json steps[${id}].call`, () => {
      const st = stepOf(id);
      const nonce = BigInt(st.call[st.call.indexOf("--nonce") + 1]);
      const bytes = encodeSessionCall({ runtime: RUNTIME_ID, owner: unhex(V("OWNER")), inner, sessionNonce: nonce });
      expect(hex(bytes)).toBe(recorded(id).call);
      // The declared spend of the step equals what the encoder computed.
      const declared = st.declared.startsWith("$") ? V(st.declared.slice(1)) : st.declared;
      expect(readCall(RT, bytes).spend).toBe(BigInt(declared));
    });
  }

  it("A5 and A6 cannot be written: their declared spend is not the escrow", () => {
    for (const id of ["A5", "A6"]) {
      const st = stepOf(id);
      const declared = st.declared.startsWith("$") ? V(st.declared.slice(1)) : st.declared;
      expect(BigInt(declared)).not.toBe(BigInt(V("ESCROW_1")));
    }
  });
});
