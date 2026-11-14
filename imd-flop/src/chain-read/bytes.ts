/**
 * Hex text and bytes, in chain-read's one form: 0x and an even number of lower case hex digits. The conversions
 * are @noble/hashes' own. Pure.
 */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { freezeFunction } from "../freeze.js";

const HEX = /^0x(?:[0-9a-f]{2})*$/;

/** True when the text is 0x and an even number of lower case hex digits. */
export const isHex = (text: unknown): text is string => typeof text === "string" && HEX.test(text);
freezeFunction(isHex);

/** The bytes of a hex text that isHex accepted. */
export const bytesOf = (text: string): Uint8Array => hexToBytes(text.slice(2));
freezeFunction(bytesOf);

/** The hex text of bytes. */
export const hexOf = (bytes: Uint8Array): string => `0x${bytesToHex(bytes)}`;
freezeFunction(hexOf);
