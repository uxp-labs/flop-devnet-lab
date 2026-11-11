/**
 * The four HTTP requests of IMD's paid flow, as plain data. This package never sends them: whoever
 * has network access does, with any HTTP client, and saves the answer for the next step.
 */
import type { Hex } from "viem";
import { paymentHeader, type Payment } from "./payment.js";

export interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const JSON_BODY = { "Content-Type": "application/json" };

/** 1. Ask for a quote. Free. The same requestKey and input give the same quote back. */
export function quoteRequest(api: string, token: string, requestKey: string, action: string, input: unknown): HttpRequest {
  return { method: "POST", url: `${api}/requests/quote`, headers: { ...bearer(token), ...JSON_BODY }, body: JSON.stringify({ requestKey, action, input }) };
}

/** 2. Ask for the payment challenge: submit with no body answers 402. Free. */
export function challengeRequest(api: string, token: string, orderId: string): HttpRequest {
  return { method: "POST", url: `${api}/requests/${encodeURIComponent(orderId)}/submit`, headers: bearer(token), body: null };
}

/** 3. Pay: the payment in the PAYMENT-SIGNATURE header and the quote approval in the body. Sending the same bytes again is safe. */
export function submitRequest(api: string, token: string, orderId: string, payment: Payment, quoteSignature: Hex): HttpRequest {
  return {
    method: "POST",
    url: `${api}/requests/${encodeURIComponent(orderId)}/submit`,
    headers: { ...bearer(token), ...JSON_BODY, "PAYMENT-SIGNATURE": paymentHeader(payment) },
    body: JSON.stringify({ quoteSignature }),
  };
}

/** 4. Read the order. Never charges. */
export function orderRequest(api: string, token: string, orderId: string): HttpRequest {
  return { method: "GET", url: `${api}/requests/${encodeURIComponent(orderId)}`, headers: bearer(token), body: null };
}
