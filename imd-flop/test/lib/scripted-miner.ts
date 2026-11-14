/**
 * A scripted miner for the tests of the miner client (P6b). It IS a transport: a function from the client's request
 * to an answer, with no socket and no fetch. It holds a test enclave key from the reference library, builds its
 * answers with `test/lib/miner-answers.ts`, and checks each signed request, the turn ack and the receipt of C with
 * the reference library's verify, over its own writing of the three layouts (from FLOP's SDK 0.6.0
 * `session-auth.js` and `transcript.js`, read and not imported). It imports nothing from src.
 *
 * It records every call in order, and every problem it finds with what C sent, in `problems`. Switches make it
 * misbehave, one fault at a time.
 */
import { blake2b } from "@noble/hashes/blake2.js";
import { enclavePair, filled, fromHex, hex, hex0x, infoObject, join, le, leafOf, proofObject, refLeafV3, refSs58, scenario, turnObject, type Scenario } from "./miner-answers.js";
import { referenceVerify } from "./sr25519-reference.js";

type Bytes = Uint8Array;
export type Call = "proof" | "probe" | "info" | "open" | "turn" | "ack" | "close";

/** The scripted miner's own table of the calls: the method and path it expects, and whether C signs. */
const TABLE: Record<Call, { method: "GET" | "POST"; path: string; signed: boolean }> = {
  proof: { method: "POST", path: "/session/info-proof", signed: false },
  probe: { method: "GET", path: "/session/info", signed: false },
  info: { method: "GET", path: "/session/info", signed: true },
  open: { method: "POST", path: "/session/open", signed: true },
  turn: { method: "POST", path: "/session/turn", signed: true },
  ack: { method: "POST", path: "/session/ack", signed: true },
  close: { method: "POST", path: "/session/close", signed: true },
};

/** Each single fault of the receipt (P6a's verifyTurn, in its order), and two of its form. */
export const TURN_FAULTS = [
  "leafVersion",
  "turnIndex",
  "hIn",
  "decodePolicyHash",
  "hIds",
  "identity",
  "finishReason",
  "completionTokens",
  "notUtf8",
  "framedOutput",
  "hOut",
  "timingOrder",
  "timingLatency",
  "gNOverU64",
  "runningRoot",
  "enclaveSig",
  "missingProviderField",
  "upperHex",
] as const;
export type TurnFault = (typeof TURN_FAULTS)[number];

export interface Switches {
  /** The proof is signed by another key, which it states as its own. */
  proofOtherKey?: boolean;
  /** A status other than the one wanted, per call. */
  status?: Partial<Record<Call, number>>;
  /** The probe sends no challenge header, or this text as one. */
  challenge?: string | null;
  /** The info names another account. */
  infoOtherAccount?: boolean;
  /** One fault of the receipt. */
  turnFault?: TurnFault;
  /** The G_n the receipt states (consistent with its leaf and signature). */
  gN?: bigint;
  /** The answer of this call is padded past the byte limit the client handed in. */
  oversize?: Call;
  /** The answer of this call is not JSON. */
  garbage?: Call;
  /** The transport fails for this call, with no answer. */
  fail?: Call;
  /** The close answer's settled: ours (the default), another channel's, or none. */
  settled?: "ours" | "other" | "none";
}

export interface Seen {
  readonly call: Call;
  readonly body: string | null;
  readonly signed: Record<string, string> | null;
}

export interface ScriptedMiner {
  readonly transport: (request: unknown) => Promise<{ status: number; body: string | null; challenge: string | null }>;
  readonly seen: Seen[];
  readonly problems: string[];
  /** The acks and receipts the miner verified under C's key. */
  readonly acks: Record<string, unknown>[];
  readonly receipts: Record<string, unknown>[];
  readonly scenario: Scenario;
  readonly challenge: string;
  readonly txHash: Bytes;
}

const enc = new TextEncoder();
const b256 = (b: Bytes): Bytes => blake2b(b, { dkLen: 32 });

/** `sessionRequestMessage` of session-auth.js, by hand. */
function requestMessage(channel: string, method: string, path: string, body: string, timestamp: string, nonce: string, challenge: string): Bytes {
  return enc.encode(JSON.stringify(["flop-session-request-v1", channel, method, path, hex0x(b256(enc.encode(body))), timestamp, nonce, challenge]));
}

/** `turnAckMessage` of transcript.js, by hand. */
const ackMessage = (id: Bytes, turn: number, leaf: Bytes, send: bigint, recv: bigint): Bytes => join(id, le(BigInt(turn), 4), leaf, le(send, 8), le(recv, 8));

/** `receiptMessage` of transcript.js, by hand. */
const receiptMessage = (id: Bytes, root: Bytes, gn: bigint, payable: bigint): Bytes => join(enc.encode("FLOP/COMPUTE_CHANNEL/RECEIPT"), Uint8Array.of(1), id, root, le(gn, 16), le(payable, 16));

/** The test messages and max_tokens the client sends in the scripted runs. */
export const MESSAGES = Object.freeze([{ role: "user" as const, content: "Say hello." }]);
export const MAX_TOKENS = 64;

/**
 * A scripted miner for C's public key `agentKey`. Its scenario is miner-answers' default with the given overrides;
 * the channel id the client authenticates with must be the scenario's.
 */
export function scriptedMiner(agentKey: Bytes, sw: Switches = {}, over: Partial<Scenario> = {}): ScriptedMiner {
  const s = scenario({ messages: [...MESSAGES], maxTokens: MAX_TOKENS, ...over, ...(sw.gN === undefined ? {} : { gN: sw.gN }) });
  const seen: Seen[] = [];
  const problems: string[] = [];
  const acks: Record<string, unknown>[] = [];
  const receipts: Record<string, unknown>[] = [];
  const challenge = hex(filled(32, 0xab));
  const txHash = filled(32, 0xcd);
  let leaf: Bytes | null = null;

  const checkSigned = (call: Call, body: string | null, signed: Record<string, string> | null): void => {
    const t = TABLE[call];
    if (!t.signed) {
      if (signed !== null) problems.push(`${call}: signed headers on a call that is not signed`);
      return;
    }
    if (signed === null) return void problems.push(`${call}: no signed headers`);
    const names = Object.keys(signed).sort();
    if (JSON.stringify(names) !== JSON.stringify(["x-flop-challenge", "x-flop-channel", "x-flop-nonce", "x-flop-signature", "x-flop-timestamp"])) problems.push(`${call}: the signed headers are not the five`);
    if (signed["x-flop-channel"] !== hex0x(s.channelId)) problems.push(`${call}: another channel`);
    if (signed["x-flop-challenge"] !== challenge) problems.push(`${call}: another challenge`);
    if (!/^0x[0-9a-f]{32}$/.test(signed["x-flop-nonce"] ?? "")) problems.push(`${call}: the nonce is not 16 bytes`);
    const msg = requestMessage(signed["x-flop-channel"] ?? "", t.method, t.path, body ?? "", signed["x-flop-timestamp"] ?? "", signed["x-flop-nonce"] ?? "", signed["x-flop-challenge"] ?? "");
    if (!referenceVerify(agentKey, msg, fromHex(signed["x-flop-signature"] ?? ""))) problems.push(`${call}: the request signature does not verify under C`);
  };

  const json = (call: Call, value: unknown): string => (sw.garbage === call ? "<<not json>>" : JSON.stringify(value));

  const turnAnswer = (input: Bytes): Record<string, unknown> => {
    const fault = sw.turnFault;
    let sc = s;
    if (fault === "completionTokens") sc = { ...s, completionTokens: BigInt(MAX_TOKENS + 1) };
    if (fault === "notUtf8") sc = { ...s, output: Uint8Array.of(0xff, 0xfe) };
    if (fault === "framedOutput") sc = { ...s, output: enc.encode("FLOP-TURN-FRAMES-x") };
    if (fault === "finishReason") sc = { ...s, finishReason: "tool_calls" };
    if (fault === "timingOrder") sc = { ...s, minerRecvMs: 2000n, minerDoneMs: 1000n, latencyMs: 0n };
    if (fault === "timingLatency") sc = { ...s, latencyMs: s.latencyMs + 1n };
    if (fault === "gNOverU64") sc = { ...s, gN: 1n << 64n };
    if (fault === "hIds") sc = { ...s, hIds: new Uint8Array(32) };
    const l = leafOf(sc, { hIn: fault === "hIn" ? filled(32, 0x01) : b256(input), ...(fault === "turnIndex" ? { turnIndex: 1 } : {}), ...(fault === "hOut" ? { hOut: filled(32, 0x02) } : {}) });
    if (fault === "decodePolicyHash") l.decodePolicyHash = filled(32, 0x23);
    leaf = refLeafV3(l);
    const o = turnObject(sc, { leaf: l, ...(fault === "enclaveSig" ? { signer: enclavePair(9) } : {}), ...(fault === "runningRoot" ? { root: filled(32, 0x03) } : {}), ...(fault === "leafVersion" ? { leafVersion: "V2" } : {}) });
    if (fault === "identity") (o.modelIdentity as Record<string, unknown>).registryVersion = "9.9";
    if (fault === "missingProviderField") delete o.promptTokens;
    if (fault === "upperHex") o.hOut = (o.hOut as string).toUpperCase().replace(/^0X/, "0x");
    return o;
  };

  const answerFor = (call: Call, body: string | null): { status: number; body: string | null; challenge: string | null } => {
    const status = sw.status?.[call];
    switch (call) {
      case "proof": {
        const sent = JSON.parse(body ?? "{}") as Record<string, unknown>;
        if (Object.keys(sent).join() !== "challenge" || typeof sent.challenge !== "string" || !/^[0-9a-f]{64}$/.test(sent.challenge)) problems.push("proof: the body is not {challenge} of bare hex");
        const ours = fromHex(String(sent.challenge));
        const o = proofObject(s, { challenge: ours, ...(sw.proofOtherKey ? { signer: enclavePair(9) } : {}) });
        return { status: status ?? 200, body: json(call, o), challenge: null };
      }
      case "probe":
        return { status: status ?? 401, body: null, challenge: sw.challenge === undefined ? challenge : sw.challenge };
      case "info": {
        const o = infoObject(s);
        if (sw.infoOtherAccount) o.minerAddress = refSs58(filled(32, 0x56));
        return { status: status ?? 200, body: json(call, o), challenge: null };
      }
      case "open": {
        const sent = JSON.parse(body ?? "{}") as Record<string, unknown>;
        if (JSON.stringify(sent) !== JSON.stringify({ channelId: hex0x(s.channelId), agentKey: hex0x(agentKey) })) problems.push("open: the body is not {channelId, agentKey}");
        return { status: status ?? 200, body: null, challenge: null };
      }
      case "turn": {
        const sent = JSON.parse(body ?? "{}") as Record<string, unknown>;
        if (Object.keys(sent).join() !== "channelId,input" || sent.channelId !== hex0x(s.channelId)) problems.push("turn: the body is not {channelId, input}");
        const input = fromHex(String(sent.input));
        if (hex(input) !== hex(s.input)) problems.push("turn: the input is not the canonical input of the scripted messages");
        return { status: status ?? 200, body: json(call, turnAnswer(input)), challenge: null };
      }
      case "ack": {
        const a = JSON.parse(body ?? "{}") as Record<string, unknown>;
        const keys = ["channelId", "turnIndex", "leafHash", "agentSendMs", "agentRecvMs", "agentSig", "timingStatus", "scoredLatencyMs"];
        if (Object.keys(a).join() !== keys.join()) problems.push("ack: the fields are not the SDK's, in its order");
        if (a.channelId !== hex0x(s.channelId) || a.turnIndex !== 0 || leaf === null || a.leafHash !== hex0x(leaf)) problems.push("ack: not for our leaf");
        if (!referenceVerify(agentKey, ackMessage(s.channelId, 0, leaf ?? new Uint8Array(32), BigInt(String(a.agentSendMs)), BigInt(String(a.agentRecvMs))), fromHex(String(a.agentSig)))) problems.push("ack: the signature does not verify under C");
        acks.push(a);
        return { status: status ?? 200, body: null, challenge: null };
      }
      case "close": {
        const c = JSON.parse(body ?? "{}") as Record<string, unknown>;
        const keys = ["channelId", "finalRoot", "aggregateGn", "payable", "agentReceiptSig", "claimedMeasuredRoot", "transcriptRef"];
        if (Object.keys(c).join() !== keys.join()) problems.push("close: the fields are not the SDK's, in its order");
        if (c.channelId !== hex0x(s.channelId) || leaf === null || c.finalRoot !== hex0x(leaf) || c.transcriptRef !== null || c.claimedMeasuredRoot !== hex0x(s.identity.measuredRoot)) problems.push("close: not our claim");
        if (!referenceVerify(agentKey, receiptMessage(s.channelId, leaf ?? new Uint8Array(32), BigInt(String(c.aggregateGn)), BigInt(String(c.payable))), fromHex(String(c.agentReceiptSig)))) problems.push("close: the receipt does not verify under C");
        receipts.push(c);
        const settled = sw.settled ?? "ours";
        const o = settled === "none" ? { ok: true } : { settled: { channelId: hex0x(settled === "other" ? filled(32, 0x78) : s.channelId), minerPaid: String(c.payable), burned: "0", aggregateGn: String(c.aggregateGn), cooperative: true, txHash: hex0x(txHash) } };
        return { status: status ?? 200, body: json(call, o), challenge: null };
      }
    }
  };

  const transport = async (request: unknown) => {
    const r = request as { call: Call; body: string | null; signed: Record<string, string> | null; maxBytes: number; timeMs: number };
    seen.push({ call: r.call, body: r.body, signed: r.signed === null ? null : { ...r.signed } });
    checkSigned(r.call, r.body, r.signed);
    if (sw.fail === r.call) throw new Error("the scripted transport failed");
    const a = answerFor(r.call, r.body);
    if (sw.oversize === r.call) a.body = (a.body ?? "") + " ".repeat(r.maxBytes + 1);
    // As the HTTP file does: an answer past the limit is no answer.
    if (a.body !== null && enc.encode(a.body).length > r.maxBytes) throw new Error("over the limit");
    return Object.freeze(a);
  };

  return { transport, seen, problems, acks, receipts, scenario: s, challenge, txHash };
}
