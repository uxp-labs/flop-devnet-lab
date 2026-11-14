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
 * It shares no code with src/miner or with the builder's second writing. Its hash is the reviewer's own BLAKE2b
 * written from RFC 7693 below (64 bit words as bigint), not @noble/hashes; a test holds it to the RFC's own
 * "abc" vector and to @noble/hashes on a grid. Its JSON string escaper is written by hand
 * from the ECMAScript QuoteJSONString rule that JSON.stringify follows (well formed JSON.stringify, ES2019),
 * not by a call to JSON.stringify.
 */

const enc = new TextEncoder();

const M64 = (1n << 64n) - 1n;
const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];
const rotr = (x: bigint, n: bigint): bigint => ((x >> n) | (x << (64n - n))) & M64;

function compress(h: bigint[], block: Uint8Array, t: bigint, last: boolean): void {
  const m: bigint[] = [];
  const dv = new DataView(block.buffer, block.byteOffset, 128);
  for (let i = 0; i < 16; i++) m.push(dv.getBigUint64(i * 8, true));
  const v = [...h, ...IV];
  v[12] = (v[12] as bigint) ^ (t & M64);
  v[13] = (v[13] as bigint) ^ (t >> 64n);
  if (last) v[14] = (v[14] as bigint) ^ M64;
  const g = (a: number, b: number, c: number, d: number, x: bigint, y: bigint) => {
    v[a] = ((v[a] as bigint) + (v[b] as bigint) + x) & M64;
    v[d] = rotr((v[d] as bigint) ^ (v[a] as bigint), 32n);
    v[c] = ((v[c] as bigint) + (v[d] as bigint)) & M64;
    v[b] = rotr((v[b] as bigint) ^ (v[c] as bigint), 24n);
    v[a] = ((v[a] as bigint) + (v[b] as bigint) + y) & M64;
    v[d] = rotr((v[d] as bigint) ^ (v[a] as bigint), 16n);
    v[c] = ((v[c] as bigint) + (v[d] as bigint)) & M64;
    v[b] = rotr((v[b] as bigint) ^ (v[c] as bigint), 63n);
  };
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r % 10] as number[];
    const w = (k: number) => m[s[k] as number] as bigint;
    g(0, 4, 8, 12, w(0), w(1));
    g(1, 5, 9, 13, w(2), w(3));
    g(2, 6, 10, 14, w(4), w(5));
    g(3, 7, 11, 15, w(6), w(7));
    g(0, 5, 10, 15, w(8), w(9));
    g(1, 6, 11, 12, w(10), w(11));
    g(2, 7, 8, 13, w(12), w(13));
    g(3, 4, 9, 14, w(14), w(15));
  }
  for (let i = 0; i < 8; i++) h[i] = (h[i] as bigint) ^ (v[i] as bigint) ^ (v[i + 8] as bigint);
}

/** BLAKE2b with an `outLen` byte digest and no key, from RFC 7693 section 3. */
export function blake2bRfc(data: Uint8Array, outLen: number): Uint8Array {
  const h = [...IV];
  h[0] = (h[0] as bigint) ^ BigInt(0x01010000 | outLen);
  const blocks = Math.max(1, Math.ceil(data.length / 128));
  for (let b = 0; b < blocks; b++) {
    const block = new Uint8Array(128);
    const chunk = data.subarray(b * 128, b * 128 + 128);
    block.set(chunk);
    const last = b === blocks - 1;
    compress(h, block, BigInt(last ? data.length : (b + 1) * 128), last);
  }
  const out = new Uint8Array(64);
  const dv = new DataView(out.buffer);
  h.forEach((x, i) => dv.setBigUint64(i * 8, x, true));
  return out.slice(0, outLen);
}

export function b256(data: Uint8Array): Uint8Array {
  return blake2bRfc(data, 32);
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
