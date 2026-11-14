/**
 * The reviewer's third writing of the five byte layouts of P6a, for the review tests only.
 *
 * Written from FLOP's SDK 0.6.0 source alone (read, never run or imported), BEFORE the reviewer read
 * src/miner/identity.ts, input.ts, leaf.ts or test/lib/miner-answers.ts:
 * - modelIdentityHash: dist/miner-admission.js, function modelIdentityHash.
 * - sessionInfoMessage: dist/miner-admission.js, function sessionInfoMessage.
 * - turnEvidenceHash: dist/compute-channel/transcript.js, function turnEvidenceHash.
 * - chat turn input: dist/compute-channel/protocol.js, canonicalJson and encodeChatTurnEnvelope, with the
 *   envelope that dist/compute-channel/direct-session.js builds (version, model, messages, max_tokens).
 *   h_in: dist/compute-channel/agent-client.js, validateReceipt (blake2_256 of the input bytes).
 * - leafV3: dist/compute-channel/transcript.js, transcriptLeafV3, u32le, u64le, u128le.
 *
 * It shares no code with src/miner or with the builder's second writing. Its hash is blake2b from
 * @polkadot/wasm-crypto (Rust built to WASM), not @noble/hashes. Its JSON string escaper is written by hand
 * from the ECMAScript QuoteJSONString rule that JSON.stringify follows (well formed JSON.stringify, ES2019),
 * not by a call to JSON.stringify.
 */
import { blake2b } from "@polkadot/wasm-crypto";

const enc = new TextEncoder();

export function b256(data: Uint8Array): Uint8Array {
  return blake2b(Uint8Array.from(data), new Uint8Array(0), 32);
}

function cat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function le(value: bigint, width: number): Uint8Array {
  if (value < 0n || value >= 1n << BigInt(width * 8)) throw new RangeError("third: value out of width");
  const out = new Uint8Array(width);
  let v = value;
  for (let i = 0; i < width; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

const u32 = (n: number | bigint): Uint8Array => le(BigInt(n), 4);
const u64 = (n: bigint): Uint8Array => le(n, 8);
const u128 = (n: bigint): Uint8Array => le(n, 16);
const lp = (bytes: Uint8Array): Uint8Array => cat(u32(bytes.length), bytes);
const lpText = (s: string): Uint8Array => lp(enc.encode(s));
function h32(b: Uint8Array): Uint8Array {
  if (b.length !== 32) throw new RangeError("third: not 32 bytes");
  return b;
}

export interface ThirdIdentity {
  requestedSlug: string;
  registryModel: string;
  registryVersion: string;
  modelHash: Uint8Array;
  precision: number;
  decodePolicyHash: Uint8Array;
  measuredRoot: Uint8Array;
  backendModelName: string;
}

function identityBody(id: ThirdIdentity, withStrings: boolean): Uint8Array {
  if (!Number.isInteger(id.precision) || id.precision < 0 || id.precision > 255) throw new RangeError("third: precision");
  return cat(
    withStrings ? cat(lpText(id.requestedSlug), lpText(id.registryModel), lpText(id.registryVersion)) : new Uint8Array(0),
    h32(id.modelHash),
    Uint8Array.of(id.precision),
    h32(id.decodePolicyHash),
    h32(id.measuredRoot),
    lpText(id.backendModelName),
  );
}

/** miner-admission.js modelIdentityHash. */
export function thirdModelIdentityHash(id: ThirdIdentity): Uint8Array {
  return b256(cat(enc.encode("flop-model-identity-v1"), identityBody(id, true)));
}

/** miner-admission.js sessionInfoMessage: the raw bytes the enclave signs (not hashed). */
export function thirdSessionInfoMessage(f: {
  challenge: Uint8Array;
  genesisHash: Uint8Array;
  account: Uint8Array;
  enclaveKey: Uint8Array;
  identity: ThirdIdentity;
  ready: boolean;
  version: string;
  revision: string;
}): Uint8Array {
  return cat(
    enc.encode("flop-session-info-v1"),
    h32(f.challenge),
    h32(f.genesisHash),
    h32(f.account),
    h32(f.enclaveKey),
    thirdModelIdentityHash(f.identity),
    Uint8Array.of(f.ready ? 1 : 0),
    lpText(f.version),
    lpText(f.revision),
  );
}

/** transcript.js turnEvidenceHash. */
export function thirdTurnEvidenceHash(output: Uint8Array, promptTokens: bigint, completionTokens: bigint, finishReason: string, id: ThirdIdentity): Uint8Array {
  return b256(
    cat(
      enc.encode("FLOP_CHAT_TURN_EVIDENCE_V1"),
      lp(output),
      u64(promptTokens),
      u64(completionTokens),
      lpText(finishReason),
      lpText(id.requestedSlug),
      lpText(id.registryModel),
      lpText(id.registryVersion),
      identityBody(id, false),
    ),
  );
}

/** ECMAScript QuoteJSONString, by hand. */
export function thirdQuote(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
    else if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (d >= 0xdc00 && d <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
      } else out += "\\u" + c.toString(16).padStart(4, "0");
    } else if (c >= 0xdc00 && c <= 0xdfff) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += s[i];
  }
  return out + '"';
}

export interface ThirdMessage {
  role: string;
  content: string;
}

/**
 * protocol.js canonicalJson of the direct-session.js envelope. Keys sorted by UTF-16 code units at each level:
 * top "max_tokens" < "messages" < "model" < "version"; a message "content" < "role".
 */
export function thirdChatInput(slug: string, messages: ThirdMessage[], maxTokens: number): Uint8Array {
  const msgs = messages.map((m) => `{"content":${thirdQuote(m.content)},"role":${thirdQuote(m.role)}}`).join(",");
  const text = `{"max_tokens":${String(maxTokens)},"messages":[${msgs}],"model":${thirdQuote(slug)},"version":"flop.chat-turn.v1"}`;
  return enc.encode(text);
}

export const thirdHIn = (input: Uint8Array): Uint8Array => b256(input);

/** transcript.js transcriptLeafV3. */
export function thirdLeafV3(f: {
  channelId: Uint8Array;
  turnIndex: number;
  hIn: Uint8Array;
  hOut: Uint8Array;
  gN: bigint;
  decodePolicyHash: Uint8Array;
  hIds: Uint8Array;
  toplocCommitmentHash: Uint8Array;
  minerRecvMs: bigint;
  minerDoneMs: bigint;
  latencyMs: bigint;
}): Uint8Array {
  return b256(
    cat(
      h32(f.channelId),
      u32(f.turnIndex),
      h32(f.hIn),
      h32(f.hOut),
      u128(f.gN),
      h32(f.decodePolicyHash),
      h32(f.hIds),
      h32(f.toplocCommitmentHash),
      u64(f.minerRecvMs),
      u64(f.minerDoneMs),
      u64(f.latencyMs),
    ),
  );
}
