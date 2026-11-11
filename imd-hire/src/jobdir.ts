/**
 * One job, one folder. This is the only module besides wallet.ts that touches the disk. The folder
 * holds the request, the order's token, each HTTP request this tool writes, and each answer the
 * sender saves beside it:
 *
 *   request.json               {action, input}: what to ask IMD for. Written by a person.
 *   order.json                 the request token and requestKey for this order
 *   1-quote.request.json       sent as is            1-quote.response.json       {status, body}
 *   2-challenge.request.json                         2-challenge.response.json
 *   3-submit.request.json                            3-submit.response.json
 *   4-order.request.json                             4-order.response.json
 *   signed.json                what was signed, for the record
 *
 * Every file is owner only: the request files carry the order's bearer token.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { usage } from "./errors.js";
import type { HttpRequest } from "./requests.js";

export type Step = "1-quote" | "2-challenge" | "3-submit" | "4-order";

export interface JobRequest {
  action: string;
  input: Record<string, unknown>;
}

export interface Order {
  v: 0;
  api: string;
  token: string; // 32 random bytes, hex: the bearer for this order's quote, submit and status routes
  requestKey: string; // lower case UUID
  createdAt: string;
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function readJson(path: string, what: string): unknown {
  if (!existsSync(path)) throw usage(`${what} is missing: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw usage(`${what} is not JSON: ${path}`);
  }
}

/** Writes owner only, and never through a link: a link in the folder could point the write anywhere. */
function writeJson(path: string, value: unknown): void {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw usage(`${path} is a link; this tool does not write through links`);
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

export const requestFile = (dir: string, step: Step) => join(dir, `${step}.request.json`);
export const responseFile = (dir: string, step: Step) => join(dir, `${step}.response.json`);
export const hasRequest = (dir: string, step: Step) => existsSync(requestFile(dir, step));
export const hasResponse = (dir: string, step: Step) => existsSync(responseFile(dir, step));

export function readJobRequest(dir: string): JobRequest {
  const v = readJson(join(dir, "request.json"), "the job's request.json");
  if (!isObject(v) || typeof v.action !== "string" || v.action.length === 0 || !isObject(v.input)) throw usage("request.json must be {action, input} with input an object");
  return { action: v.action, input: v.input };
}

export function readOrder(dir: string): Order | null {
  const path = join(dir, "order.json");
  if (!existsSync(path)) return null;
  const v = readJson(path, "order.json");
  if (!isObject(v) || v.v !== 0 || typeof v.api !== "string" || typeof v.token !== "string" || !/^[0-9a-f]{64}$/.test(v.token) || typeof v.requestKey !== "string") throw usage("order.json is not a v0 order file");
  return v as unknown as Order;
}

export function needOrder(dir: string): Order {
  const order = readOrder(dir);
  if (!order) throw usage(`no order yet in ${dir}; run \`imd-hire quote --dir ${dir}\` first`);
  return order;
}

/** A new order: a fresh token and requestKey. Asking again with a new key is how an expired quote is replaced. */
export function writeNewOrder(dir: string, api: string): Order {
  const order: Order = { v: 0, api, token: randomBytes(32).toString("hex"), requestKey: randomUUID().toLowerCase(), createdAt: new Date().toISOString() };
  writeJson(join(dir, "order.json"), order);
  return order;
}

export function writeRequest(dir: string, step: Step, request: HttpRequest): string {
  const path = requestFile(dir, step);
  writeJson(path, request);
  return path;
}

export function readResponse(dir: string, step: Step): HttpResponse {
  const v = readJson(responseFile(dir, step), `the saved answer ${step}.response.json`);
  if (!isObject(v) || typeof v.status !== "number" || !("body" in v)) throw usage(`${step}.response.json must be {status, body}`);
  return { status: v.status, body: v.body };
}

export function writeSigned(dir: string, record: unknown): string {
  const path = join(dir, "signed.json");
  writeJson(path, record);
  return path;
}
