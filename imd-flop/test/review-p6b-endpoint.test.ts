/**
 * Review of P6b, attack 2 (C1): a wide list of endpoint texts, by the reviewer's own list. For each refused text:
 * exit 5 and none of its text in the message. For each taken text: the origin fetch is then called with, and that
 * it names the same scheme, host and port the text named.
 */
import { describe, expect, it } from "vitest";
import { MinerClientError } from "../src/miner/client-errors.js";
import { minerEndpoint } from "../src/miner/endpoint.js";
import { minerHttp } from "../src/miner/http.js";

const REFUSED: string[] = [
  "HTTPS://qzhost.example",
  "Https://qzhost.example",
  "HTTP://127.0.0.1",
  "ftp://qzhost.example",
  "ws://127.0.0.1",
  "wss://qzhost.example",
  "file:///etc/passwd",
  "data:text/plain,x",
  "javascript:alert(1)",
  "https:qzhost.example",
  "https:/qzhost.example",
  "https:///qzhost.example",
  "//qzhost.example",
  "qzhost.example",
  "http://localhost",
  "http://LOCALHOST",
  "http://localhost.",
  "http://localhost:8080",
  "http://127.1",
  "http://2130706433",
  "http://0x7f.0.0.1",
  "http://0x7f000001",
  "http://0177.0.0.1",
  "http://127.000.000.001",
  "http://[::ffff:127.0.0.1]",
  "http://[::ffff:7f00:1]",
  "http://[0:0:0:0:0:0:0:1]",
  "http://[0::1]",
  "http://127.0.0.1.",
  "http://127.0.0.2",
  "http://0.0.0.0",
  "http://[::]",
  "http://10.0.0.1",
  "http://qzhost.example",
  "https://qzuser@qzhost.example",
  "https://:qzpass@qzhost.example",
  "https://qzuser:qzpass@qzhost.example",
  "https://@qzhost.example",
  "http://qzuser@127.0.0.1",
  "https://qzhost.example:0",
  "https://qzhost.example:65536",
  "https://qzhost.example:99999",
  "https://qzhost.example:",
  "https://qzhost.example:443",
  "http://127.0.0.1:80",
  "https://qzhost.example:0443",
  "https://qzhost.example:08443",
  "https://qzhost.example:-1",
  "https://qzhost.example:8443:",
  "https://qzhost.example/path",
  "https://qzhost.example//",
  "https://qzhost.example/.",
  "https://qzhost.example/./",
  "https://qzhost.example/%2e",
  "https://qzhost.example/session/turn",
  "https://qzhost.example?x=1",
  "https://qzhost.example/?",
  "https://qzhost.example?",
  "https://qzhost.example#x",
  "https://qzhost.example#",
  "https://qzhost.example/#",
  "https://qzhost.example\\",
  "https://qzhost.example\\@qzother.example",
  "https://qzhost.example\t",
  "https://qz\thost.example",
  "https://qzhost.example\n",
  "https://qz\nhost.example",
  "https://qzhost.example\r",
  " https://qzhost.example",
  "https://qzhost.example ",
  "https://qzh ost.example",
  "https://mi​ner.example",
  "https://mi­ner.example",
  "https://ｍiner.example",
  "https://QZHOST.example",
  "https://miner.EXAMPLE",
  "https://bücher.example",
  "https://xn--bcher-KVA.example",
  "https://[::1%25eth0]",
  "https://[fe80::1%eth0]",
  "https://qz%68ost.example",
  "https://",
  "https://:8443",
  "http://",
  "",
  "https://qzhost.example\u0000",
  "https://qzhost.example\u007f",
  "https://qzhost.example\u0085",
  "https://qzhost.example ",
  "https://miner.exam‮ple",
  "https://" + "a".repeat(2049 - 8),
  "https://" + "a".repeat(2040) + ".example",
];

const TAKEN: [string, string, string][] = [
  // text, the origin, the host fetch is asked
  ["https://miner.example", "https://miner.example", "miner.example"],
  ["https://miner.example/", "https://miner.example", "miner.example"],
  ["https://miner.example:8443", "https://miner.example:8443", "miner.example:8443"],
  ["https://miner.example:8443/", "https://miner.example:8443", "miner.example:8443"],
  ["https://xn--bcher-kva.example", "https://xn--bcher-kva.example", "xn--bcher-kva.example"],
  ["http://127.0.0.1", "http://127.0.0.1", "127.0.0.1"],
  ["http://127.0.0.1:8080/", "http://127.0.0.1:8080", "127.0.0.1:8080"],
  ["http://[::1]", "http://[::1]", "[::1]"],
  ["http://[::1]:9/", "http://[::1]:9", "[::1]:9"],
  ["https://127.0.0.1", "https://127.0.0.1", "127.0.0.1"],
  ["https://[2001:db8::1]:443".replace(":443", ":8443"), "https://[2001:db8::1]:8443", "[2001:db8::1]:8443"],
  ["https://miner.example:1", "https://miner.example:1", "miner.example:1"],
  ["https://miner.example:65535", "https://miner.example:65535", "miner.example:65535"],
];

function refusalOf(text: string): MinerClientError | null {
  try {
    minerEndpoint(text);
    return null;
  } catch (e) {
    return e as MinerClientError;
  }
}

/** The parts of a text a message must not hold: its host and any run of 4 or more of its letters. */
function leaks(message: string, text: string): string[] {
  const out: string[] = [];
  for (const part of ["qz", "QZ", "example", "LOCALHOST", "eth0", "passwd", "aaaa", "bücher", "KVA", "0x7f", "2130706433", "0177", "8080", "8443"]) if (text.includes(part) && message.includes(part)) out.push(part);
  return out;
}

describe("C1 by the reviewer's own list", () => {
  it(`HOLDS: each of ${REFUSED.length} texts is refused with exit 5 and none of its text in the message`, () => {
    const taken: string[] = [];
    const bad: string[] = [];
    for (const t of REFUSED) {
      const e = refusalOf(t);
      if (e === null) {
        taken.push(JSON.stringify(t));
        continue;
      }
      if (!(e instanceof MinerClientError) || e.refusal !== "ENDPOINT" || e.code !== 5) bad.push(`${JSON.stringify(t)}: not an endpoint refusal of exit 5`);
      const l = leaks(e.message, t);
      if (l.length > 0) bad.push(`${JSON.stringify(t)}: the message holds ${l.join(", ")}`);
    }
    expect(taken).toEqual([]);
    expect(bad).toEqual([]);
  });

  it(`HOLDS: each of ${TAKEN.length} taken texts gives the origin it named, and fetch is asked that host and port`, async () => {
    for (const [text, origin, host] of TAKEN) {
      const ep = minerEndpoint(text);
      expect(ep.origin, text).toBe(origin);
      const asked: string[] = [];
      const t = minerHttp(ep, async (url) => {
        asked.push(url);
        return new Response(null, { status: 401 });
      });
      await t({ call: "probe", body: null, signed: null, maxBytes: 100, timeMs: 1000 });
      const u = new URL(asked[0] as string);
      expect(u.host, text).toBe(host);
      expect(u.protocol, text).toBe(text.slice(0, text.indexOf(":") + 1));
      expect(u.pathname).toBe("/session/info");
    }
  });

  it("HOLDS: a text that is not a string is refused with exit 5", () => {
    for (const v of [null, undefined, 1, {}, ["https://miner.example"], new String("https://miner.example")]) {
      const e = refusalOf(v as never);
      expect(e?.code).toBe(5);
    }
  });
});

describe("C1: a host with a trailing dot (note)", () => {
  it("HOLDS: (as it is today) https on a DNS name with a trailing dot is taken as it was written; fetch goes to that same name", () => {
    // Recorded, not ruled: the parser keeps the dot, so the plain form rule does not refuse it. It names the same
    // DNS host; a TLS name check may differ. The lead may wish to refuse it.
    expect(minerEndpoint("https://miner.example.").origin).toBe("https://miner.example.");
  });
});
