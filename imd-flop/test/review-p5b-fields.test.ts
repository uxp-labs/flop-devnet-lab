/**
 * Review of P5b, attack 9 (promise P12): rules of src/session that no builder test held, found by mutants in a copy
 * (the JSON's spent and the breaker's total_spend under their own names, a pallet name with a space or a control
 * character, a chain cap one raw unit above its local cap). The node is the rerun's recording at A6
 * (research/2026-11-12-session-rerun-1014020/results.json `steps[A6].block_hash`); a state no recording holds is
 * A6 with the named field changed. No socket.
 */
import { describe, expect, it } from "vitest";
import { amountText } from "../src/chain/describe.js";
import type { Script } from "./lib/recorded-node.js";
import { copyScript, DEV1, keysOf, OWNER, scriptAt, seatHome, session, transportOf, withField } from "./lib/session-fixtures.js";

const K1 = keysOf(OWNER.public_key, DEV1.public_key);
const show = (script: Script, json: boolean, home = seatHome()) => session(home, ["show", "--owner", OWNER.ss58, ...(json ? ["--json"] : [])], transportOf(script));

/** A6 with a record whose allow list is one name of the given bytes. */
function withOneName(s: Script, name: Uint8Array): Script {
  const c = copyScript(s);
  const k = `${s.head} ${K1.sessions}`;
  const body = (c.storage.get(k) as string).slice(2);
  const listAt = 2 * (32 + 32 + 16 * 3 + 16 + 4 + 16 + 4);
  c.storage.set(k, `0x${body.slice(0, listAt)}04${(name.length << 2).toString(16).padStart(2, "0")}${Buffer.from(name).toString("hex")}${body.slice(-2)}`);
  return c;
}

describe("review P5b, attack 9: what the mutants left alive", () => {
  it("HOLDS: show at A6 with spent and epoch_spent made different (spent set to 7 raw more than epoch_spent): each JSON amount is the words' amount of the same name", async () => {
    const base = (await show(scriptAt("A6"), true)).json().session.value;
    const s = withField(scriptAt("A6"), K1.sessions, "session", "spent", BigInt(base.epoch_spent) + 7n);
    const j = (await show(s, true)).json();
    const words = (await show(s, false)).out.split("\n");
    for (const f of ["spending_cap", "per_tx_limit", "daily_cap", "spent", "epoch_spent"]) {
      const line = words.find((l) => l.trim().startsWith(`${f} `))!;
      expect([f, line.trim().replace(/\s+/, " ")]).toEqual([f, `${f} ${amountText(BigInt(j.session.value[f]))}`]);
    }
    expect(j.session.value.spent).toBe(String(BigInt(base.epoch_spent) + 7n));
  });

  it("HOLDS: show at A6 with the breaker's tx_count and total_spend made different (tx_count 3, total_spend 5 raw): the JSON gives each under its own name", async () => {
    const s = withField(withField(scriptAt("A6"), K1.breakers, "breaker", "tx_count", 3n), K1.breakers, "breaker", "total_spend", 5n);
    const j = (await show(s, true)).json();
    expect(j.circuit_breaker.value).toMatchObject({ tx_count: 3, total_spend: "5" });
    expect((await show(s, false)).out).toContain(`tx_count 3, total_spend ${amountText(5n)}`);
  });

  for (const [name, bytes] of [["with a space inside", "Compute Channel"], ["with a newline", "ComputeChannel\n"], ["empty", ""]] as const) {
    it(`HOLDS: show at A6 with one allow list name ${name}: the name is shown as its hex, not as text, in words and JSON`, async () => {
      const raw = new TextEncoder().encode(bytes);
      const s = withOneName(scriptAt("A6"), raw);
      const hex = `0x${Buffer.from(raw).toString("hex")}`;
      expect((await show(s, true)).json().session.value.allowed_pallets).toEqual([hex]);
      expect((await show(s, false)).out).toContain(`allowed_pallets  [${hex}]`);
    });
  }

  it("HOLDS: a chain cap one raw unit above its local cap (A6's per_tx_limit and daily_cap each set to the local cap plus 1 raw) gets its note", async () => {
    const home = seatHome();
    const local = (await show(scriptAt("A6"), true, home)).json().local_caps.value;
    const s = withField(withField(scriptAt("A6"), K1.sessions, "session", "per_tx_limit", BigInt(local.per_call) + 1n), K1.sessions, "session", "daily_cap", BigInt(local.daily) + 1n);
    const notes: string[] = (await show(s, true, home)).json().notes;
    expect(notes.filter((n) => /is above the seat's/.test(n)).length).toBe(2);
    const equal: string[] = (await show(scriptAt("A6"), true, home)).json().notes;
    expect(equal.filter((n) => /is above the seat's/.test(n))).toEqual([]);
  });
});
