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
  path: string; // display only; never re-parsed (a key may itself contain "." or "[")
  keys: Array<string | number>; // exact location, used for redaction
  reason: string;
}

export function scanForSecrets(value: unknown): Finding[] {
  const out: Finding[] = [];
  const visit = (v: unknown, path: string, keys: Array<string | number>, field: string) => {
    if (v === null || v === undefined) return;
    const hit = (reason: string) => out.push({ path, keys, reason });
    if (typeof v === "string") {
      for (const s of registry) if (v.includes(s)) hit("contains a loaded secret");
      if (BEARER.test(v)) hit("bearer token");
      if (FLOP_TOKEN.test(v)) hit("FLOP gateway token");
      if (PEM.test(v)) hit("PEM private key");
      if (!PUBLIC_HEX_FIELDS.has(field) && !SIGNATURE_FIELDS.has(field) && HEX64.test(v)) hit("64-or-more-hex (key-shaped) value");
      if (SECRET_FIELD.test(field) && v.length > 0) hit(`secret-named field "${field}"`);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => visit(x, `${path}[${i}]`, [...keys, i], field));
      return;
    }
    if (typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) visit(x, path ? `${path}.${k}` : k, [...keys, k], k);
      return;
    }
    if (SECRET_FIELD.test(field) && v !== false && v !== 0) hit(`secret-named field "${field}"`);
  };
  visit(value, "", [], "");
  return out;
}

function setNull(root: unknown, tokens: Array<string | number>): void {
  if (tokens.length === 0) return;
  let cur = root as Record<string | number, unknown> | unknown[] | null;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (cur == null) return;
    cur = (cur as Record<string | number, unknown>)[tokens[i]] as Record<string | number, unknown>;
  }
  if (cur != null) (cur as Record<string | number, unknown>)[tokens[tokens.length - 1]] = null;
}

/**
 * Copy with only the secret-scan hits removed. Other fields stay. Locations come from the scan's
 * key arrays, so a key containing "." or "[" is addressed exactly. `residual` lists any finding the
 * redaction could not clear (a root-level string); callers must not write such a copy.
 */
export function redactFlagged(value: unknown): { copy: unknown; redacted: boolean; removed: string[]; residual: Finding[] } {
  const findings = scanForSecrets(value);
  if (findings.length === 0) return { copy: value, redacted: false, removed: [], residual: [] };
  const copy = structuredClone(value);
  for (const finding of findings) setNull(copy, finding.keys);
  return { copy, redacted: true, removed: [...new Set(findings.map((f) => f.path || "(root)"))], residual: scanForSecrets(copy) };
}

export function assertNoSecrets(value: unknown, what: string): void {
  const f = scanForSecrets(value);
  if (f.length > 0) {
    // Report where and why, never the value itself.
    const where = f.map((x) => `${x.path || "(root)"}: ${x.reason}`).join("; ");
    throw new CliError(`secret scan blocked writing ${what}: ${where}`, EXIT.REFUSED_RULE);
  }
}

/**
 * Outside text: text this tool did not write, such as a server's error message, a transport error, or a value
 * read from a ledger row or another file. It never reaches a sink raw. The sinks are the ledger, a receipt, a
 * response file, stdout and stderr. It passes through outsideText (a message) or outsideValue (a field
 * value), and the same result goes to every sink (swarm audit 33f3b9f, findings 3, 6 and 10).
 */

/** The most characters of outside text a message keeps by default. */
export const OUTSIDE_TEXT_MAX = 1000;
/** What a message says in place of outside text the secret scan refused. */
export const OUTSIDE_WITHHELD = "[withheld by the secret scan]";
/** A mark form shorter than this is not used: it hides nothing worth hiding and mangles text like "HTTP 401". */
export const MARK_MIN = 8;
/** A thing outside text may repeat, the forms it can be repeated in, and the mark that stands in for it. */
export interface Mark { forms: string[]; mark: string }

/**
 * Outside text made safe for every sink, in this order:
 *  0. the secret scan runs on the text as it came (0x and 64 hex hashes aside): a hit withholds it all;
 *  1. every form of every mark of at least MARK_MIN characters is replaced by its mark, the longest first;
 *  2. every 0x and 64 hex run (a public hash, or a key) is replaced by [hash];
 *  3. if the secret scan finds anything after the marks, the whole text is withheld (OUTSIDE_WITHHELD);
 *  4. the text is cut to `max` characters, and a cut text ends with "[cut]".
 * The scan runs before the cut, so a cut never hides part of a key from it.
 */
export function outsideText(text: unknown, opts: { marks?: Mark[]; max?: number } = {}): string {
  let s = typeof text === "string" ? text : String(text);
  // The scan runs on the text as it came first: a mark replaced inside a key would split it and hide it.
  if (scanForSecrets({ reason: s.replace(/0x[0-9a-fA-F]{64}/g, "[hash]") }).length > 0) return OUTSIDE_WITHHELD;
  const forms = (opts.marks ?? []).flatMap((m) => m.forms.filter((f) => f.length >= MARK_MIN).map((form) => ({ form, mark: m.mark })));
  for (const { form, mark } of forms.sort((a, b) => b.form.length - a.form.length)) s = s.split(form).join(mark);
  s = s.replace(/0x[0-9a-fA-F]{64}/g, "[hash]");
  if (scanForSecrets({ reason: s }).length > 0) return OUTSIDE_WITHHELD;
  const max = opts.max ?? OUTSIDE_TEXT_MAX;
  return s.length > max ? `${s.slice(0, max)}[cut]` : s;
}

/** The longest string value a message may quote. */
const QUOTE_MAX = 32;

/**
 * A field value read from a file, for a message. It is quoted only when it is a string of at most 32
 * characters that the secret scan passes. Anything else is described by its type and its length, so a message
 * about a damaged row can always be written to the ledger and printed.
 */
export function outsideValue(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return v.length <= QUOTE_MAX && scanForSecrets({ reason: v }).length === 0 ? JSON.stringify(v) : `a string of ${v.length} ${v.length === 1 ? "character" : "characters"}`;
  if (typeof v === "number") return "a number";
  if (typeof v === "boolean") return "a boolean";
  if (Array.isArray(v)) return `an array of ${v.length} ${v.length === 1 ? "item" : "items"}`;
  if (typeof v === "object") {
    const n = Object.keys(v).length;
    return `an object of ${n} ${n === 1 ? "key" : "keys"}`;
  }
  return `a ${typeof v}`;
}
