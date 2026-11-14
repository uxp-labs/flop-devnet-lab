// The owner's call of a step and its signed file (H1, H3). No network, no key: the research
// signer's call command takes no key, and the signature is checked with the signer's public key.
//
//   toolCall       the tool's printed call of the step (tool/<id>.call.json of tool-run.mjs): exit 0,
//                  the plan's command, owner and device, the plan's runtime, the derived caps
//   secondEncoder  what our research signer prints for the step's second_encoder line of steps.json,
//                  every $NAME resolved: a second encoder of the same call (H3)
//   checkOwnerSigned  a signed file is exactly the tool's call for the plan's owner, nonce, runtime and
//                  chain: the last batch's checkResearchSigned with its expected parameter (signer
//                  OWNER, the nonce by the record, the call the tool printed), then the file's own
//                  spec, transaction version and genesis, and the signature over the payload the
//                  plan's spec, transaction version and genesis make, so those three are held by bytes.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, readJson, substitute, V } from "./lib.mjs";
import { planStepOf, toolFile } from "./run.mjs";
import { checkResearchSigned, compact, nonceOf, partsOf, ResearchSignedError } from "../2026-11-12-encoder-devnet-test/research-signed.mjs";

export class OwnerCallError extends Error {}
const no = (m) => { throw new OwnerCallError(m); };

const lib = (name) => import(pathToFileURL(createRequire(join(REPO, "imd-flop", "package.json")).resolve(name)).href);
const { ed25519 } = await lib("@noble/curves/ed25519.js");
const { blake2b } = await lib("@noble/hashes/blake2.js");

const CALL_NAME = { grant: "create_session", revoke: "revoke_session" };

/** The caps the plan derives for a grant, in the tool's JSON form (grant.ts caps). */
export const plannedCaps = (plan) => ({ spending_cap: V(plan, "SPENDING_CAP"), per_tx_limit: V(plan, "A_PER_TX"), daily_cap: V(plan, "A_DAILY"), duration_blocks: Number(V(plan, "DURATION")), days: Number(V(plan, "DAYS")), epoch_length: Number(V(plan, "EPOCH_BLOCKS")) });

/** The stored record line the plan expects of a grant: none before G1; the revoked record and the line of grant.ts at G2. */
export const plannedStored = (plan, id) => (id === "G1" ? null : `A record is stored for this pair, revoked. ${V(plan, "STORED_RECORD_LINE")}`);

/**
 * The tool's printed call of a step, held to the plan: exit 0, the plan's argv, the call's name, the
 * owner and the device of the record, the plan's runtime, and for a grant the derived caps and the
 * stored record line. Returns { call_hex, output } or throws with what differs.
 */
export function toolCall(plan, run, results, id) {
  const step = planStepOf(plan, id) ?? no(`steps.json has no step ${id}`);
  const file = toolFile(run, id, "call");
  if (!existsSync(file)) no(`tool/${id}.call.json is not in the run folder: run tool-run.mjs ${id} call over a fresh tape`);
  const o = readJson(file);
  const argv = plan.commands[step.command].map((a) => substitute(a, plan, results, true));
  if (JSON.stringify(o.argv) !== JSON.stringify(argv)) no(`tool/${id}.call.json ran ${JSON.stringify(o.argv)}, not the plan's ${JSON.stringify(argv)}`);
  if (o.exit !== 0) no(`the tool exited ${o.exit} for ${id}, not 0: ${(o.stderr ?? []).join(" ") || "no words"}`);
  const j = o.json ?? no(`the tool printed no JSON for ${id}`);
  const diffs = [];
  const want = (what, got, plan_) => { if (JSON.stringify(got) !== JSON.stringify(plan_)) diffs.push(`${what} is ${JSON.stringify(got)}, the plan's is ${JSON.stringify(plan_)}`); };
  want("the call", j.call, CALL_NAME[step.command]);
  want("the owner", j.owner, V(plan, "OWNER_SS58"));
  want("the device", j.device, results.accounts.device.ss58);
  want("the runtime", j.runtime, { specName: V(plan, "SPEC_NAME"), specVersion: Number(V(plan, "SPEC")) });
  if (step.command === "grant") {
    want("the caps", j.caps, plannedCaps(plan));
    want("the stored record line", j.stored_record, plannedStored(plan, id.split(".")[0]));
  }
  if (typeof j.call_hex !== "string" || !/^0x([0-9a-f]{2})+$/.test(j.call_hex)) diffs.push("the call hex is not 0x hex");
  if (diffs.length) no(`the tool's call of ${id} is not the plan's: ${diffs.join("; ")}`);
  return { call_hex: j.call_hex, output: o };
}

/** What our research signer prints for the step's second_encoder line: { call, what }. */
export function secondEncoder(plan, results, step) {
  const args = step.second_encoder.map((a) => substitute(a, plan, results, true));
  const out = execFileSync(process.execPath, [join(REPO, plan.files.signer), "call", ...args, "--libs", join(REPO, "imd-flop")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const { call, what } = JSON.parse(out);
  if (typeof call !== "string" || !/^0x([0-9a-f]{2})+$/.test(call)) no(`the research signer printed no call for ${step.id}`);
  return { call, what };
}

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

/** The payload flop-sign.mjs sign signs, for the plan's spec, transaction version and genesis (its head: the signed extensions). */
export function signedPayload(plan, call, nonce) {
  const genesis = Buffer.from(V(plan, "GENESIS").slice(2), "hex");
  const extra = Buffer.concat([Buffer.of(0), compact(nonce), compact(0), Buffer.of(0)]);
  const additional = Buffer.concat([u32(Number(V(plan, "SPEC"))), u32(Number(V(plan, "TXV"))), genesis, genesis, Buffer.of(0)]);
  const payload = Buffer.concat([Buffer.from(call.slice(2), "hex"), extra, additional]);
  return payload.length > 256 ? Buffer.from(blake2b(payload, { dkLen: 32 })) : payload;
}

/**
 * Refuses a signed file of an owner step unless it is exactly the tool's call for the plan's owner,
 * the nonce by the record, the plan's spec, transaction version and genesis. Returns { extrinsic_hash, nonce }.
 */
export function checkOwnerSigned(plan, results, id, signed, call) {
  const nonce = nonceOf(plan, results, id);
  const expected = { signer: V(plan, "OWNER"), nonce, call };
  try { checkResearchSigned(plan, results, id, signed, expected); } catch (e) { if (e instanceof ResearchSignedError) no(e.message); throw e; }
  const diffs = [];
  const want = (what, got, plan_) => { if (got !== plan_) diffs.push(`its ${what} is ${JSON.stringify(got ?? null)}, the plan's is ${JSON.stringify(plan_)}`); };
  want("spec_version", signed.spec_version, Number(V(plan, "SPEC")));
  want("transaction_version", signed.transaction_version, Number(V(plan, "TXV")));
  want("genesis", signed.genesis, V(plan, "GENESIS"));
  if (diffs.length) no(`signed/${id}.json is not the plan's ${id}, refused: ${diffs.join("; ")}`);
  const sig = partsOf(Buffer.from(signed.extrinsic.slice(2), "hex")).signature;
  if (!ed25519.verify(sig, signedPayload(plan, call, nonce), Buffer.from(V(plan, "OWNER").slice(2), "hex"))) no(`signed/${id}.json is not the plan's ${id}, refused: its signature does not verify over the plan's spec ${V(plan, "SPEC")}, transaction version ${V(plan, "TXV")} and genesis`);
  return { extrinsic_hash: signed.extrinsic_hash, nonce: String(nonce) };
}
