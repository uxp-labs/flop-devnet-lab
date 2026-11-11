import { resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { formatUnits, isAddress, parseGwei, parseUnits, type Address } from "viem";
import { signApprove } from "./allowance.js";
import { quoteApproval, signQuoteApproval } from "./approval.js";
import { parseChallenge } from "./challenge.js";
import { EXIT, HireError, refused, usage } from "./errors.js";
import { hasRequest, hasResponse, needOrder, readJobRequest, readOrder, readResponse, writeNewOrder, writeRequest, writeSigned } from "./jobdir.js";
import { DEFAULT_API, IMD_DECIMALS, imdPayTo, imdToken, LARGEST_PRICE } from "./networks.js";
import { paymentHash, PERMIT2_PROXY, signPayment } from "./payment.js";
import { checkChallenge, type Policy } from "./policy.js";
import { challengeRequest, orderRequest, quoteRequest, submitRequest } from "./requests.js";
import { createKeyFile, loadAccount } from "./wallet.js";

export interface IO {
  out: (line: string) => void;
  err: (line: string) => void;
}

const HELP = `imd-hire: offline signer for hiring the IMD swarm. It never touches the network.
It writes each HTTP request to a file. Send the file with any HTTP client and save the answer
beside it as {status, body}. Then run the next step.

  wallet new --key <file>                 make a key file (owner only, never overwritten); prints the address
  wallet address --key <file>             print the address

  quote --dir <job> [--api <origin>] [--new]
                                          write 1-quote.request.json from <job>/request.json ({action, input})
  challenge --dir <job>                   read 1-quote.response.json, write 2-challenge.request.json
  pay --dir <job> --key <file> --max-imd <amount> [--chain <id>] [--pay-to <address>]
                                          read 2-challenge.response.json, check it against the request, the
                                          maximum and IMD's recipient, sign the payment and the quote approval,
                                          write 3-submit.request.json. One payment per folder.
  order --dir <job>                       write 4-order.request.json (reads the order; never charges)

  approve --key <file> --allowance-imd <amount> --nonce <n> --gas <n> --max-fee-gwei <n> --priority-fee-gwei <n>
          [--chain <id>] [--max-cost-eth <amount>]
                                          sign (do not send) the one approval that lets Permit2 move up to
                                          <amount> IMD; prints the raw transaction

Exit codes: 0 ok, 1 error, 2 usage or a missing file, 3 refused (nothing signed).`;

const str = { type: "string" } as const;
const flag = { type: "boolean" } as const;

function need(value: string | undefined, name: string): string {
  if (value === undefined || value === "") throw usage(`--${name} is required`);
  return value;
}

function wholeNumber(value: string, name: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw usage(`--${name} must be a whole number, got ${value}`);
  return BigInt(value);
}

function decimal(value: string, name: string, units: (v: string) => bigint): bigint {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) throw usage(`--${name} must be a plain decimal number, got ${value}`);
  return units(value);
}

function chainOf(value: string | undefined): number {
  const chainId = Number(wholeNumber(value ?? "1", "chain"));
  try {
    imdToken(chainId);
  } catch (e) {
    throw usage(`--chain: ${(e as Error).message}`);
  }
  return chainId;
}

const imd = (atomic: bigint | string): string => `${formatUnits(BigInt(atomic), IMD_DECIMALS)} IMD`;

async function run(argv: string[], io: IO): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "help":
    case "--help":
      io.out(HELP);
      return EXIT.OK;

    case "wallet": {
      const [sub, ...args] = rest;
      const { values } = parseArgs({ args, options: { key: str } });
      const key = need(values.key, "key");
      if (sub === "new") io.out(`address ${createKeyFile(key).address}\nkey     ${key} (owner only, never printed)`);
      else if (sub === "address") io.out(`address ${loadAccount(key).address}`);
      else throw usage("wallet new | wallet address");
      return EXIT.OK;
    }

    case "quote": {
      const { values } = parseArgs({ args: rest, options: { dir: str, api: str, new: flag } });
      const dir = need(values.dir, "dir");
      const request = readJobRequest(dir);
      let order = readOrder(dir);
      if (order && values.new) {
        if (hasRequest(dir, "3-submit")) throw refused(["a payment was already signed in this folder; use a new folder for a new order"]);
        order = null;
      }
      if (order && values.api && values.api !== order.api) throw usage(`this order was made for ${order.api}; pass --new to start one for ${values.api}`);
      const reused = order !== null;
      order ??= writeNewOrder(dir, (values.api ?? DEFAULT_API).replace(/\/+$/, ""));
      const path = writeRequest(dir, "1-quote", quoteRequest(order.api, order.token, order.requestKey, request.action, request.input));
      io.out(`${reused ? "same order as before" : "new order"}: requestKey ${order.requestKey}`);
      io.out(`wrote ${path}\nsend it, then save the answer as 1-quote.response.json`);
      return EXIT.OK;
    }

    case "challenge": {
      const { values } = parseArgs({ args: rest, options: { dir: str } });
      const dir = need(values.dir, "dir");
      const order = needOrder(dir);
      const orderId = quotedOrderId(dir, order.requestKey);
      const path = writeRequest(dir, "2-challenge", challengeRequest(order.api, order.token, orderId));
      io.out(`order ${orderId}\nwrote ${path}\nsend it (the answer is a 402), then save the answer as 2-challenge.response.json`);
      return EXIT.OK;
    }

    case "pay": {
      const { values } = parseArgs({ args: rest, options: { dir: str, key: str, "max-imd": str, chain: str, "pay-to": str } });
      const dir = need(values.dir, "dir");
      const keyPath = need(values.key, "key");
      // The job folder goes to whoever sends the requests. The key must not travel with it.
      if (resolve(keyPath).startsWith(resolve(dir) + sep)) throw usage("the key file is inside the job folder; keep it outside, the folder is handed to the sender");
      const maxAmount = decimal(need(values["max-imd"], "max-imd"), "max-imd", (v) => parseUnits(v, IMD_DECIMALS));
      if (maxAmount > LARGEST_PRICE) throw usage(`--max-imd is in IMD, not atomic units, and at most ${imd(LARGEST_PRICE)}; a request costs 0.5 IMD`);
      const chainId = chainOf(values.chain);
      const payTo = recipientOf(values["pay-to"], chainId);
      const request = readJobRequest(dir);
      const order = needOrder(dir);
      const orderId = quotedOrderId(dir, order.requestKey);

      const answer = readResponse(dir, "2-challenge");
      if (answer.status !== 402) throw usage(`2-challenge.response.json has status ${answer.status}; the challenge is a 402`);
      const ch = parseChallenge(answer.body);
      if (ch.quote.id !== orderId) throw refused([`the challenge is for order ${ch.quote.id}, not the quoted order ${orderId}`]);
      // One folder, one payment, whatever order the saved answers now name.
      if (hasRequest(dir, "3-submit")) throw refused(["a payment is already signed in this folder (3-submit.request.json); send that file again, it is safe to resend. For another order, use a new folder"]);

      const policy: Policy = { api: order.api, chainId, token: imdToken(chainId), payTo, maxAmount, action: request.action, input: request.input };
      const reasons = checkChallenge(ch, policy, Math.floor(Date.now() / 1000));
      if (reasons.length > 0) throw refused(reasons);

      const account = loadAccount(keyPath);
      const payment = await signPayment(ch, account, { token: policy.token, maxAmount: policy.maxAmount });
      const quoteSignature = await signQuoteApproval(ch, payment, account);
      const auth = payment.payload.permit2Authorization;
      const path = writeRequest(dir, "3-submit", submitRequest(order.api, order.token, orderId, payment, quoteSignature));
      writeSigned(dir, {
        v: 0,
        signedAt: new Date().toISOString(),
        payer: account.address,
        orderId,
        action: ch.quote.action,
        network: ch.accepted.network,
        asset: ch.accepted.asset,
        amount: ch.accepted.amount,
        payTo: ch.accepted.payTo,
        spender: PERMIT2_PROXY,
        permit2Nonce: auth.nonce,
        paymentDeadline: Number(auth.deadline),
        quoteExpiresAt: ch.quote.expiresAt,
        quoteHash: `0x${ch.quote.quoteHash}`,
        paymentHash: paymentHash(payment),
        quoteApproval: { ...quoteApproval(ch, payment).message, amount: ch.quote.payment.amount, expiresAt: ch.quote.expiresAt },
        quoteSignature,
      });
      io.out(`signed for order ${orderId}`);
      io.out(`  pays    ${imd(ch.accepted.amount)} (maximum approved ${imd(maxAmount)})`);
      io.out(`  from    ${account.address}`);
      io.out(`  to      ${ch.accepted.payTo} on ${ch.accepted.network}`);
      io.out(`  for     ${ch.quote.action}`);
      io.out(`  window  closes ${new Date(Number(auth.deadline) * 1000).toISOString()}, quote expires ${new Date(ch.quote.expiresAt * 1000).toISOString()}`);
      io.out(`wrote ${path}\nsend it now, then save the answer as 3-submit.response.json`);
      return EXIT.OK;
    }

    case "order": {
      const { values } = parseArgs({ args: rest, options: { dir: str } });
      const dir = need(values.dir, "dir");
      const order = needOrder(dir);
      const orderId = quotedOrderId(dir, order.requestKey);
      const path = writeRequest(dir, "4-order", orderRequest(order.api, order.token, orderId));
      io.out(`wrote ${path}\nsend it, then save the answer as 4-order.response.json`);
      return EXIT.OK;
    }

    case "approve": {
      const { values } = parseArgs({
        args: rest,
        options: { key: str, "allowance-imd": str, nonce: str, gas: str, "max-fee-gwei": str, "priority-fee-gwei": str, chain: str, "max-cost-eth": str },
      });
      const chainId = chainOf(values.chain);
      const params = {
        chainId,
        token: imdToken(chainId),
        amount: decimal(need(values["allowance-imd"], "allowance-imd"), "allowance-imd", (v) => parseUnits(v, IMD_DECIMALS)),
        nonce: Number(wholeNumber(need(values.nonce, "nonce"), "nonce")),
        gas: wholeNumber(need(values.gas, "gas"), "gas"),
        maxFeePerGas: decimal(need(values["max-fee-gwei"], "max-fee-gwei"), "max-fee-gwei", parseGwei),
        maxPriorityFeePerGas: decimal(need(values["priority-fee-gwei"], "priority-fee-gwei"), "priority-fee-gwei", parseGwei),
        maxCost: decimal(values["max-cost-eth"] ?? "0.001", "max-cost-eth", (v) => parseUnits(v, 18)),
      };
      const signed = await signApprove(loadAccount(need(values.key, "key")), params);
      io.out(JSON.stringify({ ...signed, allowance: imd(signed.amount), maxCostEth: formatUnits(BigInt(signed.maxCostWei), 18), sent: false }, null, 2));
      return EXIT.OK;
    }

    default:
      throw usage(`unknown command ${command}; run \`imd-hire help\``);
  }
}

/** The recipient the owner pays: the one named with --pay-to, else the one pinned for the chain. */
function recipientOf(value: string | undefined, chainId: number): Address {
  if (value !== undefined) {
    if (!isAddress(value)) throw usage("--pay-to must be an address");
    return value;
  }
  const pinned = imdPayTo(chainId);
  if (!pinned) throw usage(`no IMD recipient is pinned for chain ${chainId}; pass --pay-to with the payTo that GET /requests/capabilities publishes`);
  return pinned;
}

/** The order id from the saved quote answer, which must be the answer to this order's requestKey. */
function quotedOrderId(dir: string, requestKey: string): string {
  if (!hasResponse(dir, "1-quote")) throw usage("1-quote.response.json is missing; send 1-quote.request.json and save the answer first");
  const { status, body } = readResponse(dir, "1-quote");
  if (status !== 200 && status !== 201) throw usage(`the quote was not accepted: 1-quote.response.json has status ${status}`);
  const order = (body as { order?: { id?: unknown; requestKey?: unknown } } | null)?.order;
  if (!order || typeof order.id !== "string" || order.id.length === 0) throw usage("1-quote.response.json holds no order id");
  if (order.requestKey !== requestKey) throw refused(["1-quote.response.json answers a different requestKey than this order's; it is a stale answer"]);
  return order.id;
}

export async function main(argv: string[], io: IO): Promise<number> {
  try {
    return await run(argv, io);
  } catch (e) {
    if (e instanceof HireError) {
      io.err(`imd-hire: ${e.message}`);
      return e.code;
    }
    const error = e as Error & { code?: string };
    if (error.code?.startsWith("ERR_PARSE_ARGS")) {
      io.err(`imd-hire: ${error.message}`);
      return EXIT.USAGE;
    }
    io.err(`imd-hire: unexpected error: ${error.message}`);
    return EXIT.ERROR;
  }
}
