// Reading a file the observatory was handed: a saved reading, a scenario's meta.json, a page file,
// the snapshot log, a drift spec or the snapshot the MCP binary serves.
//
// Each is opened without waiting and read only when it is a regular file. A named pipe, a device
// or a folder at that path is refused with a reason, so the command answers instead of blocking
// for ever on a pipe no one writes to (third IMD audit J4, RULES.md 1.1 and section 5).
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

/** A path that holds something other than a regular file. */
export class NotARegularFile extends Error {
  constructor() {
    super("not a regular file");
  }
}

/** The bytes of the regular file at path. Throws NotARegularFile for anything else, and the system's error when it cannot be opened. */
export function readRegularFile(path: string): Buffer {
  // Without O_NONBLOCK, opening a named pipe for reading waits for a writer. A regular file reads
  // the same either way. The flag is absent on Windows, which has no such pipes on a path.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new NotARegularFile();
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
