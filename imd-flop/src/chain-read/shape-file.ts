/**
 * The one file of imd-flop that reads a shape file of the observatory (P2, rule A4). It finds the file through the
 * package, flop-observatory/shapes/<name>.json, never by a relative path into ../observatory. Not pure: it reads a
 * file. A name that is not a shape file's, and a file that cannot be found or read, are unknown. The door bounds the
 * text it takes (its MAX_INPUT_BYTES) and refuses any text that is not the reviewed file, by its sha256.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { type Got, known, unknown } from "./result.js";
import { freezeFunction } from "../freeze.js";

/** A shape file's path in the observatory package, as the reviewed line names it. */
const SHAPE_FILE = /^shapes\/[a-z0-9][a-z0-9.-]*\.json$/;

const require = createRequire(import.meta.url);

/** The text of the shape file a reviewed line names (Runtime.shapeFile). */
export function shapeFileText(shapeFile: string): Got<string> {
  if (!SHAPE_FILE.test(shapeFile)) return unknown(`${JSON.stringify(shapeFile.slice(0, 80))} is not the name of a shape file`);
  let path: string;
  try {
    path = require.resolve(`flop-observatory/${shapeFile}`);
  } catch {
    return unknown(`the package flop-observatory holds no ${shapeFile}`);
  }
  try {
    return known(readFileSync(path, "utf8"));
  } catch {
    return unknown(`${shapeFile} could not be read`);
  }
}
freezeFunction(shapeFileText);
