/**
 * P4, rules B1 and T1: the channel id against three records of the chain. Every input and every expected id is read
 * from a committed file at test time, and each test names the file and the field. Nothing is typed (CLAUDE.md rule 6).
 * For each record, five wrong forms of the preimage, each computed here, give an id other than the recorded one.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { blake2b } from "@noble/hashes/blake2.js";
import { describe, expect, it } from "vitest";
import { channelId, CHANNEL_ID_DOMAIN, CHANNEL_ID_VERSION } from "../src/channel/transcript.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RESEARCH = join(REPO, "research");
const json = (rel: string) => JSON.parse(readFileSync(join(RESEARCH, rel), "utf8"));

const unhex = (h: string): Uint8Array => {
  expect(h).toMatch(/^0x(?:[0-9a-f]{2})*$/);
  return Uint8Array.from(Buffer.from(h.slice(2), "hex"));
};
const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;
const le = (n: bigint, width: number) => Uint8Array.from({ length: width }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
const be = (n: bigint, width: number) => le(n, width).reverse();
const cat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => Array.from(p)));
const ascii = (s: string) => Uint8Array.from(Buffer.from(s, "ascii"));
const nonceOf = (s: unknown): bigint => {
  expect(typeof s).toBe("string");
  expect(s).toMatch(/^[0-9]+$/);
  return BigInt(s as string);
};

interface Case {
  readonly name: string;
  readonly genesis: Uint8Array;
  readonly agent: Uint8Array;
  readonly miner: Uint8Array;
  readonly nonce: bigint;
  readonly expected: string;
}

/** The ids that five wrong preimages give, each laid out here and not through src. */
function wrongForms(c: Case): Record<string, string> {
  const h = (b: Uint8Array) => hex(blake2b(b, { dkLen: 32 }));
  const domain = ascii("FLOP/COMPUTE_CHANNEL/ID");
  const changed = Uint8Array.from(domain);
  changed[5] ^= 0x20; // one letter of the domain in the other case
  return {
    "a changed domain letter": h(cat(changed, Uint8Array.of(1), c.genesis, c.agent, c.miner, le(c.nonce, 8))),
    "no version byte": h(cat(domain, c.genesis, c.agent, c.miner, le(c.nonce, 8))),
    "agent and miner swapped": h(cat(domain, Uint8Array.of(1), c.genesis, c.miner, c.agent, le(c.nonce, 8))),
    "the nonce big endian": h(cat(domain, Uint8Array.of(1), c.genesis, c.agent, c.miner, be(c.nonce, 8))),
    "the nonce as four bytes": h(cat(domain, Uint8Array.of(1), c.genesis, c.agent, c.miner, le(c.nonce & 0xffffffffn, 4))),
  };
}

/** research/2026-11-11-session-escrow/results.json, spec 1014014. */
function escrowCase(): Case & { readonly call: string; readonly others: bigint[] } {
  const r = json("2026-11-11-session-escrow/results.json");
  const nonces = r.force_open.channel_nonces;
  return {
    name: "escrow 1014014",
    genesis: unhex(r.chain.genesis), // chain.genesis
    agent: unhex(r.owner.public_key), // owner.public_key
    miner: unhex(r.named_miner.public_key), // named_miner.public_key
    nonce: nonceOf(nonces.A), // force_open.channel_nonces.A
    expected: r.channel.id, // channel.id
    call: r.steps[3].call, // steps[3].call, the step "4-force-open-declared-0.012"
    others: [nonceOf(nonces.B), nonceOf(nonces.C)], // force_open.channel_nonces.B and .C
  };
}

/** research/2026-11-12-session-rerun-1014020: results.json and steps.json. */
function rerunCase(): Case {
  const r = json("2026-11-12-session-rerun-1014020/results.json");
  const s = json("2026-11-12-session-rerun-1014020/steps.json");
  const a6 = r.steps.filter((x: { step: string }) => x.step === "A6");
  expect(a6.length).toBe(1);
  const ev = a6[0].events.filter((e: { pallet: string; name: string }) => e.pallet === "ComputeChannel" && e.name === "ForceOpenRequested");
  expect(ev.length).toBe(1);
  // steps.json: step A6 runs force-open:fo-1.json, whose nonce is $N1.
  const step = s.steps.filter((x: { id: string }) => x.id === "A6");
  expect(step.length).toBe(1);
  expect(step[0].call).toContain("force-open:fo-1.json");
  expect(s.force_open_files["fo-1.json"].nonce).toBe("$N1");
  return {
    name: "rerun 1014020, A6",
    genesis: unhex(r.chain.genesis), // results.json chain.genesis
    agent: unhex(r.accounts.owner.public_key), // results.json accounts.owner.public_key
    miner: unhex(s.values.NAMED.value), // steps.json values.NAMED.value
    nonce: nonceOf(s.values.N1.value), // steps.json values.N1.value
    expected: ev[0].fields.channel_id, // results.json steps[A6].events[ComputeChannel.ForceOpenRequested].fields.channel_id
  };
}

/** research/2026-11-12-encoder-devnet-test: results.final.json and steps.json, step T3. */
function encoderCase(): Case & { readonly recordKey: string; readonly agentField: string; readonly minerField: string; readonly planned: { miner: string; nonce: bigint } } {
  const r = json("2026-11-12-encoder-devnet-test/results.final.json");
  const s = json("2026-11-12-encoder-devnet-test/steps.json");
  const t3 = r.steps.filter((x: { step: string }) => x.step === "T3");
  expect(t3.length).toBe(1);
  const ev = t3[0].events.filter((e: { pallet: string; name: string }) => e.pallet === "ComputeChannel" && e.name === "ForceOpenRequested");
  expect(ev.length).toBe(1);
  const record = t3[0].after.channel;
  const expected: string = ev[0].fields.channel_id;
  const keys = Object.keys(t3[0].raw_reads).filter((k) => k.endsWith(expected.slice(2)));
  expect(keys.length).toBe(1);
  return {
    name: "encoder devnet test 1014020, T3",
    genesis: unhex(r.chain.genesis), // results.final.json chain.genesis
    agent: unhex(record.agent), // results.final.json steps[T3].after.channel.agent
    miner: unhex(record.miner), // results.final.json steps[T3].after.channel.miner
    nonce: nonceOf(record.nonce), // results.final.json steps[T3].after.channel.nonce
    expected, // results.final.json steps[T3].events[ComputeChannel.ForceOpenRequested].fields.channel_id
    recordKey: keys[0] as string, // results.final.json steps[T3].raw_reads: the channel record's key ends with the id
    agentField: ev[0].fields.agent,
    minerField: ev[0].fields.miner,
    planned: { miner: s.values.NAMED.value, nonce: nonceOf(s.values.N_T3.value) }, // steps.json values.NAMED and values.N_T3
  };
}

const CASES = [escrowCase, rerunCase, encoderCase];

describe("B1, T1: the channel id against three records of the chain", () => {
  it("the domain is 23 ASCII bytes and the version byte is 1", () => {
    expect(CHANNEL_ID_DOMAIN).toBe("FLOP/COMPUTE_CHANNEL/ID");
    expect(Buffer.from(CHANNEL_ID_DOMAIN, "ascii").length).toBe(23);
    expect(CHANNEL_ID_VERSION).toBe(1);
  });

  for (const make of CASES) {
    it(`${make().name}: the lab's id is the recorded id`, () => {
      const c = make();
      expect(c.expected).toMatch(/^0x[0-9a-f]{64}$/);
      expect(hex(channelId({ genesis: c.genesis, agent: c.agent, miner: c.miner, nonce: c.nonce }))).toBe(c.expected);
    });

    it(`${make().name}: five wrong forms of the preimage each give another id`, () => {
      const c = make();
      const wrong = wrongForms(c);
      expect(Object.keys(wrong).length).toBe(5);
      for (const [form, id] of Object.entries(wrong)) expect(id, form).not.toBe(c.expected);
    });
  }

  it("escrow 1014014: the call that opened the channel carries nonce A, and not B or C", () => {
    const c = escrowCase();
    const leHex = (n: bigint) => Buffer.from(le(n, 8)).toString("hex");
    expect(c.call).toMatch(/^0x[0-9a-f]+$/);
    expect(c.call.split(leHex(c.nonce)).length - 1).toBe(1);
    for (const n of c.others) expect(c.call).not.toContain(leHex(n));
    for (const n of c.others) expect(hex(channelId({ genesis: c.genesis, agent: c.agent, miner: c.miner, nonce: n }))).not.toBe(c.expected);
  });

  it("encoder devnet test T3: the record, the event and the plan agree on the inputs", () => {
    const c = encoderCase();
    expect(c.recordKey.slice(-64)).toBe(c.expected.slice(2));
    expect(c.agentField).toBe(hex(c.agent));
    expect(c.minerField).toBe(hex(c.miner));
    expect(c.planned.miner).toBe(hex(c.miner));
    expect(c.planned.nonce).toBe(c.nonce);
  });

  it("the three records are three different channels", () => {
    expect(new Set(CASES.map((m) => m().expected)).size).toBe(3);
  });
});
