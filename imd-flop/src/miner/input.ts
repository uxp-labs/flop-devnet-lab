/**
 * The bytes of one chat turn's input and h_in (W8). The input is FLOP's chat turn envelope in the SDK's canonical
 * JSON, as `dist/compute-channel/protocol.js` (`canonicalJson`, `encodeChatTurnEnvelope`) writes it, read and not
 * imported: keys sorted at each level by UTF-16 code unit, each string as JSON.stringify writes it, the number in
 * its plain decimal form, no space. h_in is the blake2b 256 of those bytes (`agent-client.js`, `validateReceipt`).
 *
 * What is accepted, and so matched byte for byte: the version text `flop.chat-turn.v1`, the model slug the owner
 * pinned, 1 to MESSAGES_MAX messages each of exactly a role (`system` or `user`) and a content string, and
 * max_tokens a whole number from 1 to MAX_TOKENS_MAX. Every other field of the SDK's envelope, every other role,
 * content that is not a string, and a string that is not well formed UTF-16 are refused: none is needed, so no form
 * of them is written.
 *
 * No committed record holds a real input: the two real turns record h_in and not its preimage.
 */
import { blake2b } from "@noble/hashes/blake2.js";
import { freezeFunction } from "../freeze.js";
import { bytesIn, fieldsOf, itemsOf, wholeIn } from "./check.js";
import { refuseMiner } from "./errors.js";
import { pinnedOf, type Expected } from "./expected.js";
import { LIMITS, utf8, wellFormed } from "./forms.js";

/** The version text of a plain chat turn. Version 2 (structured rendering) is refused (M-10). */
export const CHAT_TURN_VERSION = "flop.chat-turn.v1";
/** The roles the tool's ChatMessage has. */
export const CHAT_ROLES = Object.freeze(["system", "user"] as const);

export interface TurnMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

export interface TurnInputInput {
  /** The pinned values: the model of the envelope is its requested slug. */
  readonly expected: Expected;
  readonly messages: readonly TurnMessage[];
  /** A whole number from 1 to LIMITS.MAX_TOKENS_MAX. */
  readonly maxTokens: number;
}

export interface TurnInput {
  /** The canonical bytes, fresh. */
  readonly input: Uint8Array;
  /** blake2b 256 of the input, fresh. */
  readonly hIn: Uint8Array;
}

/** A JSON string as JSON.stringify writes it, for a string already found well formed. */
const jsonString = (s: string): string => JSON.stringify(s);

/** One message, checked: exactly its two fields, a role of the list, and a content string that is well formed. */
function messageOf(value: unknown, i: number): string {
  const f = fieldsOf(value, ["role", "content"], `messages[${i}]`);
  if (typeof f.role !== "string" || !(CHAT_ROLES as readonly string[]).includes(f.role)) refuseMiner("BAD_INPUT", "messages.role", `messages[${i}].role must be one of ${CHAT_ROLES.join(", ")}`);
  if (typeof f.content !== "string") refuseMiner("BAD_INPUT", "messages.content", `messages[${i}].content must be a string`);
  if (!wellFormed(f.content as string)) refuseMiner("BAD_INPUT", "messages.content", `messages[${i}].content must be well formed UTF-16 (it holds a lone surrogate)`);
  // The keys in sorted order: content, then role.
  return `{"content":${jsonString(f.content as string)},"role":${jsonString(f.role as string)}}`;
}

/**
 * The canonical input of one turn and its h_in. The text is
 * `{"max_tokens":N,"messages":[{"content":C,"role":R},...],"model":M,"version":"flop.chat-turn.v1"}`, the keys in
 * the order the SDK's sort gives, encoded as UTF-8. Refused (BAD_INPUT): any field out of the form above, and an
 * input over LIMITS.INPUT_MAX_BYTES.
 */
export function turnInput(value: TurnInputInput): TurnInput {
  const f = fieldsOf(value, ["expected", "messages", "maxTokens"], "turn input");
  const expected = pinnedOf(f.expected);
  const items = itemsOf(f.messages, 1, LIMITS.MESSAGES_MAX, "turn input.messages");
  const maxTokens = wholeIn(f.maxTokens, 1, LIMITS.MAX_TOKENS_MAX, "turn input.maxTokens");
  const messages = items.map(messageOf);
  const text = `{"max_tokens":${String(maxTokens)},"messages":[${messages.join(",")}],"model":${jsonString(expected.identity.requestedSlug)},"version":${jsonString(CHAT_TURN_VERSION)}}`;
  const input = utf8(text);
  if (input.length > LIMITS.INPUT_MAX_BYTES) refuseMiner("BAD_INPUT", "turn input", `turn input must be at most ${LIMITS.INPUT_MAX_BYTES} bytes of UTF-8`);
  return Object.freeze({ input, hIn: blake2b(input, { dkLen: 32 }) });
}
freezeFunction(turnInput);

/** h_in of input bytes: blake2b 256. */
export function inputHash(value: { readonly input: Uint8Array }): Uint8Array {
  const f = fieldsOf(value, ["input"], "input hash");
  return blake2b(bytesIn(f.input, null, "input hash.input"), { dkLen: 32 });
}
freezeFunction(inputHash);
