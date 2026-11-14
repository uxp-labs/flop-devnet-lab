/**
 * The two accounts of a session (P5b, rules C3 and C4). S, the seat's owner, comes in on the command line as an
 * SS58 address each time: this tool stores no owner and never holds the owner's key. D, the seat's device key, is
 * read from the seat's identity file, which holds its public key as a did:key: no key file is read here.
 */
import { CliError, EXIT } from "../errors.js";
import { readIdentity } from "../keys.js";
import type { NetworkInfo } from "../networks.js";
import { bytesEqual, pubFromDidKey, ss58Decode, ss58Encode } from "../ss58.js";

/** An account of the session: its 32 byte public key and its SS58 address on the network. */
export interface Account {
  readonly pub: Uint8Array;
  readonly ss58: string;
  /** 0x and 64 lower case hex digits, as the chain reads take an account. */
  readonly hex: string;
}

const hexOf = (b: Uint8Array): string => `0x${Buffer.from(b).toString("hex")}`;

function accountOf(pub: Uint8Array, net: NetworkInfo): Account {
  return Object.freeze({ pub: Uint8Array.from(pub), ss58: ss58Encode(pub, net.ss58Prefix), hex: hexOf(pub) });
}

/**
 * D, from the seat's identity.json `did` (rule C4). A seat with no identity file is a usage error, as for the other
 * commands; an identity whose did is not an ed25519 did:key is a damaged file, exit 1.
 */
export function deviceOf(home: string, seat: string, net: NetworkInfo): Account {
  const id = readIdentity(home, seat);
  if (id === null) throw new CliError(`no FLOP identity for seat ${seat}; run \`imd-flop init --seat ${seat}\``, EXIT.USAGE);
  let pub: Uint8Array;
  try {
    pub = pubFromDidKey(String(id.did));
  } catch {
    throw new CliError(`the identity file of seat ${seat} holds no ed25519 did:key, so the device key's account is not known`, EXIT.ERROR);
  }
  return accountOf(pub, net);
}

/**
 * S, from `--owner` (rule C3): an SS58 address of the network's prefix with a good checksum, and not D. Anything else
 * is a usage error, exit 2. The text given is not echoed.
 */
export function ownerOf(text: string | undefined, net: NetworkInfo, device: Account): Account {
  if (text === undefined || text.length === 0) throw new CliError("--owner <ss58> is required: the address of the seat's owner, who signs the session's calls in his own wallet", EXIT.USAGE);
  let decoded: { prefix: number; pub: Uint8Array };
  try {
    decoded = ss58Decode(text);
  } catch (e) {
    const why = e instanceof Error && /checksum|32-byte/.test(e.message) ? e.message.replace(/^ss58: /, "") : "not base58";
    throw new CliError(`--owner is not an SS58 account address (${why})`, EXIT.USAGE);
  }
  if (decoded.prefix !== net.ss58Prefix) throw new CliError(`--owner has the SS58 prefix ${decoded.prefix}, not ${net.ss58Prefix} of ${net.name}`, EXIT.USAGE);
  if (bytesEqual(decoded.pub, device.pub)) throw new CliError("--owner is the seat's own device key: the owner grants the device a session, and an account cannot delegate to itself", EXIT.USAGE);
  return accountOf(decoded.pub, net);
}
