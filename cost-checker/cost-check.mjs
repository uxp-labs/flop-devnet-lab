#!/usr/bin/env node
/**
 * FLOP free cost checker — no deps, no auth, no spend.
 * Uses GET /v1/models + POST /v1/models/estimate only.
 *
 * Usage:
 *   node cost-check.mjs --model <slug> --system <text> --user <text> --max-tokens <n> [--cap 0.25]
 *   node cost-check.mjs --model <slug> --prompt <text> --max-tokens <n> [--cap 0.25]
 *
 * Exit 0 on PASS (gateway estimate and local worst-case both <= cap), else 1.
 */
import { parseArgs } from "node:util";

const BASE = "https://api.flop.network/v1";
// Measured Nov 9: Qwen chat wrap for system "Be brief." + user "Hi" → 23 input vs 3 raw.
const QWEN_CHAT_OVERHEAD = 20;

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "qwen/qwen2.5-0.5b-instruct" },
    system: { type: "string", default: "" },
    user: { type: "string" },
    prompt: { type: "string" },
    "max-tokens": { type: "string", default: "8" },
    cap: { type: "string", default: "0.25" },
    help: { type: "boolean", default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(`Usage: node cost-check.mjs --model <slug> (--user <text> [--system <text>] | --prompt <text>) --max-tokens <n> [--cap 0.25]`);
  process.exit(0);
}

const model = values.model;
const maxTokens = Number(values["max-tokens"]);
const cap = Number(values.cap);
if (!Number.isFinite(maxTokens) || maxTokens < 1) {
  console.error("bad --max-tokens");
  process.exit(2);
}
if (!Number.isFinite(cap) || cap <= 0) {
  console.error("bad --cap");
  process.exit(2);
}

let prompt;
let mode;
if (values.prompt != null) {
  prompt = values.prompt;
  mode = "raw-prompt";
} else if (values.user != null) {
  const system = values.system || "";
  // Approximate Qwen chat template so estimate sees template tokens.
  prompt =
    `<|im_start|>system\n${system}<|im_end|>\n` +
    `<|im_start|>user\n${values.user}<|im_end|>\n` +
    `<|im_start|>assistant\n`;
  mode = "chat-template";
} else {
  console.error("need --user or --prompt");
  process.exit(2);
}

async function getJson(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      "user-agent": "flop-cost-checker/0",
      ...(init && init.headers),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${url}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function pricePerToken(modelRow) {
  const p = Number(modelRow?.pricing?.prompt);
  const c = Number(modelRow?.pricing?.completion);
  if (!Number.isFinite(p) || !Number.isFinite(c)) return null;
  // Catalog uses one price for both on current Qwen models; take max for worst case.
  return Math.max(p, c);
}

const models = await getJson(`${BASE}/models`);
const row = (models.data || []).find((m) => m.id === model);
if (!row) {
  console.error(`model not in catalog: ${model}`);
  console.error(
    "available:",
    (models.data || []).map((m) => m.id).join(", ") || "(none)",
  );
  process.exit(2);
}
const ppt = pricePerToken(row);
if (ppt == null) {
  console.error("could not parse pricing.prompt/completion");
  process.exit(2);
}

const estimate = await getJson(`${BASE}/models/estimate`, {
  method: "POST",
  body: JSON.stringify({ model, prompt, max_tokens: maxTokens }),
});

const estIn = Number(estimate.estimated_input_tokens);
const estOut = Number(estimate.estimated_output_tokens);
const estCost = Number(estimate.estimated_cost_flop);

// Local worst case: estimated input (already template-shaped when --user) + max_tokens,
// priced from catalog. Also show a padded local when mode is raw-prompt.
const localIn =
  mode === "raw-prompt" ? estIn + QWEN_CHAT_OVERHEAD : estIn;
const localOut = maxTokens;
const localCost = (localIn + localOut) * ppt;

const gatewayPass = Number.isFinite(estCost) && estCost <= cap;
const localPass = Number.isFinite(localCost) && localCost <= cap;
const pass = gatewayPass && localPass;

// Largest max_tokens that fits under cap given measured/padded input.
const inputForFit = mode === "raw-prompt" ? estIn + QWEN_CHAT_OVERHEAD : estIn;
const room = cap / ppt - inputForFit;
const largestMaxTokens = Math.max(0, Math.floor(room + 1e-12));

const lines = [
  `model=${model}`,
  `mode=${mode}`,
  `cap=${cap}`,
  `price_per_token=${ppt}`,
  `gateway_estimate: input=${estIn} output=${estOut} cost=${round6(estCost)}`,
  `local_worst_case: input=${localIn} output=${localOut} cost=${round6(localCost)}` +
    (mode === "raw-prompt"
      ? ` (raw input ${estIn} + template pad ${QWEN_CHAT_OVERHEAD})`
      : ""),
  `largest_max_tokens_under_cap=${largestMaxTokens}`,
  `gateway=${gatewayPass ? "PASS" : "FAIL"} local=${localPass ? "PASS" : "FAIL"} → ${pass ? "PASS" : "FAIL"}`,
];
console.log(lines.join("\n"));
process.exit(pass ? 0 : 1);

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}
