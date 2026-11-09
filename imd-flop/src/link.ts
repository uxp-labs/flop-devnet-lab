/**
 * Seat-to-DID link (proposal section A): {tokenId, erc8004AgentId, flopDid, ss58, network, genesisHash, issuedAt},
 * signed twice: Ed25519 by the FLOP key (here) and EIP-712 by the wallet holding the seat NFT
 * (elsewhere; we only emit typed data and never hold or ask for a wallet key or seed).
 * v1 binds the link to FLOP's genesis hash, and verify can check the seat's current ownerOf so a sale kills the link.
 */
import { existsSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { getAddress, isAddress, recoverTypedDataAddress, type Hex } from "viem";
import { CliError, EXIT } from "./errors.js";
import { network, SEAT_CHAIN_ID, SEAT_COLLECTION } from "./networks.js";
import { bytesEqual, pubFromDidKey, ss58Decode } from "./ss58.js";
import type { Signer } from "./keys.js";

export interface LinkStatement {
  tokenId: string; // decimal uint256
  erc8004AgentId: string | null; // decimal, null until known
  flopDid: string;
  ss58: string;
  network: string;
  genesisHash: string; // 0x-prefixed block 0 hash of the FLOP chain
  issuedAt: number; // unix seconds
}

export const LINK_DOMAIN_TAG = "imd-flop/seat-link/v1\n";
const FIELDS: (keyof LinkStatement)[] = ["tokenId", "erc8004AgentId", "flopDid", "ss58", "network", "genesisHash", "issuedAt"];

/** Fixed field order, no whitespace. This exact string (with the tag) is what Ed25519 signs. */
export function canonicalStatement(s: LinkStatement): string {
  return JSON.stringify(Object.fromEntries(FIELDS.map((k) => [k, s[k]])));
}
export function statementMessage(s: LinkStatement): Uint8Array {
  return utf8ToBytes(LINK_DOMAIN_TAG + canonicalStatement(s));
}

export const EIP712_TYPES = {
  SeatFlopLink: [
    { name: "tokenId", type: "uint256" },
    { name: "erc8004AgentId", type: "string" },
    { name: "flopDid", type: "string" },
    { name: "ss58", type: "string" },
    { name: "network", type: "string" },
    { name: "genesisHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "flopSignature", type: "bytes" },
  ],
} as const;

export function eip712Domain() {
  return { name: "imd-flop seat link", version: "1", chainId: SEAT_CHAIN_ID, verifyingContract: SEAT_COLLECTION } as const;
}

/** JSON-safe typed data (numbers as decimal strings) for eth_signTypedData_v4 on the holder's own wallet. */
export function eip712TypedData(s: LinkStatement, flopSig: Hex) {
  return {
    domain: eip712Domain(),
    types: EIP712_TYPES,
    primaryType: "SeatFlopLink" as const,
    message: {
      tokenId: s.tokenId,
      erc8004AgentId: s.erc8004AgentId ?? "",
      flopDid: s.flopDid,
      ss58: s.ss58,
      network: s.network,
      genesisHash: s.genesisHash,
      issuedAt: String(s.issuedAt),
      flopSignature: flopSig,
    },
  };
}

export interface LinkFile {
  v: 1;
  statement: LinkStatement;
  statement_sha256: string;
  flop: { alg: "Ed25519"; signer: string; sig: Hex };
  eip712: ReturnType<typeof eip712TypedData>;
  wallet: { address: string; signature: Hex } | null;
  note: string;
}

export function buildLink(signer: Signer, opts: { tokenId: string; agentId?: string; issuedAt?: number }): LinkFile {
  const id = signer.identity;
  if (!/^[0-9]{1,78}$/.test(opts.tokenId)) throw new CliError("--token must be a decimal tokenId", EXIT.USAGE);
  if (opts.agentId !== undefined && !/^[0-9]{1,78}$/.test(opts.agentId)) throw new CliError("--agent must be a decimal ERC-8004 agentId", EXIT.USAGE);
  const statement: LinkStatement = {
    tokenId: opts.tokenId,
    erc8004AgentId: opts.agentId ?? null,
    flopDid: id.did,
    ss58: id.ss58,
    network: id.network,
    genesisHash: network(id.network).genesisHash,
    issuedAt: opts.issuedAt ?? Math.floor(Date.now() / 1000),
  };
  const msg = statementMessage(statement);
  const sig = ("0x" + bytesToHex(signer.sign(msg))) as Hex;
  return {
    v: 1,
    statement,
    statement_sha256: bytesToHex(sha256(msg)),
    flop: { alg: "Ed25519", signer: id.did, sig },
    eip712: eip712TypedData(statement, sig),
    wallet: null,
    note: "wallet signature pending: the seat holder signs `eip712` with the wallet that holds the NFT, on their own machine (eth_signTypedData_v4).",
  };
}

export interface VerifyResult {
  ok: boolean;
  flopSig: boolean;
  didMatchesSs58: boolean;
  ss58PrefixOk: boolean;
  eip712MatchesStatement: boolean;
  genesisOk: boolean;
  owner: { checked: boolean; ok: boolean; current?: string | null };
  wallet: { checked: boolean; ok: boolean; recovered?: string; expected?: string };
  errors: string[];
}

/**
 * opts.currentOwner: the seat's ownerOf(tokenId) as read by the caller (null = token does not exist).
 * When given, the wallet that signed must still own the seat; a sale or transfer kills the link.
 */
export async function verifyLink(file: LinkFile, opts: { walletSig?: string; wallet?: string; currentOwner?: string | null } = {}): Promise<VerifyResult> {
  const errors: string[] = [];
  const r: VerifyResult = {
    ok: false,
    flopSig: false,
    didMatchesSs58: false,
    ss58PrefixOk: false,
    eip712MatchesStatement: false,
    genesisOk: false,
    owner: { checked: false, ok: false },
    wallet: { checked: false, ok: false },
    errors,
  };
  const s = file?.statement;
  if (!s || FIELDS.some((k) => !(k in s))) {
    errors.push("statement is missing fields");
    return r;
  }
  let pub: Uint8Array | null = null;
  try {
    pub = pubFromDidKey(s.flopDid);
    const dec = ss58Decode(s.ss58);
    r.didMatchesSs58 = bytesEqual(pub, dec.pub);
    if (!r.didMatchesSs58) errors.push("ss58 and did:key are different keys");
    try {
      r.ss58PrefixOk = dec.prefix === network(s.network).ss58Prefix;
    } catch {
      r.ss58PrefixOk = false;
    }
    if (!r.ss58PrefixOk) errors.push(`ss58 prefix ${dec.prefix} does not match network ${s.network}`);
  } catch (e) {
    errors.push(`bad did/ss58: ${(e as Error).message}`);
  }
  try {
    r.genesisOk = typeof s.genesisHash === "string" && s.genesisHash.toLowerCase() === network(s.network).genesisHash.toLowerCase();
  } catch {
    r.genesisOk = false;
  }
  if (!r.genesisOk) errors.push(`genesisHash ${s.genesisHash} is not ${s.network}'s genesis (chain reset, fork, or wrong network)`);
  if (file.flop?.signer !== s.flopDid) errors.push("flop.signer is not statement.flopDid");
  if (pub) {
    try {
      r.flopSig = ed25519.verify(hexToBytes(file.flop.sig.replace(/^0x/, "")), statementMessage(s), pub);
    } catch {
      r.flopSig = false;
    }
    if (!r.flopSig) errors.push("Ed25519 signature does not verify over the statement");
  }
  // Re-derive the typed data from the statement; never trust the file's eip712 block.
  const expected = eip712TypedData(s, file.flop?.sig);
  r.eip712MatchesStatement = JSON.stringify(expected) === JSON.stringify(file.eip712);
  if (!r.eip712MatchesStatement) errors.push("eip712 block does not match the statement");

  const walletSig = opts.walletSig ?? file.wallet?.signature;
  const walletAddr = opts.wallet ?? file.wallet?.address;
  if (walletSig || walletAddr) {
    r.wallet.checked = true;
    if (!walletSig || !walletAddr || !isAddress(walletAddr)) {
      errors.push("wallet check needs both --wallet-sig and a valid --wallet address");
    } else {
      try {
        const recovered = await recoverTypedDataAddress({
          domain: expected.domain,
          types: expected.types,
          primaryType: expected.primaryType,
          message: { ...expected.message, genesisHash: s.genesisHash as Hex, tokenId: BigInt(s.tokenId), issuedAt: BigInt(s.issuedAt) },
          signature: walletSig as Hex,
        });
        r.wallet.recovered = recovered;
        r.wallet.expected = getAddress(walletAddr);
        r.wallet.ok = recovered === r.wallet.expected;
        if (!r.wallet.ok) errors.push("EIP-712 signature was not made by --wallet");
      } catch (e) {
        errors.push(`EIP-712 signature invalid: ${(e as Error).message.split("\n")[0]}`);
      }
    }
  }
  if (opts.currentOwner !== undefined) {
    r.owner.checked = true;
    r.owner.current = opts.currentOwner ? getAddress(opts.currentOwner) : null;
    const signer = r.wallet.ok ? r.wallet.expected : undefined;
    if (!r.owner.current) errors.push(`seat ${s.tokenId} has no owner (ownerOf reverted or burned)`);
    else if (!signer) errors.push("owner check needs a verified wallet signature to compare against");
    else if (r.owner.current !== signer) errors.push(`seat ${s.tokenId} is now owned by ${r.owner.current}, not the signer ${signer}: link is dead`);
    r.owner.ok = !!signer && r.owner.current === signer;
  }
  r.ok = errors.length === 0 && r.flopSig && r.didMatchesSs58 && r.ss58PrefixOk && r.genesisOk && r.eip712MatchesStatement && (!r.wallet.checked || r.wallet.ok) && (!r.owner.checked || r.owner.ok);
  return r;
}

export function linkExists(path: string): boolean {
  return existsSync(path);
}
