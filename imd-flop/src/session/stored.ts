/**
 * What is stored for an owner and device pair, named once (P5b fix, RP5B-4). `grant` decides by this name and `revoke`
 * prints it, so the two commands cannot differ on one state. Pure.
 *
 * Past its expiry means the record is stored as active and the head is at or past `expires_at`. A record stored as not
 * active is revoked, whatever its expiry. The chain's own comparison of the expiry is not shown to the lab, so the
 * grant that is printed over such a record carries a line that says so.
 */
import type { SessionRecord } from "../chain-read/session-state.js";

export type StoredName = "no session" | "an active session" | "a session past its expiry" | "a revoked session";

export function storedName(record: SessionRecord | null, head: number): StoredName {
  if (record === null) return "no session";
  if (!record.active) return "a revoked session";
  return head >= record.expires_at ? "a session past its expiry" : "an active session";
}
