/**
 * P5a, T3: the reference encoder (@polkadot-api, dev only, from the recorded 1014020 metadata, as
 * test/chain-reference.test.ts uses it) agrees with the encoder's owner calls over a grid: delegates, caps at the
 * edges (1, the order's edges, the largest u128) and durations at 1 and at the longest. For each point the
 * reference writes the call from the same values and gets the same bytes, and reads the encoder's bytes back to
 * those values.
 */
import { Binary } from "@polkadot-api/substrate-bindings";
import { describe, expect, it } from "vitest";
import { OWNER_ALLOWED_PALLET } from "../src/chain/calls.js";
import { encodeOwnerCall } from "../src/chain/owner-calls.js";
import { concat } from "../src/chain/scale.js";
import { filled, hex, readJson, ref, refCall, RERUN, results, RUNTIME_ID, U128_MAX } from "./lib/chain-fixtures.js";

const facts = readJson(`${RERUN}/facts-1014020.json`);
const MAX = Number(facts.constants.FlopSessionKeys.MaxSessionDuration.value);
const account = ref.buildDefinition(0);
const create = ref.buildCall("FlopSessionKeys", "create_session");
const revoke = ref.buildCall("FlopSessionKeys", "revoke_session");
const recorded = (results.steps as { step: string; events: { name: string; fields: Record<string, string> }[] }[]).find((s) => s.step === "A2")!.events.find((e) => e.name === "SessionCreated")!.fields;

const delegates = [filled(0), filled(0xff), Uint8Array.from({ length: 32 }, (_, i) => i), Uint8Array.from(Buffer.from(recorded.delegate.slice(2), "hex"))];
/** [spending_cap, per_tx_limit, daily_cap]: each in order per_tx <= daily <= spending. */
const caps: [bigint, bigint, bigint][] = [
  [1n, 1n, 1n],
  [U128_MAX, U128_MAX, U128_MAX],
  [U128_MAX, 1n, 1n],
  [U128_MAX, 1n, U128_MAX],
  [U128_MAX, U128_MAX - 1n, U128_MAX - 1n],
  [2n, 1n, 2n],
  [BigInt(recorded.spending_cap), BigInt(recorded.per_tx_limit), BigInt(recorded.daily_cap)],
];
const durations = [1, 2, MAX - 1, MAX];

describe("T3: the reference encoder agrees with the owner calls", () => {
  it("the grid has every delegate, cap row and duration", () => {
    expect(delegates.length * caps.length * durations.length).toBe(112);
  });

  it("create_session at every point of the grid", () => {
    for (const delegate of delegates) {
      for (const [spending_cap, per_tx_limit, daily_cap] of caps) {
        for (const duration_blocks of durations) {
          const bytes = encodeOwnerCall({ runtime: RUNTIME_ID, call: "create_session", delegate, spending_cap, per_tx_limit, daily_cap, duration_blocks });
          const value = { delegate: account.dec(delegate), spending_cap, per_tx_limit, daily_cap, duration_blocks, allowed_pallets: [Binary.fromText(OWNER_ALLOWED_PALLET)] };
          const mine = hex(bytes);
          expect(hex(concat(Uint8Array.from(create.location), create.codec.enc(value)))).toBe(mine);
          const back = refCall.dec(bytes);
          expect([back.type, back.value.type]).toEqual(["FlopSessionKeys", "create_session"]);
          const v = back.value.value;
          expect([hex(account.enc(v.delegate)), v.spending_cap, v.per_tx_limit, v.daily_cap, v.duration_blocks]).toEqual([hex(delegate), spending_cap, per_tx_limit, daily_cap, duration_blocks]);
          expect(v.allowed_pallets.map((b: never) => Binary.toText(b))).toEqual([OWNER_ALLOWED_PALLET]);
          expect(hex(refCall.enc(back))).toBe(mine);
        }
      }
    }
  });

  it("revoke_session for every delegate", () => {
    for (const delegate of delegates) {
      const bytes = encodeOwnerCall({ runtime: RUNTIME_ID, call: "revoke_session", delegate });
      expect(hex(concat(Uint8Array.from(revoke.location), revoke.codec.enc({ delegate: account.dec(delegate) })))).toBe(hex(bytes));
      const back = refCall.dec(bytes);
      expect([back.type, back.value.type, hex(account.enc(back.value.value.delegate))]).toEqual(["FlopSessionKeys", "revoke_session", hex(delegate)]);
    }
  });
});
