/**
 * One Ed25519 key per seat (rule 2). The seed lives only in seats/<seat>/flop.key (0600).
 * Nothing here returns or prints the seed; callers get a Signer.
 */
import { existsSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base64 } from "@scure/base";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { CliError, EXIT } from "./errors.js";
import { identityFile, keyFile, linkFile, revocationsFile, seatDir, seatsDir } from "./paths.js";
import { outsideValue, registerSecret } from "./secrets.js";
import { appendJsonlSafe, ensureDir, readJson, readSecretJson, writeJsonSafe, writeSecretFile } from "./store.js";
import { didKeyFromPub, ss58Encode } from "./ss58.js";
import { network } from "./networks.js";

export const UNASSIGNED = "unassigned";

export interface Identity {
  v: 0;
  seat: string;
  network: string;
  did: string;
  ss58: string;
  ss58Prefix: number;
  createdAt: string;
}

export interface Signer {
  identity: Identity;
  sign(msg: Uint8Array): Uint8Array;
}

/**
 * The most digits a seat id may have. A number of 64 digits or more is a run of 64 or more hex characters, which
 * the secret scan cannot tell from a key, so no file of such a seat could be written (review defect 9).
 * contract/rules.json SEAT_ID.max_digits.
 */
export const SEAT_MAX_DIGITS = 63;
/** Decimal digits with no leading zero, 0 alone allowed. contract/rules.json SEAT_ID.digits. */
const CANONICAL_DIGITS = /^(0|[1-9][0-9]*)$/;
/** Digits only, the shape a tokenId may be spelled in before it is made canonical. */
const ANY_DIGITS = /^[0-9]+$/;

/**
 * A seat id this tool accepts: the unassigned placeholder, or an NFT tokenId in canonical decimal (no leading
 * zero, 0 alone allowed) of at most 63 digits. One spelling per seat: the chain reads a tokenId as a number, so
 * 42 and 042 are one seat there, and every comparison here is of the text (swarm audit 33f3b9f, finding 4).
 * contract/rules.json SEAT_ID.
 */
export function isSeatId(seat: unknown): seat is string {
  return typeof seat === "string" && (seat === UNASSIGNED || (CANONICAL_DIGITS.test(seat) && seat.length <= SEAT_MAX_DIGITS));
}

/** Where a seat was read from, for the message that refuses it. */
export type SeatSource = "the command line" | "config.json";

/**
 * A seat from the command line or config.json: canonical, or a usage error that names where it came from, shows
 * the canonical spelling when only leading zeros are wrong, and says why a seat of 64 digits or more is refused.
 */
export function validateSeat(seat: string, from: SeatSource = "the command line"): string {
  if (isSeatId(seat as unknown)) return seat;
  if (ANY_DIGITS.test(seat)) {
    const canonical = seat.replace(/^0+/, "") || "0";
    if (canonical.length > SEAT_MAX_DIGITS) throw new CliError(`seat from ${from} has ${canonical.length} digits; at most ${SEAT_MAX_DIGITS} are allowed, because a number that long cannot be told from a key by the secret scan`, EXIT.USAGE);
    throw new CliError(`seat from ${from} must be written without leading zeros: write ${canonical}, not ${seat}`, EXIT.USAGE);
  }
  throw new CliError(`seat from ${from} must be an NFT tokenId (decimal), got ${outsideValue(seat)}`, EXIT.USAGE);
}

function makeIdentity(seat: string, net: string, pub: Uint8Array): Identity {
  const prefix = network(net).ss58Prefix;
  return { v: 0, seat, network: net, did: didKeyFromPub(pub), ss58: ss58Encode(pub, prefix), ss58Prefix: prefix, createdAt: new Date().toISOString() };
}

function encodeKeyFile(seed: Uint8Array): string {
  // The seed is stored base64 in a 0600 file. This file is the one place it exists.
  return JSON.stringify({ v: 0, alg: "ed25519", seed_b64: base64.encode(seed) }) + "\n";
}

export function readIdentity(h: string, seat: string): Identity | null {
  return readJson<Identity>(identityFile(h, seat));
}

/** The seat's seed, read through the one secret file reader. Refuses a key file others can read. */
function readSeed(h: string, seat: string): Uint8Array {
  const kf = keyFile(h, seat);
  const mode = statSync(kf).mode & 0o777;
  if (mode & 0o077) throw new CliError(`key file for seat ${seat} is mode ${mode.toString(8)}; expected 600. Fix with chmod 600.`, EXIT.REFUSED_RULE);
  const parsed = readSecretJson(kf, `key file for seat ${seat}`, (v): v is { seed_b64: string } => typeof (v as { seed_b64?: unknown })?.seed_b64 === "string");
  let seed: Uint8Array;
  try {
    seed = base64.decode(parsed.seed_b64);
    if (seed.length !== 32) throw new Error("length");
  } catch {
    throw new CliError(`key file for seat ${seat} ${kf} is malformed (the seed is not 32 bytes of base64); restore it from a backup or rotate the key`, EXIT.ERROR);
  }
  registerSecret(seed);
  return seed;
}

export function loadSigner(h: string, seat: string): Signer {
  const kf = keyFile(h, seat);
  const identity = readIdentity(h, seat);
  if (!existsSync(kf) || !identity) throw new CliError(`no FLOP key for seat ${seat}; run \`imd-flop init --seat ${seat}\``, EXIT.USAGE);
  const seed = readSeed(h, seat);
  const pub = ed25519.getPublicKey(seed);
  if (didKeyFromPub(pub) !== identity.did) throw new CliError(`seat ${seat}: key file does not match identity.json`, EXIT.REFUSED_RULE);
  return { identity, sign: (msg) => ed25519.sign(msg, seed) };
}

export interface InitResult {
  identity: Identity;
  rotated?: { revokedDid: string };
  /** The seat had a key file and no identity.json (an init that stopped half way): its identity was made from that key. */
  completed?: true;
}

export function initSeat(h: string, opts: { seat: string; network: string; rotate?: boolean }): InitResult {
  const seat = validateSeat(opts.seat);
  network(opts.network);
  const kf = keyFile(h, seat);
  ensureDir(h);
  ensureDir(seatDir(h, seat));
  const exists = existsSync(kf);
  // A key file with no identity.json is a seat an earlier init left half made. Complete it from that key: never a
  // second key, never a deleted one (review defect 9). With --rotate, the rotation then runs on the completed seat.
  if (exists && readIdentity(h, seat) === null) {
    const identity = makeIdentity(seat, opts.network, ed25519.getPublicKey(readSeed(h, seat)));
    writeJsonSafe(identityFile(h, seat), identity, "identity.json");
    if (!opts.rotate) return { identity, completed: true };
  }
  if (exists && !opts.rotate) {
    const id = readIdentity(h, seat);
    throw new CliError(
      `seat ${seat} already has a FLOP identity (${id?.did ?? "unknown"}). One DID per seat: pass --rotate to replace it (writes a revocation record).`,
      EXIT.REFUSED_RULE,
    );
  }
  const seed = ed25519.utils.randomSecretKey();
  registerSecret(seed);
  const pub = ed25519.getPublicKey(seed);
  const identity = makeIdentity(seat, opts.network, pub);

  let rotated: InitResult["rotated"];
  if (exists) {
    const old = loadSigner(h, seat);
    const revocation = {
      type: "imd-flop/revocation/v0",
      seat,
      network: old.identity.network,
      revokedDid: old.identity.did,
      revokedSs58: old.identity.ss58,
      replacedByDid: identity.did,
      reason: "rotate",
      revokedAt: new Date().toISOString(),
    };
    const sig = old.sign(utf8ToBytes("imd-flop/revocation/v0\n" + JSON.stringify(revocation)));
    const record = { ...revocation, signature: { alg: "Ed25519", by: old.identity.did, sig: "0x" + bytesToHex(sig) } };
    appendJsonlSafe(revocationsFile(h), record, "revocations.jsonl");
    // The old link no longer names this seat's DID; it must be re-made and re-signed.
    const lf = linkFile(h, seat);
    if (existsSync(lf)) renameSync(lf, `${lf}.revoked-${Date.now()}`);
    rotated = { revokedDid: old.identity.did };
    writeSecretFile(kf, encodeKeyFile(seed), { replace: true });
  } else {
    writeSecretFile(kf, encodeKeyFile(seed));
  }
  writeJsonSafe(identityFile(h, seat), identity, "identity.json");
  return { identity, rotated };
}

/** Move an unassigned key onto a seat the first time it is linked (keeps one DID per seat). */
export function claimUnassigned(h: string, seat: string): void {
  validateSeat(seat);
  if (seat === UNASSIGNED || existsSync(keyFile(h, seat))) return;
  const from = seatDir(h, UNASSIGNED);
  if (!existsSync(keyFile(h, UNASSIGNED))) {
    throw new CliError(`no FLOP key for seat ${seat}; run \`imd-flop init --seat ${seat}\``, EXIT.USAGE);
  }
  ensureDir(seatsDir(h));
  if (existsSync(seatDir(h, seat))) rmSync(seatDir(h, seat), { recursive: true });
  renameSync(from, seatDir(h, seat));
  const id = readIdentity(h, seat)!;
  writeJsonSafe(identityFile(h, seat), { ...id, seat }, "identity.json");
}

export function revokedDids(h: string): Set<string> {
  const rows = existsSync(revocationsFile(h))
    ? readFileSync(revocationsFile(h), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { revokedDid: string })
    : [];
  return new Set(rows.map((r) => r.revokedDid));
}
