// F14: relays come from files. plan.mjs next prints, for each relay, the pane line, the line that
// shows its sha256 in the pane, a line that writes it into "<run>/relays/<step>.<name>.txt" from a
// here document with a quoted delimiter, and the command that reads the file. These tests run those
// lines through bash. No network, no key.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HERE, REPO, sha256Text } from "./lib.mjs";
import { plan, tempDir } from "./fixtures.mjs";
import { DELIMITER, readRelay, RelayError, relayFile, writable } from "./relay.mjs";
import { nextText } from "./plan.mjs";
import { newWalk } from "./walk.mjs";

const DIR = tempDir("g19-relay");
after(() => rmSync(DIR, { recursive: true, force: true }));
const bash = (script) => spawnSync("/bin/bash", ["-c", script], { encoding: "utf8", env: { ...process.env, LAB: REPO } });
const WRITE = `node "${join(HERE, "relay.mjs")}" write`;

test("F14: a relay with a single quote, a double quote, a dollar sign and a backslash goes through the here document and the file unchanged", () => {
  const value = { kind: "made", text: `it's "quoted" $HOME \`x\` $(echo no) \\ back \\\\ two`, n: 1 };
  const text = JSON.stringify(value);
  assert.ok(/'/.test(text) && /"/.test(text) && /\$/.test(text) && /\\/.test(text));
  const f = join(DIR, "relays", "G1.sent.txt");
  const p = bash(`${WRITE} "${f}" <<'${DELIMITER}'\n${text}\n${DELIMITER}\n`);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(JSON.parse(p.stdout).relay_sha256, sha256Text(text));
  assert.equal(readFileSync(f, "utf8"), text + "\n");
  const r = readRelay(f, sha256Text(text), "sent");
  assert.equal(r.text, text);
  assert.deepEqual(r.value, value);
});

test("F14: a relay line equal to the delimiter is refused when the file is written, and nothing is written", () => {
  // the line ends the here document at once: stdin is empty, and the write refuses it
  const f = join(DIR, "relays", "G1.tape.txt");
  const p = bash(`${WRITE} "${f}" <<'${DELIMITER}'\n${DELIMITER}\n${DELIMITER}\n`);
  assert.match(p.stderr, /relay: no relay was given: stdin is empty \(a relay line equal to RELAY_END ends the here document before it\)/);
  assert.equal(existsSync(f), false);
  // and a line equal to the delimiter anywhere in what the write is given, or more than one line
  assert.throws(() => writable(`{"a":1}\n${DELIMITER}\n`), (e) => e instanceof RelayError && /a line of the relay is RELAY_END/.test(e.message));
  assert.throws(() => writable(`{"a":1}\n{"b":2}\n`), /more than one line/);
  assert.throws(() => writable("\n"), /no relay was given/);
});

test("F14: a relay file is read with one trailing newline removed and held to its sha256", () => {
  const text = JSON.stringify({ a: 1 });
  const f = join(DIR, "one.txt");
  for (const [content, ok] of [[text, true], [text + "\n", true], [text + "\n\n", false], [" " + text, false]]) {
    writeFileSync(f, content);
    if (ok) assert.deepEqual(readRelay(f, sha256Text(text), "reads").value, { a: 1 });
    else assert.throws(() => readRelay(f, sha256Text(text), "reads"), (e) => e instanceof RelayError && /changed on its way/.test(e.message));
  }
  assert.throws(() => readRelay(join(DIR, "none.txt"), sha256Text(text), "reads"), /is not there/);
  assert.throws(() => readRelay(undefined, sha256Text(text), "reads"), /--reads-file <path> is required/);
});

test("F14: the lines plan.mjs next prints for G1's call tape, run through bash with the relay pasted, give the tool's output", async () => {
  const w = await newWalk("g19-relay-lines");
  try {
    await w.p0();
    const text = (await nextText(plan, w.run, w.results)).split("\n");
    const pane = text.findIndex((l) => l.startsWith("window.__t = reads.sessionTape("));
    assert.ok(pane > 0);
    assert.equal(text[pane + 1], "(await window.__t).relay_sha256");
    const write = text.findIndex((l) => l.includes("relay.mjs\" write"));
    assert.ok(write > pane + 1);
    const file = relayFile(w.run, "G1", "call-tape");
    assert.equal(text[write], `node "$LAB/research/2026-11-14-session-grant-devnet-test/relay.mjs" write "${file}" <<'RELAY_END'`);
    assert.equal(text[write + 1], "<the relay of window.__t>");
    assert.equal(text[write + 2], "RELAY_END");
    const cmd = text[write + 3];
    assert.match(cmd, new RegExp(`tool-run\\.mjs" G1 call --run "${w.run}" --tape-file "${file}" --tape-sha256 <the relay_sha256 the pane showed>$`));
    const t = await w.tape(w.node("A1", ["sessions", "nonces", "breakers"]));
    const script = [text[write], t.text, text[write + 2], cmd.replace("<the relay_sha256 the pane showed>", t.sha)].join("\n");
    const p = bash(script);
    assert.equal(p.status, 0, p.stderr);
    assert.ok(existsSync(join(w.run, "tool", "G1.call.json")));
    assert.equal(readFileSync(join(w.run, "tapes", "G1.call.json"), "utf8"), t.text, "the tape is kept byte for byte");
  } finally { w.done(); }
});

test("F14: no command takes a relay's text as an argument any more: --tape, --reads, --probe, --sent and --explorer are refused", () => {
  const node = (args) => spawnSync(process.execPath, args, { encoding: "utf8" });
  const cases = [
    [[join(HERE, "tool-run.mjs"), "R1", "call", "--run", DIR, "--tape", "{}", "--tape-sha256", "00"], /tool-run: --tape is not a flag here \(flags: --run, --tape-file, --tape-sha256\)/],
    [[join(HERE, "record-step.mjs"), "start", "--run", DIR, "--reads", "{}"], /--reads is not a flag here \(flags: --run, --reads-file, --reads-sha256, --probe-file, --probe-sha256\)/],
    [[join(HERE, "record-step.mjs"), "start", "--run", DIR, "--probe", "{}"], /--probe is not a flag here/],
    [[join(HERE, "record-step.mjs"), "step", "G1", "--run", DIR, "--sent", "{}"], /--sent is not a flag here \(flags: --run, --sent-file, --sent-sha256, --explorer-file, --explorer-sha256\)/],
    [[join(HERE, "record-step.mjs"), "step", "G1", "--run", DIR, "--explorer", "{}"], /--explorer is not a flag here/],
    [[join(HERE, "record-step.mjs"), "stop", "G1", "--run", DIR, "--reads", "{}"], /--reads is not a flag here \(flags: --run, --case, --why, --reads-file, --reads-sha256\)/],
  ];
  for (const [args, re] of cases) { const p = node(args); assert.equal(p.status, 2, args.join(" ")); assert.match(p.stderr, re); }
});
