/**
 * Canonical JSON as IMD defines it for the payment hash: keys sorted, no whitespace, integers only,
 * no undefined. The quote approval signs SHA-256 of this text, so one byte of difference from what
 * the server computes fails the order as invalid_quote_approval. A value outside the definition
 * throws here instead of being hashed as something the server would read differently.
 */
import { sha256, stringToBytes, type Hex } from "viem";

export function canon(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isSafeInteger(value)) throw new TypeError(`canonical JSON holds integers only, got ${String(value)}`);
      return JSON.stringify(value);
    case "object": {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canon(record[key])}`)
        .join(",")}}`;
    }
    default:
      throw new TypeError(`canonical JSON cannot hold a value of type ${typeof value}`);
  }
}

/** SHA-256 of the canonical JSON, as 0x plus 64 hex. */
export const canonHash = (value: unknown): Hex => sha256(stringToBytes(canon(value)));
