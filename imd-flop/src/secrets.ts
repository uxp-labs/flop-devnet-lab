/**
 * Rule 1 (keys stay local), enforced: every log, ledger, receipt, link or response file
 * goes through assertNoSecrets() before it touches disk. It rejects:
 *  - exact copies of any secret this process has loaded (seat seed, gateway bearer, child token),
 *    in hex, base64, base64url or base58 form;
 *  - bearer tokens ("Bearer x", "flop_ek_...", "flop_sk_..." style gateway keys);
 *  - PEM private-key blocks;
 *  - any 64-hex run (32 bytes: the shape of an Ed25519 seed or an EVM private key), except in
 *    fields whose name is on a short allowlist of public 32-byte values (hashes, nonces);
 *  - non-empty values under secret-named fields (private_key, seed, mnemonic, api_key, token, ...).
 * Public keys are written only as SS58 / did:key, never as raw hex, so they never trip the 64-hex rule.
 */
import { base58, base64, base64url } from "@scure/base";
import { bytesToHex } from "@noble/hashes/utils.js";
import { CliError, EXIT } from "./errors.js";

const registry = new Set<string>();

export function registerSecret(secret: Uint8Array | string): void {
  if (typeof secret === "string") {
    if (secret.length >= 8) registry.add(secret);
    return;
  }
  const hex = bytesToHex(secret);
  registry.add(hex);
  registry.add(hex.toUpperCase());
  registry.add(base64.encode(secret).replace(/=+$/, ""));
  registry.add(base64url.encode(secret).replace(/=+$/, ""));
  registry.add(base58.encode(secret));
}

export function clearSecretRegistry(): void {
  registry.clear();
}

/** Field names whose 64-hex values are public (hashes / nonces / ids), never keys. */
export const PUBLIC_HEX_FIELDS = new Set([
  "genesisHash",
  "faucetGenesis",
  "rpcGenesis",
  "terminal_event",
  "channel_id",
  "tx_hash",
  "block_hash",
  "prompt_sha256",
  "output_sha256",
  "statement_sha256",
  "nonce",
]);

const SECRET_FIELD = /^(private[_-]?key|privkey|secret|secret[_-]?key|seed|seed[_-]?phrase|mnemonic|api[_-]?key|apikey|bearer|authorization|access[_-]?token|token|password|passphrase|key)$/i;
const HEX64 = /(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64,}(?![0-9a-fA-F])/;
/** Ed25519 and EIP-712 signatures are longer than a 32-byte key and are stored under these names. */
const SIGNATURE_FIELDS = new Set(["sig", "signature", "flopSignature"]);
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/;
const FLOP_TOKEN = /\bflop_(?:ek|sk|pk|key|live|test)?_?[A-Za-z0-9]{16,}/;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

export interface Finding {
  path: string;
  reason: string;
}

export function scanForSecrets(value: unknown): Finding[] {
  const out: Finding[] = [];
  const visit = (v: unknown, path: string, field: string) => {
    if (v === null || v === undefined) return;
    if (typeof v === "string") {
      for (const s of registry) if (v.includes(s)) out.push({ path, reason: "contains a loaded secret" });
      if (BEARER.test(v)) out.push({ path, reason: "bearer token" });
      if (FLOP_TOKEN.test(v)) out.push({ path, reason: "FLOP gateway token" });
      if (PEM.test(v)) out.push({ path, reason: "PEM private key" });
      if (!PUBLIC_HEX_FIELDS.has(field) && !SIGNATURE_FIELDS.has(field) && HEX64.test(v)) out.push({ path, reason: "64-or-more-hex (key-shaped) value" });
      if (SECRET_FIELD.test(field) && v.length > 0) out.push({ path, reason: `secret-named field "${field}"` });
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => visit(x, `${path}[${i}]`, field));
      return;
    }
    if (typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) visit(x, path ? `${path}.${k}` : k, k);
      return;
    }
    if (SECRET_FIELD.test(field) && v !== false && v !== 0) out.push({ path, reason: `secret-named field "${field}"` });
  };
  visit(value, "", "");
  return out;
}

function setNull(root: unknown, path: string): void {
  const tokens: Array<string | number> = [];
  for (const part of path.split(".")) {
    const re = /([^[\].]+)|\[(\d+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(part))) tokens.push(m[1] !== undefined && m[1] !== "" ? m[1] : Number(m[2]));
  }
  let cur = root as Record<string | number, unknown> | unknown[] | null;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (cur == null) return;
    cur = (cur as Record<string | number, unknown>)[tokens[i]] as Record<string | number, unknown>;
  }
  if (cur != null) (cur as Record<string | number, unknown>)[tokens[tokens.length - 1]] = null;
}

/** Copy with only the secret-scan hits removed. Other fields stay. */
export function redactFlagged(value: unknown): { copy: unknown; redacted: boolean } {
  const findings = scanForSecrets(value);
  if (findings.length === 0) return { copy: value, redacted: false };
  const copy = structuredClone(value);
  for (const finding of findings) if (finding.path) setNull(copy, finding.path);
  return { copy, redacted: true };
}

export function assertNoSecrets(value: unknown, what: string): void {
  const f = scanForSecrets(value);
  if (f.length > 0) {
    // Report where and why, never the value itself.
    const where = f.map((x) => `${x.path || "(root)"}: ${x.reason}`).join("; ");
    throw new CliError(`secret scan blocked writing ${what}: ${where}`, EXIT.REFUSED_RULE);
  }
}
