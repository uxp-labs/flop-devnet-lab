/**
 * P6b, E1 to E3: the endpoint rule. Every refused form, each with its own words and exit 5, none quoting the text;
 * and the accepted forms.
 */
import { describe, expect, it } from "vitest";
import { minerEndpoint, originOf } from "../src/miner/endpoint.js";

const refused = (text: string, check: string) => {
  let e: unknown = null;
  try {
    minerEndpoint(text);
  } catch (x) {
    e = x;
  }
  expect(e, `${JSON.stringify(text)} must be refused`).not.toBeNull();
  const err = e as Error & { code: number; check: string; refusal: string };
  expect(err.code).toBe(5);
  expect(err.refusal).toBe("ENDPOINT");
  expect(err.check).toBe(`endpoint.${check}`);
  // The words never quote the text: every host of these cases but the loopbacks holds "example", and no word does.
  expect(err.message).not.toContain("example");
  if (text.length > 0) expect(err.message).not.toContain(text);
  return err;
};

describe("E1: accepted", () => {
  const ok: [string, string][] = [
    ["https://miner.example", "https://miner.example"],
    ["https://miner.example/", "https://miner.example"],
    ["https://miner.example:8443", "https://miner.example:8443"],
    ["https://10.0.0.7:9000", "https://10.0.0.7:9000"],
    ["https://[2001:db8::1]:8443", "https://[2001:db8::1]:8443"],
    ["http://127.0.0.1", "http://127.0.0.1"],
    ["http://127.0.0.1:8080", "http://127.0.0.1:8080"],
    ["http://127.0.0.1:8080/", "http://127.0.0.1:8080"],
    ["http://[::1]", "http://[::1]"],
    ["http://[::1]:7000", "http://[::1]:7000"],
  ];
  for (const [text, origin] of ok) {
    it(text, () => {
      const e = minerEndpoint(text);
      expect(e.origin).toBe(origin);
      expect(originOf(e)).toBe(origin);
      expect(Object.isFrozen(e)).toBe(true);
    });
  }
});

describe("E1: refused, each with its own words", () => {
  const cases: [string, string, string][] = [
    ["another scheme", "ftp://miner.example", "scheme"],
    ["ws", "ws://miner.example", "scheme"],
    ["not a URL", "miner.example", "form"],
    ["http on a public host", "http://miner.example", "http"],
    ["http on localhost", "http://localhost:8080", "loopback"],
    ["http on LOCALHOST", "http://LOCALHOST", "loopback"],
    ["http on 0.0.0.0", "http://0.0.0.0:8080", "http"],
    ["http on an IPv4 mapped loopback", "http://[::ffff:127.0.0.1]", "http"],
    ["http on another loopback address", "http://127.0.0.2", "http"],
    ["userinfo", "https://user:pass@miner.example", "userinfo"],
    ["a user name alone", "https://user@miner.example", "userinfo"],
    ["a path", "https://miner.example/api", "path"],
    ["a dot segment", "https://miner.example/.", "path"],
    ["two slashes", "https://miner.example//", "path"],
    ["a query", "https://miner.example?x=1", "query"],
    ["a query after a slash", "https://miner.example/?x", "query"],
    ["a fragment", "https://miner.example#f", "fragment"],
    ["an empty host", "https://", "host"],
    ["an empty host with a port", "https://:8443", "host"],
    ["port 0", "https://miner.example:0", "port"],
    ["port 65536", "https://miner.example:65536", "port"],
    ["a port of six digits", "https://miner.example:100000", "port"],
    ["a text over 2048 bytes", `https://${"a".repeat(2050)}.example`, "length"],
    ["a space", "https://miner .example", "control"],
    ["a trailing newline", "https://miner.example\n", "control"],
    ["a tab", "https://miner.example\t", "control"],
    ["a NUL", "https://miner.example\u0000", "control"],
    ["a no break space", "https://miner.example ", "control"],
    ["empty", "", "text"],
  ];
  for (const [what, text, check] of cases) it(what, () => void refused(text, check));

  it("http://localhost says to use 127.0.0.1", () => {
    expect(refused("http://localhost", "loopback").message).toMatch(/127\.0\.0\.1/);
  });

  it("a value that is not a text", () => {
    expect(() => minerEndpoint(42 as unknown as string)).toThrow(expect.objectContaining({ code: 5, check: "endpoint.text" }));
  });
});

describe("E2: a text the parser rewrites is refused, with words that ask for the plain form", () => {
  const rewritten: [string, string][] = [
    ["a host in upper case", "https://Miner.Example"],
    ["a scheme in upper case", "HTTPS://miner.example"],
    ["the default port written out", "https://miner.example:443"],
    ["http's default port written out", "http://127.0.0.1:80"],
    ["a port with a leading zero", "https://miner.example:08443"],
    ["an empty port", "https://miner.example:"],
    ["a percent escape in the host", "https://miner%2Eexample"],
    ["an IDN", "https://bücher.example"],
    ["a short IPv4 loopback", "http://127.1"],
    ["a trailing dot on an IPv4 loopback", "http://127.0.0.1."],
    ["an IPv6 loopback written long", "http://[0:0:0:0:0:0:0:1]"],
    ["a backslash", "https://miner.example\\"],
  ];
  for (const [what, text] of rewritten) {
    it(what, () => {
      let e: unknown = null;
      try {
        minerEndpoint(text);
      } catch (x) {
        e = x;
      }
      const err = e as Error & { code: number; check: string };
      expect(err, text).not.toBeNull();
      expect(err.code).toBe(5);
      expect(err.check).toMatch(/^endpoint\./);
    });
  }

  it("the plain check names the plain form", () => {
    expect(refused("https://Miner.Example", "plain").message).toMatch(/plain form/);
    refused("https://miner.example:443", "plain");
    refused("https://bücher.example", "plain");
    refused("http://127.1", "plain");
  });
});

describe("E1: only minerEndpoint makes the value", () => {
  it("originOf refuses a lookalike, exit 5", () => {
    expect(() => originOf({ origin: "https://miner.example" })).toThrow(expect.objectContaining({ code: 5, check: "endpoint.value" }));
    expect(() => originOf(null)).toThrow(expect.objectContaining({ code: 5 }));
  });
});
