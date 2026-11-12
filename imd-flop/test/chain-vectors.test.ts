/**
 * P3, rule E12, real vectors. For every step of research/2026-11-12-session-rerun-1014020/results.json whose
 * call is execute_via_session around one of the five inner calls with a declared spend equal to what the call
 * moves, the encoder given the step's fields from steps.json writes the recorded call bytes. Every other
 * step is named with its reason, and the strict reader refuses its bytes.
 */
import { describe, expect, it } from "vitest";
import type { InnerCall } from "../src/chain/calls.js";
import { ChainEncodeError } from "../src/chain/errors.js";
import { encodeSessionCall } from "../src/chain/extrinsic.js";
import { readCall } from "../src/chain/reader.js";
import { hex, results, RT, RUNTIME_ID, steps, unhex } from "./lib/chain-fixtures.js";

type Step = { id: string; call: string[]; signer: string };
type Recorded = { step: string; call: string; events: { pallet: string; name: string; fields: Record<string, string> }[] };

const recorded = new Map<string, Recorded>(results.steps.map((s: Recorded) => [s.step, s]));

/** A $NAME of steps.json: a value, an account of results.json, or a field of an event of a recorded step. */
function resolve(token: string): string {
  if (!token.startsWith("$")) return token;
  const name = token.slice(1);
  const ev = /^([A-Z][0-9]+)\.([A-Za-z]+)\.([A-Za-z]+)\.([a-z_]+)$/.exec(name);
  if (ev) {
    const [, step, pallet, event, field] = ev;
    const found = recorded.get(step)!.events.filter((e) => e.pallet === pallet && e.name === event);
    expect(found).toHaveLength(1);
    return found[0].fields[field];
  }
  if (Object.hasOwn(steps.values, name)) return steps.values[name].value;
  const acct = results.accounts[name.toLowerCase()];
  if (acct) return acct.public_key;
  throw new Error(`no value ${token}`);
}

const flag = (args: string[], name: string) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? undefined : args[i + 1];
};

/** The inner call a step's --inner names, or the reason the encoder does not write it. */
function innerOf(spec: string): InnerCall | string {
  const [kind, ...rest] = spec.split(":");
  const arg = rest.join(":");
  if (kind === "timeout") return { call: "timeout", channel_id: unhex(resolve(arg)) };
  if (kind === "expire") return { call: "expire_force_open", channel_id: unhex(resolve(arg)) };
  if (kind === "force-open") {
    const fo = steps.force_open_files[arg];
    const v = (n: string) => resolve(`$${n}`);
    return {
      call: "force_open",
      miner: unhex(v("NAMED")),
      model_hash: unhex(v("MODEL")),
      measured_root: unhex(v("ROOT")),
      decode_policy_hash: unhex(v("POLICY")),
      precision: v("PRECISION"),
      agent_key: unhex(resolve(fo.agent_key)),
      sla: { max_turns: Number(v("MAX_TURNS")), max_duration: Number(v("MAX_DURATION")), reattest_every: Number(v("REATTEST")) },
      escrow: BigInt(resolve(fo.escrow)),
      nonce: BigInt(resolve(fo.nonce)),
    };
  }
  return `the inner call ${kind} is not one of the five`;
}

type Plan = { id: string; covered: true; owner: string; inner: InnerCall; spend: bigint; nonce: bigint } | { id: string; covered: false; why: string; code: string };

function plan(step: Step): Plan {
  const [kind, ...args] = step.call;
  if (kind !== "via-session") return { id: step.id, covered: false, why: `${kind} is not a session call`, code: "CALL_NOT_ALLOWED" };
  const inner = innerOf(flag(args, "inner")!);
  if (typeof inner === "string") return { id: step.id, covered: false, why: inner, code: "CALL_NOT_ALLOWED" };
  const spend = BigInt(resolve(flag(args, "spend")!));
  const moves = inner.call === "force_open" ? inner.escrow : 0n;
  if (spend !== moves) return { id: step.id, covered: false, why: `declared ${spend} raw, the call moves ${moves} raw`, code: "SPEND_MISMATCH" };
  return { id: step.id, covered: true, owner: resolve(flag(args, "owner")!), inner, spend, nonce: BigInt(resolve(flag(args, "nonce")!)) };
}

const plans: Plan[] = steps.steps.map(plan);

describe("E12: the real vectors of the 1014020 rerun", () => {
  it("every step of results.json has a plan, in the same order", () => {
    expect(plans.map((p) => p.id)).toEqual(results.steps.map((s: Recorded) => s.step));
    expect(plans).toHaveLength(23);
  });

  it("the covered steps are A3, A7, A8, A9 and B9; the others are named with their reason", () => {
    expect(plans.filter((p) => p.covered).map((p) => p.id)).toEqual(["A3", "A7", "A8", "A9", "B9"]);
    const why = Object.fromEntries(plans.filter((p): p is Extract<Plan, { covered: false }> => !p.covered).map((p) => [p.id, p.why]));
    expect(why.A5).toBe("declared 0 raw, the call moves 10000000000000000 raw");
    expect(why.A6).toBe("declared 12000000000000000 raw, the call moves 10000000000000000 raw");
    expect(why.A4).toBe("the inner call remark is not one of the five");
    expect(why.B2).toBe("the inner call denied is not one of the five");
    expect(why.A1).toBe("transfer is not a session call");
  });

  for (const p of plans) {
    if (p.covered) {
      it(`${p.id}: the encoder writes the recorded call bytes (${p.inner.call})`, () => {
        const bytes = encodeSessionCall({ runtime: RUNTIME_ID, owner: unhex(p.owner), inner: p.inner, sessionNonce: p.nonce });
        expect(hex(bytes)).toBe(recorded.get(p.id)!.call);
        const back = readCall(RT, bytes);
        expect(back.spend).toBe(p.spend);
        expect(back.sessionNonce).toBe(p.nonce);
      });
    } else {
      it(`${p.id}: not covered (${p.why}); the strict reader refuses its bytes with ${p.code}`, () => {
        const bytes = unhex(recorded.get(p.id)!.call);
        let code: string | null = null;
        try {
          readCall(RT, bytes);
        } catch (e) {
          code = e instanceof ChainEncodeError ? e.refusal : String(e);
        }
        expect(code).toBe(p.code);
      });
    }
  }
});
