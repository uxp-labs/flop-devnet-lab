// The shared part of this folder's tools: reads steps.json and the files it names, resolves each
// $NAME, and the storage keys the pane reads at the PC's word (the pane has no blake2b). The pure
// helpers of the last batch are imported from its folder, a reviewed record that is not changed:
// research/2026-11-12-encoder-devnet-test/lib.mjs. No network, no key.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { atPath, blake2b256Hex, flopText, fromSource, fromSs58, HASH, RAW, sha256Text, ss58 } from "../2026-11-12-encoder-devnet-test/lib.mjs";

export { atPath, blake2b256Hex, flopText, fromSource, fromSs58, HASH, RAW, sha256Text, ss58 };

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..", "..");
export const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
export const loadPlan = (dir = HERE) => readJson(join(dir, "steps.json"));

/** The built code of the tool and of its chain reads (imd-flop/dist), loaded by path. */
const dist = (rel) => import(pathToFileURL(join(REPO, "imd-flop", "dist", rel)).href);
export const loadTool = async () => {
  const [cli, read, keys, keyTable, ss58m] = await Promise.all([dist("cli.js"), dist("chain-read/read.js"), dist("chain-read/keys.js"), dist("chain-read/key-table.js"), dist("ss58.js")]);
  return { main: cli.main, readBlockEvents: read.readBlockEvents, keys, KEY_TABLE: keyTable.KEY_TABLE, pubFromDidKey: ss58m.pubFromDidKey };
};

/** A value of steps.json by its name. */
export const V = (plan, name) => {
  const v = plan.values[name];
  if (!v) throw new Error(`steps.json has no value ${name}`);
  return v.value;
};

/**
 * A computed value of steps.json from the values it names: mul (a product of whole numbers),
 * minus (the first less the second) or flop (a raw amount as FLOP text). Every operand is a value of steps.json or a whole number.
 */
export function computed(plan, spec) {
  const n = (x) => BigInt(RAW.test(String(x)) ? x : V(plan, x));
  if (spec.mul) return spec.mul.map(n).reduce((a, b) => a * b).toString();
  if (spec.minus) return (n(spec.minus[0]) - n(spec.minus[1])).toString();
  if (spec.flop) return flopText(n(spec.flop));
  throw new Error(`unknown computation ${JSON.stringify(spec)}`);
}

/**
 * Replaces each $NAME of a text: DEVICE and DEVICE_SS58 from the record's accounts, the rest from
 * the values of steps.json. strict: an unknown name throws.
 */
export function substitute(text, plan, results, strict = false) {
  return String(text).replace(/\$([A-Z][A-Z0-9_]*)/g, (w, name) => {
    if (name === "DEVICE" || name === "DEVICE_SS58") {
      const d = results?.accounts?.device;
      const v = name === "DEVICE" ? d?.public_key : d?.ss58;
      if (typeof v === "string") return v;
    } else if (plan.values[name]) return plan.values[name].value;
    if (strict) throw new Error(`${w} is not known`);
    return w;
  });
}

/** The runtime of the plan in the encoder's names, as lab.accountReads gives it. */
export const planRuntime = (plan) => ({ specName: V(plan, "SPEC_NAME"), specVersion: Number(V(plan, "SPEC")), transactionVersion: Number(V(plan, "TXV")), genesisHash: V(plan, "GENESIS") });

export const stepOf = (plan, id) => {
  const s = plan.steps.find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
};

const hexOf = (b) => "0x" + Buffer.from(b).toString("hex");

/**
 * The storage keys the pane reads for the owner and the device, computed on the PC: the tool's own
 * keys of the pair (imd-flop/dist/chain-read/keys.js sessionKeys at the key table's line of the plan's
 * spec), System.LastRuntimeUpgrade and System.Events (the same file), and the two owner keys the
 * record keeps beside them, SessionCount(S) and RotationHistory(S), from steps.json. Those two are
 * for S only: the report that names them gives them for S.
 */
export async function paneKeys(plan, owner, device) {
  const { keys, KEY_TABLE } = await loadTool();
  const line = KEY_TABLE.runtimes.find((r) => r.specName === V(plan, "SPEC_NAME") && r.specVersion === Number(V(plan, "SPEC")));
  if (!line) throw new Error(`the tool's key table has no line for ${V(plan, "SPEC_NAME")} ${V(plan, "SPEC")}`);
  const o = keys.accountOf(owner), d = keys.accountOf(device);
  if (o.kind !== "known" || d.kind !== "known") throw new Error("the owner and the device are 0x and 32 bytes of lower case hex");
  const k = keys.sessionKeys(line, o.value, d.value);
  if (k.kind !== "known") throw new Error(k.reason);
  if (owner !== V(plan, "OWNER")) throw new Error("SessionCount and RotationHistory are known here for the plan's OWNER only");
  return {
    lru: hexOf(keys.lastRuntimeUpgradeKey()),
    sessions: hexOf(k.value.sessions.key),
    nonces: hexOf(k.value.sessionNonces.key),
    breakers: hexOf(k.value.circuitBreakers.key),
    events: hexOf(keys.eventsKey()),
    session_count: V(plan, "SESSION_COUNT_KEY"),
    rotation_history: V(plan, "ROTATION_HISTORY_KEY"),
  };
}

/** The device's 32 byte account, from the seat's identity.json did (the tool's own form); no key file is read. */
export async function deviceOfSeat(home, seat) {
  const { pubFromDidKey } = await loadTool();
  const id = readJson(join(home, "seats", seat, "identity.json"));
  return hexOf(pubFromDidKey(String(id.did)));
}
