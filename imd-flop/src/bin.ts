#!/usr/bin/env node
import { main } from "./cli.js";

const code = await main(process.argv.slice(2), {
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
  env: process.env,
});
process.exitCode = code;
