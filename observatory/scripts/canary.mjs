#!/usr/bin/env node
// Harness canary: proves the read-only harness itself bites.
// In a temp copy of the package, two throwaway tests each leave one forbidden attempt in the
// log (a fetch, and a refused author_submitExtrinsic). Each must make vitest fail with the
// "unexpected ... attempts" error from test/setup.ts. If either passes, the harness is broken.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skip = new Set(["node_modules", "check-runs", "dist", "out"]);

const canaries = {
  "zz-canary-fetch.test.ts": `import { expect, it } from "vitest";
it("leaves a fetch attempt in the log", () => {
  expect(() => fetch("https://faucet.flop.network/fund")).toThrow();
});
`,
  "zz-canary-write.test.ts": `import { expect, it } from "vitest";
import { guardRpc } from "../src/guard.js";
it("leaves a refused extrinsic in the log", () => {
  expect(() => guardRpc("author_submitExtrinsic")).toThrow();
});
`,
};

const results = [];
let bad = 0;
for (const [name, body] of Object.entries(canaries)) {
  const tmp = mkdtempSync(join(tmpdir(), "obs-canary-"));
  cpSync(pkg, tmp, { recursive: true, filter: (p) => !relative(pkg, p).split("/").some((x) => skip.has(x)) });
  symlinkSync(join(pkg, "node_modules"), join(tmp, "node_modules"));
  writeFileSync(join(tmp, "test", name), body);
  const r = spawnSync("npx", ["vitest", "run", `test/${name}`], {
    cwd: tmp,
    encoding: "utf8",
    env: { ...process.env, OBS_ATTEMPTS_FILE: "" },
  });
  rmSync(tmp, { recursive: true, force: true });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const caught = r.status !== 0 && /unexpected network, write, sign or spend attempts/.test(out);
  if (!caught) bad++;
  results.push({ canary: name, exit: r.status, outcome: caught ? "harness-caught-it" : "harness-missed-it" });
}
console.log(JSON.stringify(results, null, 2));
process.exit(bad ? 1 : 0);
