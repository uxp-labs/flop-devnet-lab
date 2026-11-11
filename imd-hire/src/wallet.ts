/**
 * The paying wallet. Its key lives in one file and is read in this module only. Nothing here returns,
 * prints or logs the key: callers get a viem account that can sign, and its address. No message
 * quotes the path either, since a key typed where the path belongs would otherwise be echoed.
 */
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { usage } from "./errors.js";

const KEY_HEX = /^0x[0-9a-fA-F]{64}$/;
const LOOKS_LIKE_A_KEY = /^(0x)?[0-9a-fA-F]{64}$/;

interface KeyFile {
  v: 0;
  alg: "secp256k1";
  key_hex: `0x${string}`;
}

function keyPath(path: string): string {
  if (LOOKS_LIKE_A_KEY.test(path.trim())) throw usage("--key takes the path of a key file, never a key. If that was a real key, treat it as exposed.");
  return path;
}

/** Makes a new key file (owner only, never overwritten) and returns its account. */
export function createKeyFile(path: string): PrivateKeyAccount {
  if (existsSync(keyPath(path))) throw usage("a key file already exists at the --key path; it is never overwritten");
  const key = generatePrivateKey();
  const file: KeyFile = { v: 0, alg: "secp256k1", key_hex: key };
  writeFileSync(path, JSON.stringify(file) + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return privateKeyToAccount(key);
}

/** Loads the account. Refuses a file others can read, and names no part of a malformed file. */
export function loadAccount(path: string): PrivateKeyAccount {
  if (!existsSync(keyPath(path))) throw usage("no key file at the --key path; make one with `imd-hire wallet new --key <file>`");
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw usage(`the key file is mode ${mode.toString(8)}; others can read it. Fix with chmod 600.`);
  let file: Partial<KeyFile>;
  try {
    file = JSON.parse(readFileSync(path, "utf8")) as Partial<KeyFile>;
  } catch {
    throw usage("the key file is not JSON");
  }
  if (file?.v !== 0 || file.alg !== "secp256k1" || typeof file.key_hex !== "string" || !KEY_HEX.test(file.key_hex)) {
    throw usage("the key file is not a v0 secp256k1 key file");
  }
  return privateKeyToAccount(file.key_hex);
}
