/**
 * Review of P4 (reviewer): the channel id records (attack 4). The builder's test reads the rerun's nonce from the
 * plan (steps.json values.N1.value). This holds that the executed call carries it, and that the three records are
 * three nonces, every value read from the committed files named here.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { channelId } from "../src/channel/transcript.js";

const RESEARCH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "research");
const json = (rel: string) => JSON.parse(readFileSync(join(RESEARCH, rel), "utf8"));
const leHex = (n: bigint) => Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => Uint8Array.from(Buffer.from(h.slice(2), "hex"));
const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;

describe("attack 4: the channel id records", () => {
  it("HOLDS: the rerun's executed call (results.json steps[A6].call) carries the planned nonce N1 once, and the event's agent and miner are the inputs", () => {
    const r = json("2026-11-12-session-rerun-1014020/results.json");
    const s = json("2026-11-12-session-rerun-1014020/steps.json");
    const a6 = r.steps.filter((x: { step: string }) => x.step === "A6")[0];
    const n1 = BigInt(s.values.N1.value); // steps.json values.N1.value
    expect(a6.call.split(leHex(n1)).length - 1).toBe(1);
    const ev = a6.events.filter((e: { name: string }) => e.name === "ForceOpenRequested")[0].fields;
    expect(ev.agent).toBe(r.accounts.owner.public_key); // results.json accounts.owner.public_key
    expect(ev.miner).toBe(s.values.NAMED.value); // steps.json values.NAMED.value
    expect(hex(channelId({ genesis: unhex(r.chain.genesis), agent: unhex(ev.agent), miner: unhex(ev.miner), nonce: n1 }))).toBe(ev.channel_id);
  });

  it("HOLDS: the three records carry three different nonces", () => {
    const a = BigInt(json("2026-11-11-session-escrow/results.json").force_open.channel_nonces.A); // force_open.channel_nonces.A
    const b = BigInt(json("2026-11-12-session-rerun-1014020/steps.json").values.N1.value); // values.N1.value
    const t3 = json("2026-11-12-encoder-devnet-test/results.final.json").steps.filter((x: { step: string }) => x.step === "T3")[0];
    const c = BigInt(t3.after.channel.nonce); // steps[T3].after.channel.nonce
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
