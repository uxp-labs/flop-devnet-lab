#!/usr/bin/env node
// Harness canary: proves the read-only harness itself bites.
// In a temp copy of the package, throwaway tests each leave one forbidden attempt in the log:
// a fetch, an https request, a net connection, a child process, a refused author_submitExtrinsic,
// a refused signature and a refused spend. Each must make vitest fail with the
// "unexpected ... attempts" error from test/setup.ts. If any passes, the harness is broken.
// Hosts end in .invalid and the process is `true`, so even a broken harness reaches nothing.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skip = new Set(["node_modules", "check-runs", "dist", "out"]);

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
  "zz-canary-write.test.ts": leave(`import { guardRpc } from "../src/guard.js";`, `guardRpc("author_submitExtrinsic")`),
  "zz-canary-sign.test.ts": leave(`import { refuseSigning } from "../src/guard.js";`, `refuseSigning("escrow open")`),
  "zz-canary-spend.test.ts": leave(`import { refuseSpend } from "../src/guard.js";`, `refuseSpend("0.001 FLOP")`),
};
// The control leaves nothing behind and must pass in the same kind of copy, so a caught canary
// cannot be explained by a broken copy.
const CONTROL = "zz-canary-control.test.ts";
canaries[CONTROL] = `import { expect, it } from "vitest";
it("leaves nothing in the log", () => {
  expect(1 + 1).toBe(2);
});
`;

const results = [];
let bad = 0;
for (const [name, body] of Object.entries(canaries)) {
  const tmp = mkdtempSync(join(tmpdir(), "obs-canary-"));
  cpSync(pkg, tmp, { recursive: true, filter: (p) => !relative(pkg, p).split("/").some((x) => skip.has(x) || x.startsWith(".build-")) });
  symlinkSync(join(pkg, "node_modules"), join(tmp, "node_modules"));
  writeFileSync(join(tmp, "test", name), body);
  const r = spawnSync("npx", ["vitest", "run", `test/${name}`], {
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
  const caught = r.status !== 0 && /unexpected network, write, sign or spend attempts/.test(out);
  if (!caught) bad++;
  results.push({ canary: name, exit: r.status, outcome: caught ? "harness-caught-it" : "harness-missed-it" });
}
console.log(JSON.stringify(results, null, 2));
process.exit(bad ? 1 : 0);
