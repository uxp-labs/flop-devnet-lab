/**
 * A run of the miner client against the scripted miner, for the tests of P6b. C comes from a fixed test seed
 * (`channelKeyFromSeed`, S38), wrapped so that a test counts each of its signatures by layout. The clock and the
 * random source are fixed and counted.
 */
import { channelKeyFromSeed, type ChannelKey } from "../../src/channel/key.js";
import { minerRun, type MinerRun, type TurnMoney } from "../../src/miner/client.js";
import { minerEndpoint } from "../../src/miner/endpoint.js";
import { minerExpected } from "../../src/miner/expected.js";
import { expectedInputOf } from "./miner-answers.js";
import { MAX_TOKENS, MESSAGES, scriptedMiner, type ScriptedMiner, type Switches } from "./scripted-miner.js";

export interface Counted {
  readonly key: ChannelKey;
  readonly signs: { request: number; ack: number; receipt: number };
}

/** C from a fixed seed, wrapped: the four functions of a channel key, each signing call counted. */
export function countedKey(seedByte = 3): Counted {
  const inner = channelKeyFromSeed({ seed: new Uint8Array(32).fill(seedByte) });
  const signs = { request: 0, ack: 0, receipt: 0 };
  const key: ChannelKey = Object.freeze({
    publicKey: () => inner.publicKey(),
    signRequest: (f: Parameters<ChannelKey["signRequest"]>[0]) => {
      signs.request += 1;
      return inner.signRequest(f);
    },
    signTurnAck: (f: Parameters<ChannelKey["signTurnAck"]>[0]) => {
      signs.ack += 1;
      return inner.signTurnAck(f);
    },
    signReceipt: (f: Parameters<ChannelKey["signReceipt"]>[0]) => {
      signs.receipt += 1;
      return inner.signReceipt(f);
    },
  });
  return { key, signs };
}

/** The money of a turn that holds the scenario's G_n of 38 (a price of 3e15 per G_n and a base of 1, as R2's settles show). */
export const MONEY: TurnMoney = Object.freeze({ gnCeiling: 1000n, pricePerGn: 3_000_000_000_000_000n, basePerTurn: 1n, floor: 1n, budget: 200_000_000_000_000_000n });
/** The payable of the honest run: the scenario's G_n times the price plus 2, as R2's settles show. */
export const PAYABLE = 38n * 3_000_000_000_000_000n + 2n;

export interface Rig {
  readonly run: MinerRun;
  readonly miner: ScriptedMiner;
  readonly signs: Counted["signs"];
  readonly key: ChannelKey;
  readonly clock: { calls: number };
}

/** A run and its scripted miner. */
export function rig(sw: Switches = {}, o: { now?: () => bigint } = {}): Rig {
  const { key, signs } = countedKey();
  const miner = scriptedMiner(key.publicKey(), sw);
  const clock = { calls: 0 };
  let t = 1_763_100_000_000n;
  const run = minerRun({
    expected: minerExpected(expectedInputOf(miner.scenario)),
    endpoint: minerEndpoint("https://miner.example"),
    transport: miner.transport as never,
    key,
    nowMs:
      o.now ??
      (() => {
        clock.calls += 1;
        t += 700n;
        return t;
      }),
    random: (n: number) => new Uint8Array(n).fill(0x5a),
    limits: {},
  });
  return { run, miner, signs, key, clock };
}

/** The turn input of the scripted runs. */
export const turnArgs = (money: TurnMoney = MONEY) => ({ messages: MESSAGES.map((m) => ({ ...m })), maxTokens: MAX_TOKENS, money });

/** Runs the steps in order, up to and including `last`. */
export async function upTo(r: Rig, last: "prove" | "authenticate" | "notifyOpen" | "turn"): Promise<void> {
  await r.run.prove();
  if (last === "prove") return;
  await r.run.authenticate({ channelId: r.miner.scenario.channelId });
  if (last === "authenticate") return;
  await r.run.notifyOpen();
  if (last === "notifyOpen") return;
  await r.run.turn(turnArgs());
}
