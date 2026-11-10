// Copies of the files git tracks, and nothing else.
//
// The mutation runner and the harness canary each run tests in a temp copy. Copying a whole
// folder would also copy untracked files, a stray test file say, which can change what passes or
// what kills a mutant, and an unreadable untracked file would stop the copy. So the copy holds
// exactly the paths `git ls-files` names, with their working tree contents (an uncommitted edit
// shows up in dirty.txt), and symbolic links are kept as links.
import { spawnSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

/** A copy that could not be made. Callers report it as a setup failure, never as a result. */
export class SetupFailed extends Error {
  constructor(message) {
    super(message);
    this.name = "SetupFailed";
  }
}

/** Paths git tracks under `dir`, relative to `dir`, sorted. */
export function trackedFiles(dir) {
  const r = spawnSync("git", ["-C", dir, "ls-files", "-z", "--cached"], { encoding: "buffer" });
  if (r.error || r.status !== 0) {
    const why = r.error ? r.error.message : (r.stderr ?? Buffer.alloc(0)).toString("utf8").trim();
    throw new SetupFailed(`git ls-files failed in ${dir}: ${why || `exit ${String(r.status)}`}`);
  }
  return [...new Set(r.stdout.toString("utf8").split("\0").filter(Boolean))].sort();
}

/**
 * Copies every tracked path under `src` to the same place under `dest`. A tracked path missing
 * from the working tree is left out and listed in `missing`. Throws SetupFailed on any other error.
 */
export function copyTracked(src, dest) {
  const files = trackedFiles(src);
  const missing = [];
  for (const rel of files) {
    const from = join(src, rel);
    const to = join(dest, rel);
    let st;
    try {
      st = lstatSync(from);
    } catch (e) {
      if (e && e.code === "ENOENT") {
        missing.push(rel);
        continue;
      }
      throw new SetupFailed(`cannot read ${rel}: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      mkdirSync(dirname(to), { recursive: true });
      if (st.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
      else if (st.isFile()) copyFileSync(from, to);
      else throw new Error("not a file or a symbolic link");
    } catch (e) {
      throw new SetupFailed(`cannot copy ${rel}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const layout = [...new Set(files.map((f) => f.split("/")[0]))].sort();
  return { tracked: files.length, copied: files.length - missing.length, missing, layout };
}
