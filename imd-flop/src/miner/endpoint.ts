/**
 * The endpoint (E1 to E3, M-11): one function turns a text into the origin the client speaks to, a frozen value
 * that only it makes. The origin is a scheme, a host and a port, and nothing more.
 *
 * Accepted: `https://host` and `https://host:port`; `http://127.0.0.1[:port]` and `http://[::1][:port]`, with or
 * without one trailing `/`. FLOP's SDK takes http on `localhost` too (`direct-session-chain.js`); this client does
 * not: a name is resolved by the system and is no promise of loopback.
 *
 * The text is parsed by the platform's URL, then held to itself: the origin rebuilt from the parsed parts must equal
 * the text but for one trailing `/`. So a text the parser would rewrite (a host in another letter case, a default
 * port written out, a dot segment, a percent escape, an IDN) is refused, not taken silently. Every refusal is exit
 * 5, with its own words, and none quotes the text.
 */
import { freezeFunction } from "../freeze.js";
import { refuseEndpoint } from "./client-errors.js";

/** The most UTF-8 bytes of an endpoint text. */
export const ENDPOINT_MAX_BYTES = 2048;
/** The two literal loopback hosts http is allowed on. */
export const LOOPBACK_HOSTS = Object.freeze(["127.0.0.1", "[::1]"] as const);

export interface MinerEndpoint {
  /** The origin, as `scheme://host[:port]` with no trailing `/`. */
  readonly origin: string;
}

const MADE = new WeakSet<object>();

/** A control character or any white space: C0, DEL, C1, the space and every Unicode space. */
const CONTROL_OR_SPACE = /[\p{Cc}\s]/u;
/** The scheme and the authority, read before the parser: the host's text and the port's digits. */
const AUTHORITY = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/;

/** The port's digits at the end of an authority, if the authority ends in a colon and digits outside brackets. */
function portDigits(authority: string): string | null {
  const m = /:([0-9]*)$/.exec(authority);
  if (m === null) return null;
  // A colon inside an IPv6 literal is not a port.
  if (authority.startsWith("[") && !/\]:[0-9]*$/.test(authority)) return null;
  return m[1] as string;
}

/**
 * The endpoint of a run. Refused, each with its own words: a text that is not a string, over ENDPOINT_MAX_BYTES,
 * with a control character or a space; any scheme but https and http; userinfo; an empty host; a port out of 1 to
 * 65535; a path other than empty or `/`; a query; a fragment; http on any host but 127.0.0.1 and [::1] (localhost
 * with words that say to use 127.0.0.1); a text the parser rewrites.
 */
export function minerEndpoint(text: string): MinerEndpoint {
  if (typeof text !== "string") return refuseEndpoint("text", "the endpoint must be a text");
  if (text.length === 0) refuseEndpoint("text", "the endpoint must not be empty");
  if (text.length > ENDPOINT_MAX_BYTES || new TextEncoder().encode(text).length > ENDPOINT_MAX_BYTES) refuseEndpoint("length", `the endpoint must be at most ${ENDPOINT_MAX_BYTES} bytes`);
  if (CONTROL_OR_SPACE.test(text)) refuseEndpoint("control", "the endpoint must hold no control character and no space");
  const head = AUTHORITY.exec(text);
  if (head === null) return refuseEndpoint("form", "the endpoint must be an origin of the form https://host or https://host:port");
  const scheme = (head[1] as string).toLowerCase();
  if (scheme !== "https" && scheme !== "http") refuseEndpoint("scheme", "the endpoint's scheme must be https (or http on 127.0.0.1 or [::1])");
  const authority = head[2] as string;
  if (authority.includes("@")) refuseEndpoint("userinfo", "the endpoint must hold no user name or password");
  const port = portDigits(authority);
  const host = port === null ? authority : authority.slice(0, authority.length - port.length - 1);
  if (host.length === 0) refuseEndpoint("host", "the endpoint's host must not be empty");
  if (port !== null && port.length > 0 && (port.length > 5 || Number(port) < 1 || Number(port) > 65535)) refuseEndpoint("port", "the endpoint's port must be from 1 to 65535");
  const rest = text.slice(head[0].length);
  if (rest.includes("#")) refuseEndpoint("fragment", "the endpoint must hold no fragment");
  if (rest.includes("?")) refuseEndpoint("query", "the endpoint must hold no query");
  if (rest !== "" && rest !== "/") refuseEndpoint("path", "the endpoint must hold no path: give the origin alone");

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return refuseEndpoint("form", "the endpoint is not a URL this client reads");
  }
  if (url.username !== "" || url.password !== "") refuseEndpoint("userinfo", "the endpoint must hold no user name or password");
  if (url.protocol === "http:") {
    if (url.hostname === "localhost" || host.toLowerCase() === "localhost") refuseEndpoint("loopback", "http is taken on the literal 127.0.0.1 or [::1] only: give 127.0.0.1, not localhost, which the system resolves");
    if (!(LOOPBACK_HOSTS as readonly string[]).includes(url.hostname)) refuseEndpoint("http", "http is taken on 127.0.0.1 or [::1] only: use https for any other host");
  } else if (url.protocol !== "https:") {
    refuseEndpoint("scheme", "the endpoint's scheme must be https (or http on 127.0.0.1 or [::1])");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") refuseEndpoint("path", "the endpoint must hold no path: give the origin alone");
  const origin = `${url.protocol}//${url.host}`;
  if (text !== origin && text !== `${origin}/`) refuseEndpoint("plain", "the endpoint must be given in its plain form: a lower case host, no default port written out, no escape, no dot segment, an IDN in its ASCII form");
  const out: MinerEndpoint = Object.freeze({ origin });
  MADE.add(out);
  return out;
}
freezeFunction(minerEndpoint);

/** The origin of a value minerEndpoint made. Anything else is refused (exit 5). */
export function originOf(value: unknown): string {
  if (typeof value !== "object" || value === null || !MADE.has(value)) return refuseEndpoint("value", "the endpoint must be a value made by minerEndpoint");
  return (value as MinerEndpoint).origin;
}
freezeFunction(originOf);
