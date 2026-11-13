#!/usr/bin/env node
// Writes or compares a reviewed shape file (shapes/<spec name>-<spec version>.json): the reviewed
// line of that spec version, its metadata found on the third recording's tape by the line's
// metadata sha256, deriveShape over it and shapeText, through the one function the tests use
// (writeShapeMain in test/helpers/shape-file.ts). The only step that writes a shape file. It reads
// no network.
//
//   node scripts/write-shape.mjs --spec 1014020            compare: exit 0 same bytes, 1 not
//   node scripts/write-shape.mjs --spec 1014020 --write    write the file
//
// scripts/cli-checks.mjs runs the compare for each reviewed line.
import { register } from "node:module";

// Node's own type stripping runs the tests' TypeScript helpers: Node 22.18 and later, as
// package.json's engines says. On an older Node this says so in one line of its own, and exits 1.
const [major, minor] = process.versions.node.split(".").map(Number);
if (!(major > 22 || (major === 22 && minor >= 18)) || !process.features.typescript) {
  process.stderr.write(`write-shape needs Node 22.18 or later, with type stripping; this is Node ${process.versions.node}\n`);
  process.exit(1);
}

register(new URL("./ts-resolve.mjs", import.meta.url));
const { writeShapeMain } = await import("../test/helpers/shape-file.ts");
const r = writeShapeMain(process.argv.slice(2));
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
process.exitCode = r.code;
