#!/usr/bin/env node
// Harness canary: proves the read-only harness itself bites.
// In a temp copy of the package's tracked files, throwaway tests each leave one forbidden attempt
// in the log: a fetch, an https request, a net connection, a child process, module hooks, a
// listening handle made under listen, a dgram socket made directly, a refused
// author_submitExtrinsic, a refused signature and a refused spend. Each must make vitest fail
// with the "unexpected ... attempts" error from test/setup.ts. Two more make their attempt from a
// timer that fires after the file's final check (one also resets the log there); each must fail
// the run from the journal check in test/global-setup.ts, and must prove its timer really fired.
// The late timer runs once more with that journal check taken out of vitest.config.ts, where it
// must pass: so the journal check, and nothing else, is what catches it.
// If any canary passes, the harness is broken.
// Hosts end in .invalid and the process is `true`, so even a broken harness reaches nothing.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyTracked } from "./tracked.mjs";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LATE_MARK = "LATE CANARY CALLBACK RAN";

const leave = (imports, call) => `import { expect, it } from "vitest";
${imports}
it("leaves one forbidden attempt in the log", () => {
  expect(() => ${call}).toThrow();
});
`;
const canaries = {
  "zz-canary-fetch.test.ts": leave("", `fetch("https://canary.invalid/fund")`),
  "zz-canary-https.test.ts": leave(`import https from "node:https";`, `https.request("https://canary.invalid/fund")`),
  "zz-canary-net.test.ts": leave(`import { connect } from "node:net";`, `connect(9, "canary.invalid")`),
  "zz-canary-process.test.ts": leave(`import { execFileSync } from "node:child_process";`, `execFileSync("true")`),
  // Third IMD audit J1 and J2. An empty hook module and an address that resolves nowhere, so even a
  // broken harness starts no hook code and opens nothing that reaches anything.
  "zz-canary-module-hooks.test.ts": leave(`import { register } from "node:module";`, `register("data:text/javascript,")`),
  "zz-canary-listen2.test.ts": leave(`import { Server } from "node:net";`, `(new Server() as unknown as { _listen2: (...a: unknown[]) => unknown })._listen2("canary.invalid", 0, 4, -1, false)`),
  "zz-canary-dgram-socket.test.ts": leave(`import { Socket } from "node:dgram";`, `new Socket({ type: "udp4" })`),
  "zz-canary-write.test.ts": leave(`import { guardRpc } from "../src/guard.js";`, `guardRpc("author_submitExtrinsic")`),
  "zz-canary-sign.test.ts": leave(`import { refuseSigning } from "../src/guard.js";`, `refuseSigning("escrow open")`),
  "zz-canary-spend.test.ts": leave(`import { refuseSpend } from "../src/guard.js";`, `refuseSpend("0.001 FLOP")`),
};
// An attempt after the file's final check: the file's own afterAll runs before the one in
// test/setup.ts, so a timer it sets fires once every hook is done, out of reach of any afterAll.
const late = (schedule, extra) => `import { afterAll, expect, it } from "vitest";
import { resetAttempts } from "../src/guard.js";
it("passes", () => {
  expect(1).toBe(1);
});
afterAll(() => {
  ${schedule}(() => {
    try {
      fetch("https://canary.invalid/fund");
    } catch {
      // swallowed on purpose: only the journal can still see this attempt
    }
    ${extra}
    process.stderr.write("${LATE_MARK}\\n");
  }${schedule === "setTimeout" ? ", 0" : ""});
});
`;
const LATE = new Set(["zz-canary-late-timer.test.ts", "zz-canary-late-reset.test.ts"]);
canaries["zz-canary-late-timer.test.ts"] = late("setTimeout", "");
canaries["zz-canary-late-reset.test.ts"] = late("setImmediate", "resetAttempts();");

// The control leaves nothing behind and must pass in the same kind of copy, so a caught canary
// cannot be explained by a broken copy.
const CONTROL = "zz-canary-control.test.ts";
canaries[CONTROL] = `import { expect, it } from "vitest";
it("leaves nothing in the log", () => {
  expect(1 + 1).toBe(2);
});
`;

const WITHOUT_CHECK = "zz-canary-late-timer.test.ts, journal check taken out";
canaries[WITHOUT_CHECK] = canaries["zz-canary-late-timer.test.ts"];
const GLOBAL_SETUP = '    globalSetup: ["test/global-setup.ts"],\n';

const results = [];
let bad = 0;
for (const [label, body] of Object.entries(canaries)) {
  const name = label === WITHOUT_CHECK ? "zz-canary-late-timer.test.ts" : label;
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "obs-canary-")));
  try {
    copyTracked(pkg, tmp);
    symlinkSync(join(pkg, "node_modules"), join(tmp, "node_modules"));
    if (label === WITHOUT_CHECK) {
      const config = join(tmp, "vitest.config.ts");
      const text = readFileSync(config, "utf8");
      if (text.split(GLOBAL_SETUP).length !== 2) throw new Error("vitest.config.ts does not hold the globalSetup line exactly once");
      writeFileSync(config, text.replace(GLOBAL_SETUP, ""));
    }
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    bad++;
    results.push({ canary: label, outcome: "setup-failed", detail: e instanceof Error ? e.message : String(e) });
    continue;
  }
  writeFileSync(join(tmp, "test", name), body);
  const r = spawnSync("npx", ["--no-install", "vitest", "run", `test/${name}`], {
    cwd: tmp,
    encoding: "utf8",
    env: { ...process.env, OBS_ATTEMPTS_FILE: "" },
  });
  rmSync(tmp, { recursive: true, force: true });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  if (name === CONTROL) {
    const pass = r.status === 0;
    if (!pass) bad++;
    results.push({ canary: name, exit: r.status, outcome: pass ? "control-pass" : "control-fail" });
    continue;
  }
  if (label === WITHOUT_CHECK) {
    const fired = out.includes(LATE_MARK);
    const outcome = !fired ? "late-callback-never-ran" : r.status === 0 ? "missed-without-the-journal-check" : "failed-for-another-reason";
    if (outcome !== "missed-without-the-journal-check") bad++;
    results.push({ canary: label, exit: r.status, outcome });
    continue;
  }
  if (LATE.has(name)) {
    // The late attempt must really have happened, and the journal check must be what caught it.
    const fired = out.includes(LATE_MARK);
    const caught = r.status !== 0 && /unexpected network, write, sign or spend attempts after the last check/.test(out);
    const outcome = !fired ? "late-callback-never-ran" : caught ? "harness-caught-it" : "harness-missed-it";
    if (outcome !== "harness-caught-it") bad++;
    results.push({ canary: name, exit: r.status, outcome });
    continue;
  }
  const caught = r.status !== 0 && /unexpected network, write, sign or spend attempts/.test(out);
  if (!caught) bad++;
  results.push({ canary: name, exit: r.status, outcome: caught ? "harness-caught-it" : "harness-missed-it" });
}
console.log(JSON.stringify(results, null, 2));
// exitCode, not exit(): a caller may read this report through a pipe, where a write is
// asynchronous and exit() could cut it short (round 9 review L7).
process.exitCode = bad ? 1 : 0;
