/**
 * The order of a run of the miner client (R1 to R7, M-9). One function makes a run from what is handed in: the
 * pinned values, the endpoint value, a transport, the channel key C, a clock, a random source and the limits. The
 * run holds its state in memory, writes nothing, and its only members are its five steps, each allowed once and
 * only in this order:
 *
 *  1. `prove()`: before anything is funded. POST the info proof with a fresh challenge, and verify the answer
 *     under the pinned key. Returns the image version and revision.
 *  2. `authenticate({channelId})`: after the provider opened the channel. The anonymous probe (401 and a challenge
 *     of 64 lower case hex digits), then the signed info, verified.
 *  3. `notifyOpen()`: the open notice, signed. Any 2xx is taken; the body is not read.
 *  4. `turn({messages, maxTokens, money})`: the turn, signed; its receipt verified; its cost held to the lab's
 *     bounds. ONLY THEN C signs the one turn ack of the run, and the ack is posted. Any 2xx is taken.
 *  5. `close({payable})`: only after the ack was taken. The payable is held to the bounds. ONLY THEN C signs the
 *     one receipt of the run, and it is posted. From the signature on, close never throws: it returns the
 *     receipt and the miner's answer as a hint, no hint, or unknown (exit 6), never as settled or not settled.
 *
 * A step out of order, a step while another runs, and any step after a failure refuse and send nothing. Nothing is
 * retried. C signs the requests the steps need, one turn ack and one receipt, and nothing else.
 *
 * Exit codes (R5): an endpoint refusal, a status other than 200 for the proof, and a false proof are 5; a proof
 * call that gave no answer is 11; any refusal or failure of steps 2 to 4 is 1; the unknown of step 5 is 6.
 *
 * No message and no returned error holds a prompt, an output, a signature or a key: each names its step and its
 * check. The values returned are public data: the verified turn, its cost, the signed ack and the signed receipt.
 */
import type { ChannelKey } from "../channel/key.js";
import { CliError, EXIT } from "../errors.js";
import { freezeFunction } from "../freeze.js";
import { CALLS, callLimits, type CallAnswer, type CallLimits, type CallLimitsInput, type CallName, type CallRequest, type CallTransport, type SignedHeaders } from "./calls.js";
import { bigIn, bytesIn, fieldsOf } from "./check.js";
import { answerExit, httpExit, MinerClientError, refuseClient } from "./client-errors.js";
import { originOf, type MinerEndpoint } from "./endpoint.js";
import { pinnedOf, type Expected } from "./expected.js";
import { turnInput, type TurnMessage } from "./input.js";
import { receiptPayable, turnCost, type TurnCost } from "./money.js";
import { ackBody, closeBody, openBody, proofBody, turnBody } from "./requests.js";
import { ackTiming } from "./timing.js";
import { verifyInfo, verifyInfoProof, verifyTurn, type ProofVerified, type VerifiedTurn } from "./verify.js";
import { parseCloseAnswer, parseInfo, parseInfoProof, parseTurnReceipt } from "./wire.js";

/** The money bounds of a turn (M-7), all whole numbers of raw units, each a bigint inside a u128. */
export interface TurnMoney {
  readonly gnCeiling: bigint;
  readonly pricePerGn: bigint;
  readonly basePerTurn: bigint;
  /** The escrow at open. */
  readonly floor: bigint;
  /** B, the most the run may pay. */
  readonly budget: bigint;
}
const MONEY_FIELDS = Object.freeze(["gnCeiling", "pricePerGn", "basePerTurn", "floor", "budget"] as const);

export interface MinerRunInput {
  /** The pinned values, a value minerExpected made. */
  readonly expected: Expected;
  /** The endpoint, a value minerEndpoint made. The transport is the one made for it. */
  readonly endpoint: MinerEndpoint;
  readonly transport: CallTransport;
  /** C, handed in: this code never makes one. */
  readonly key: ChannelKey;
  /** Milliseconds of the buyer's wall clock, a u64. */
  readonly nowMs: () => bigint;
  /** `n` fresh random bytes. */
  readonly random: (n: number) => Uint8Array;
  /** Lower limits for any call; the defaults elsewhere. */
  readonly limits: CallLimitsInput;
}
const RUN_FIELDS = Object.freeze(["expected", "endpoint", "transport", "key", "nowMs", "random", "limits"] as const);
const KEY_FIELDS = Object.freeze(["publicKey", "signReceipt", "signTurnAck", "signRequest"] as const);

/** A signed turn ack: the fields C signed and the signature. */
export interface SignedAck {
  readonly channelId: Uint8Array;
  readonly turnIndex: 0;
  readonly leafHash: Uint8Array;
  readonly agentSendMs: bigint;
  readonly agentRecvMs: bigint;
  readonly signature: Uint8Array;
}

export interface TurnResult {
  readonly turn: VerifiedTurn;
  readonly cost: TurnCost;
  readonly ack: SignedAck;
}

/** The one receipt of the run: the fields C signed and the signature. Public data the provider must keep. */
export interface SignedReceipt {
  readonly channelId: Uint8Array;
  readonly finalRoot: Uint8Array;
  readonly aggregateGn: bigint;
  readonly payable: bigint;
  readonly signature: Uint8Array;
}

/** The miner's answer to the close, as a hint only. Only the chain decides whether the channel settled. */
export type CloseState =
  | { readonly state: "hint"; readonly txHash: Uint8Array }
  | { readonly state: "none" }
  | { readonly state: "unknown"; readonly reason: string; readonly exit: number };

export interface CloseResult {
  readonly receipt: SignedReceipt;
  readonly answer: CloseState;
}

export interface MinerRun {
  readonly prove: () => Promise<ProofVerified>;
  readonly authenticate: (input: { readonly channelId: Uint8Array }) => Promise<void>;
  readonly notifyOpen: () => Promise<void>;
  readonly turn: (input: { readonly messages: readonly TurnMessage[]; readonly maxTokens: number; readonly money: TurnMoney }) => Promise<TurnResult>;
  readonly close: (input: { readonly payable: bigint }) => Promise<CloseResult>;
}

type Step = "prove" | "authenticate" | "notifyOpen" | "turn" | "close";
const ORDER: readonly Step[] = Object.freeze(["prove", "authenticate", "notifyOpen", "turn", "close"]);

const isFunction = (v: unknown): v is (...a: unknown[]) => unknown => typeof v === "function";

/**
 * A run. Refused before anything is made (exit 5 for an endpoint not made by minerEndpoint, 1 otherwise): a field
 * missing, extra or of another form; a key that is not the four functions of a channel key; limits out of range.
 */
export function minerRun(input: MinerRunInput): MinerRun {
  const f = fieldsOf(input, RUN_FIELDS, "miner run");
  const expected = pinnedOf(f.expected);
  originOf(f.endpoint);
  const transport = f.transport;
  if (!isFunction(transport)) refuseClient("REQUEST", "run.transport", "the transport must be a function", EXIT.ERROR);
  const k = fieldsOf(f.key, KEY_FIELDS, "miner run.key");
  for (const n of KEY_FIELDS) if (!isFunction(k[n])) refuseClient("REQUEST", "run.key", `the key's ${n} must be a function`, EXIT.ERROR);
  const key = k as unknown as ChannelKey;
  const nowFn = f.nowMs;
  const randomFn = f.random;
  if (!isFunction(nowFn) || !isFunction(randomFn)) refuseClient("REQUEST", "run.clock", "nowMs and random must be functions", EXIT.ERROR);
  const limits: CallLimits = callLimits(f.limits as CallLimitsInput);

  // The state of the run, in memory only.
  let next = 0;
  let busy = false;
  let failed = false;
  let channelId: Uint8Array | null = null;
  let challenge: string | null = null;
  let verified: VerifiedTurn | null = null;
  let money: TurnMoney | null = null;

  const handed = (what: string, step: string): never => refuseClient("FAILED", `${step}.${what}`, `the ${what} handed in failed`, EXIT.ERROR);
  const now = (step: string): bigint => {
    let t: unknown;
    try {
      t = nowFn();
    } catch {
      return handed("clock", step);
    }
    if (typeof t !== "bigint" || t < 0n || t > (1n << 64n) - 1n) return handed("clock", step);
    return t;
  };
  const random = (n: number, step: string): Uint8Array => {
    let b: unknown;
    try {
      b = randomFn(n);
    } catch {
      return handed("random source", step);
    }
    if (!(b instanceof Uint8Array) || b.length !== n) return handed("random source", step);
    return Uint8Array.from(b);
  };
  /** One of C's signatures; what C threw is not kept. */
  const withKey = <T>(what: string, step: string, sign: () => T): T => {
    try {
      return sign();
    } catch {
      return refuseClient("FAILED", `${step}.key`, `the channel key did not sign the ${what}`, EXIT.ERROR);
    }
  };

  /** One call through the transport. A throw that is not this client's own becomes a refusal of the call. */
  const call = async (name: CallName, body: string | null, signed: SignedHeaders | null): Promise<CallAnswer> => {
    const request: CallRequest = Object.freeze({ call: name, body, signed, maxBytes: limits[name].maxBytes, timeMs: limits[name].timeMs });
    let raw: unknown;
    try {
      raw = await (transport as CallTransport)(request);
    } catch (e) {
      if (e instanceof MinerClientError) throw e;
      return refuseClient("HTTP", `http.${name}.transport`, `the ${name} call: the transport failed, with no answer`, httpExit(name));
    }
    const bad = (): never => refuseClient("HTTP", `http.${name}.answer`, `the ${name} call: the transport's answer is not of its form`, httpExit(name));
    if (typeof raw !== "object" || raw === null) return bad();
    const read = (field: string): unknown => {
      const d = Object.getOwnPropertyDescriptor(raw, field);
      return d !== undefined && "value" in d ? d.value : bad();
    };
    const status = read("status");
    const text = read("body");
    const ch = read("challenge");
    if (typeof status !== "number" || !Number.isInteger(status)) return bad();
    if (text !== null && typeof text !== "string") return bad();
    if (ch !== null && typeof ch !== "string") return bad();
    return Object.freeze({ status, body: text as string | null, challenge: ch as string | null });
  };

  /** C's five headers for a request of this call. */
  const signedFor = (name: CallName, body: string, step: string): SignedHeaders => {
    const rule = CALLS[name];
    const timestampMs = now(step);
    const nonce = random(16, step);
    const id = channelId as Uint8Array;
    const c = challenge as string;
    const signed = withKey("request", step, () => key.signRequest({ channelId: Uint8Array.from(id), method: rule.method, path: rule.path, body, timestampMs, nonce, challenge: c }));
    return signed.headers as SignedHeaders;
  };

  const wantStatus = (name: CallName, answer: CallAnswer, want: (s: number) => boolean, words: string): void => {
    if (!want(answer.status)) refuseClient("ANSWER", `${name}.status`, `the ${name} call answered status ${answer.status}, not ${words}`, answerExit(name));
  };
  const bodyOf = (name: CallName, answer: CallAnswer): string => {
    if (answer.body === null) return refuseClient("ANSWER", `${name}.body`, `the ${name} call gave no body`, answerExit(name));
    return answer.body;
  };
  const is200 = (s: number): boolean => s === 200;
  const is2xx = (s: number): boolean => s >= 200 && s <= 299;

  /** Runs a step once and in its order; any throw marks the run failed. */
  const step = <A extends unknown[], R>(name: Step, body: (...a: A) => Promise<R>) =>
    freezeFunction(async (...a: A): Promise<R> => {
      if (busy) refuseClient("ORDER", `${name}.order`, `${name} was called while another step runs; nothing was sent`, EXIT.ERROR);
      if (failed) refuseClient("ORDER", `${name}.order`, `${name} was called after a step failed; nothing was sent`, EXIT.ERROR);
      if (ORDER[next] !== name) refuseClient("ORDER", `${name}.order`, `${name} is not the next step${next < ORDER.length ? ` (the next is ${ORDER[next]})` : " (the run is over)"}; nothing was sent`, EXIT.ERROR);
      busy = true;
      try {
        const out = await body(...a);
        next += 1;
        return out;
      } catch (e) {
        failed = true;
        throw e;
      } finally {
        busy = false;
      }
    });

  const prove = step("prove", async (): Promise<ProofVerified> => {
    const ours = random(32, "prove");
    const answer = await call("proof", proofBody({ challenge: Uint8Array.from(ours) }), null);
    wantStatus("proof", answer, is200, "200");
    const proof = parseInfoProof(bodyOf("proof", answer));
    return verifyInfoProof({ expected, challenge: Uint8Array.from(ours), proof });
  });

  const authenticate = step("authenticate", async (value: { readonly channelId: Uint8Array }): Promise<void> => {
    const a = fieldsOf(value, ["channelId"], "authenticate input");
    channelId = bytesIn(a.channelId, 32, "authenticate input.channelId");
    const probe = await call("probe", null, null);
    wantStatus("probe", probe, (s) => s === 401, "401");
    if (probe.challenge === null || !/^[0-9a-f]{64}$/.test(probe.challenge)) refuseClient("ANSWER", "probe.challenge", "the probe's challenge header is missing or is not 64 lower case hex digits", EXIT.ERROR);
    challenge = probe.challenge;
    const info = await call("info", null, signedFor("info", "", "authenticate"));
    wantStatus("info", info, is200, "200");
    verifyInfo({ expected, info: parseInfo(bodyOf("info", info)) });
  });

  const notifyOpen = step("notifyOpen", async (): Promise<void> => {
    const agentKey = withKey("public key", "notifyOpen", () => key.publicKey());
    const body = openBody({ channelId: Uint8Array.from(channelId as Uint8Array), agentKey: bytesIn(agentKey, 32, "the channel key's public key") });
    const answer = await call("open", body, signedFor("open", body, "notifyOpen"));
    wantStatus("open", answer, is2xx, "a 2xx");
  });

  const turn = step("turn", async (value: { readonly messages: readonly TurnMessage[]; readonly maxTokens: number; readonly money: TurnMoney }): Promise<TurnResult> => {
    const t = fieldsOf(value, ["messages", "maxTokens", "money"], "turn input");
    const m = fieldsOf(t.money, MONEY_FIELDS, "turn input.money");
    const bounds: TurnMoney = Object.freeze(Object.fromEntries(MONEY_FIELDS.map((n) => [n, bigIn("u128", m[n], `turn input.money.${n}`)])) as unknown as TurnMoney);
    const id = channelId as Uint8Array;
    const sent = turnInput({ expected, messages: t.messages as readonly TurnMessage[], maxTokens: t.maxTokens as number });
    const body = turnBody({ channelId: Uint8Array.from(id), input: sent.input });
    const headers = signedFor("turn", body, "turn");
    const agentSendMs = now("turn");
    const answer = await call("turn", body, headers);
    const agentRecvMs = now("turn");
    wantStatus("turn", answer, is200, "200");
    const receipt = parseTurnReceipt(bodyOf("turn", answer));
    const v = verifyTurn({ expected, channelId: Uint8Array.from(id), turn: sent, receipt });
    const cost = turnCost({ gN: v.gN, ...bounds });
    const timing = ackTiming({ agentSendMs, agentRecvMs, minerRecvMs: v.minerRecvMs, minerDoneMs: v.minerDoneMs, latencyMs: v.latencyMs });
    // Everything about the turn holds. Only now C signs the turn ack.
    const signed = withKey("turn ack", "turn", () => key.signTurnAck({ channelId: Uint8Array.from(id), turnIndex: 0, leafHash: Uint8Array.from(v.leaf), agentSendMs, agentRecvMs }));
    const ack: SignedAck = Object.freeze({ channelId: Uint8Array.from(id), turnIndex: 0, leafHash: Uint8Array.from(v.leaf), agentSendMs, agentRecvMs, signature: Uint8Array.from(signed.signature) });
    const ackText = ackBody({ channelId: Uint8Array.from(id), turnIndex: 0, leafHash: Uint8Array.from(v.leaf), agentSendMs, agentRecvMs, agentSig: Uint8Array.from(signed.signature), timingStatus: timing.timingStatus, scoredLatencyMs: timing.scoredLatencyMs });
    const taken = await call("ack", ackText, signedFor("ack", ackText, "turn"));
    wantStatus("ack", taken, is2xx, "a 2xx");
    verified = v;
    money = bounds;
    return Object.freeze({ turn: v, cost, ack });
  });

  const close = step("close", async (value: { readonly payable: bigint }): Promise<CloseResult> => {
    const c = fieldsOf(value, ["payable"], "close input");
    const v = verified as VerifiedTurn;
    const bounds = money as TurnMoney;
    const id = channelId as Uint8Array;
    const { payable } = receiptPayable({ payable: c.payable as bigint, budget: bounds.budget, basePerTurn: bounds.basePerTurn, turns: 1n, aggregateGn: v.gN });
    // The payable is inside the bounds and the ack was taken. Only now C signs the one receipt of the run.
    const signed = withKey("receipt", "close", () => key.signReceipt({ channelId: Uint8Array.from(id), finalRoot: Uint8Array.from(v.leaf), aggregateGn: v.gN, payable }));
    const receipt: SignedReceipt = Object.freeze({ channelId: Uint8Array.from(id), finalRoot: Uint8Array.from(v.leaf), aggregateGn: v.gN, payable, signature: Uint8Array.from(signed.signature) });
    // From here nothing throws: the signed receipt is handed back whatever the miner answers.
    const unknown = (reason: string): CloseResult => Object.freeze({ receipt, answer: Object.freeze({ state: "unknown" as const, reason, exit: EXIT.TIMEOUT_UNKNOWN }) });
    try {
      const body = closeBody({ channelId: Uint8Array.from(id), finalRoot: Uint8Array.from(v.leaf), aggregateGn: v.gN, payable, agentReceiptSig: Uint8Array.from(signed.signature), claimedMeasuredRoot: Uint8Array.from(expected.identity.measuredRoot) });
      const answer = await call("close", body, signedFor("close", body, "close"));
      if (answer.status !== 200) return unknown(`the close call answered status ${answer.status}, not 200`);
      if (answer.body === null) return unknown("the close call gave no body");
      const parsed = parseCloseAnswer(answer.body);
      if (parsed.settled === null) return Object.freeze({ receipt, answer: Object.freeze({ state: "none" as const }) });
      const same = parsed.settled.channelId.length === id.length && parsed.settled.channelId.every((b, i) => b === id[i]);
      if (!same) return unknown("the close answer's settled names another channel");
      return Object.freeze({ receipt, answer: Object.freeze({ state: "hint" as const, txHash: Uint8Array.from(parsed.settled.txHash) }) });
    } catch (e) {
      return unknown(e instanceof CliError ? e.message : "the close call failed");
    }
  });

  return Object.freeze({ prove, authenticate, notifyOpen, turn, close });
}
freezeFunction(minerRun);
