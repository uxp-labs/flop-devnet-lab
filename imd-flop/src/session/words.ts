/**
 * Shared words and JSON forms of the session commands (P5b, rules C11, C13 and C16). Unknown is never 0 and never
 * empty: in words `unknown (<reason>)`, in JSON a null value with a reason beside it. Amounts in JSON are decimal
 * strings of raw units, never floats; in words they are raw and FLOP through the encoder's amountText.
 */
import { blake2b } from "@noble/hashes/blake2.js";
import { amountText } from "../chain/describe.js";
import type { Stored } from "../chain-read/result.js";
import type { NetworkInfo } from "../networks.js";
import { ss58Encode } from "../ss58.js";
import type { Account } from "./accounts.js";
import type { SessionState } from "../chain-read/read.js";

export { amountText };

/** What a command prints: its words line by line, its JSON, and its exit code. */
export interface Output {
  readonly lines: readonly string[];
  readonly json: Record<string, unknown>;
  readonly code: number;
}

export const hexOf = (b: Uint8Array): string => `0x${Buffer.from(b).toString("hex")}`;

/** The blake2b 256 of call bytes, as 0x hex. */
export const callHash = (bytes: Uint8Array): string => hexOf(blake2b(bytes, { dkLen: 32 }));

/** An account the chain gave as 0x hex, as an SS58 address of the network. */
export const ss58Of = (hex: string, net: NetworkInfo): string => ss58Encode(Uint8Array.from(Buffer.from(hex.slice(2), "hex")), net.ss58Prefix);

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A pallet name of an allow list, as the read gives it in 0x hex: its text when that is printable ASCII, else its hex. */
export function palletName(hex: string): string {
  try {
    const t = UTF8.decode(Uint8Array.from(Buffer.from(hex.slice(2), "hex")));
    return /^[\x21-\x7e]{1,64}$/.test(t) ? t : hex;
  } catch {
    return hex;
  }
}

export const unknownWords = (reason: string): string => `unknown (${reason})`;

/** A stored value in JSON: known as `{ state, value }`, absent as `{ state: "none", value: null }`, unknown as a null value with its reason. */
export function storedJson<T>(s: Stored<T>, value: (v: T) => unknown): Record<string, unknown> {
  if (s.kind === "unknown") return { state: "unknown", value: null, reason: s.reason };
  if (s.kind === "absent") return { state: "none", value: null };
  return { state: s.stored ? "stored" : "default", value: value(s.value) };
}

/** The accounts and the block every command names, in words and in JSON. */
export function headOf(seat: string, net: NetworkInfo, owner: Account, device: Account, s: SessionState): { lines: string[]; json: Record<string, unknown> } {
  return {
    lines: [`seat ${seat} on ${net.name}`, `  owner   ${owner.ss58}`, `  device  ${device.ss58}`, `  read at the finalized head ${s.number} ${s.hash}, runtime ${s.runtime.specName} ${s.runtime.specVersion}`],
    json: { seat, network: net.name, owner: owner.ss58, device: device.ss58, head: { number: s.number, hash: s.hash }, runtime: { specName: s.runtime.specName, specVersion: s.runtime.specVersion } },
  };
}

/** The last line of grant and revoke (C11). */
export const SIGNING_LINE = "The owner signs this call with his own wallet. This tool does not hold the owner's key and signs nothing.";
