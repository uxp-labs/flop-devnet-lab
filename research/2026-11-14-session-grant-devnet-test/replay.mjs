// The loader of committed tapes (H16): for a run folder committed in this folder (its seat home's
// identity.json and config.json, its tapes, the tool's outputs and results.json; never a key file,
// never calls or signed files), it runs the tool again over each committed tape offline and holds
// the committed output and the record's values to what the tool gives now. The first data is the
// rehearsal's run folder, written by `node walk.mjs rehearsal-run`; after the batch the lead commits
// the run's folder and names it in COMMITTED. No network, no key.
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE, REPO, readJson, sha256Text, V } from "./lib.mjs";
import { committedMetadata, metadataIsCommitted, takeTape, genesisOf } from "./tape.mjs";
import { runOver } from "./tool-run.mjs";
import { decoderReading } from "./events.mjs";
import { sessionCountOf } from "./record-step.mjs";

/** The committed run folders of this folder, by name. */
export const COMMITTED = ["rehearsal-run"];

/** Every file of a folder, by its path from the folder. */
function filesOf(dir, base = dir) {
  return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? filesOf(p, base) : [p.slice(base.length + 1)]; });
}

/** The files a committed run folder may hold: by name only, so a key file is refused without being opened. */
const ALLOWED = [/^results\.json$/, /^seat\/config\.json$/, /^seat\/seats\/[a-z0-9]+\/identity\.json$/, /^tapes\/[A-Z0-9.]+\.(show|call|after|block)\.json$/, /^tool\/[A-Z0-9.]+\.(show|call|after|block)\.json$/];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const showOf = (o) => ({ exit: o.exit, head: o.json?.head ?? null, runtime: o.json?.runtime ?? null, session: o.json?.session ?? null, session_nonce: o.json?.session_nonce ?? null, circuit_breaker: o.json?.circuit_breaker ?? null, room: o.json?.room ?? null });
const pick = (x, keys) => Object.fromEntries(keys.map((k) => [k, x?.[k] ?? null]));

/** Runs the tool again over each committed tape of a folder and holds the folder to it. Returns { problems, checked }. */
export async function replay(plan, folder) {
  const problems = [];
  const files = filesOf(folder);
  for (const f of files) if (!ALLOWED.some((re) => re.test(f))) problems.push(`${f} is not a file a committed run folder holds (only results.json, the seat's config.json and identity.json, tapes and tool outputs)`);
  if (problems.length) return { problems, checked: 0 };
  const results = readJson(join(folder, "results.json"));
  const errors = readJson(join(REPO, plan.files.errors));
  const md = await committedMetadata(plan);
  const home = mkdtempSync(join(tmpdir(), "g19-replay-seat-"));
  cpSync(join(folder, "seat"), home, { recursive: true });
  const outputs = {};
  try {
    for (const f of files.filter((x) => x.startsWith("tool/"))) {
      const o = readJson(join(folder, f));
      const name = f.slice(5, -5);
      outputs[name] = o;
      const text = readFileSync(join(folder, "tapes", `${name}.json`), "utf8");
      if (sha256Text(text) !== o.tape_sha256) { problems.push(`${f}: its tape's sha256 is ${sha256Text(text)}, not ${o.tape_sha256}`); continue; }
      const t = takeTape(text, o.tape_sha256);
      if (genesisOf(t) !== V(plan, "GENESIS")) problems.push(`${f}: its tape's block 0 is not the plan's genesis`);
      if (!metadataIsCommitted(t, md)) problems.push(`${f}: its tape's metadata is not the committed bytes`);
      const block = o.purpose === "block" ? { number: o.argv[1], hash: o.argv[2] } : null;
      const { output } = await runOver({ t, md, argv: block ? null : o.argv, block, home });
      if (output.exit !== o.exit) problems.push(`${f}: the tool exits ${output.exit} now, the output says ${o.exit}`);
      if (!same(output.json, o.json)) problems.push(`${f}: the tool prints other JSON now than the committed output`);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
  // the record's values, held to the tool's outputs
  const p0 = outputs["P0.show"];
  if (results.p0) {
    if (!p0) problems.push("results.json holds P0 but tool/P0.show.json is not committed");
    else {
      if (!same(pick(results.p0, Object.keys(showOf(p0))), showOf(p0))) problems.push("results.json p0 is not the tool's P0 show");
      if (!same(results.p0.session_count, sessionCountOf(p0.owner_reads?.session_count))) problems.push("results.json p0.session_count is not the P0 tape's SessionCount(S)");
    }
  }
  for (const e of results.steps ?? []) {
    const id = e.step;
    if (e.call && !e.call.refused) {
      const o = outputs[`${id}.call`];
      if (!o || o.json?.call_hex !== e.call.call_hex || o.tape_sha256 !== e.call.tape_sha256) problems.push(`results.json ${id} call is not the tool's printed call over its committed tape`);
    }
    if (e.decoder) {
      const o = outputs[`${id}.block`];
      const d = o ? decoderReading(o, e.decoder.extrinsic_index, errors, V(plan, "OWNER")) : null;
      if (!d || !same(pick(e.decoder, ["events", "success", "error", "fee_raw"]), pick(d, ["events", "success", "error", "fee_raw"])) || o.tape_sha256 !== e.decoder.tape_sha256) problems.push(`results.json ${id} decoder is not the tool's readBlockEvents over its committed block tape`);
    }
    if (e.after) {
      const o = outputs[`${id}.after`];
      if (!o || !same(pick(e.after, Object.keys(showOf(o))), showOf(o)) || o.tape_sha256 !== e.after.tape_sha256) problems.push(`results.json ${id} after is not the tool's session show over its committed tape`);
    }
  }
  return { problems, checked: Object.keys(outputs).length };
}

export const committedFolder = (name) => join(HERE, name);
export const isCommitted = (name) => existsSync(committedFolder(name));
