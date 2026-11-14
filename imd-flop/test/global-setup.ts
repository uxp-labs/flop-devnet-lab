// Builds the package once per test run, before any worker starts. No test builds or writes dist/.
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export default function setup(): void {
  const root = join(import.meta.dirname, "..");
  try {
    execFileSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], { cwd: root, encoding: "utf8", stdio: "pipe" });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    const output = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
    throw new Error(`the package build failed:\n${output || err.message}`);
  }
}
