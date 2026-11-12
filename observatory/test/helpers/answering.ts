// The live transport over a fake socket class that answers each call as a test says: the record
// run's tests and the recording reader's tests make their recordings with it. No socket is opened.
import { NetTransport, type SocketEvent, type SocketLike } from "../../src/net.js";
import { RECORD_ANSWER_LIMITS } from "../../src/record-run.js";

export type Reply = { result: unknown } | { error: { code: number; message: string } } | { raw: (id: number) => string } | "silent";

/**
 * The live transport over a fake socket class that opens at once and answers each call it is sent
 * with reply(method, params). Every socket made is kept, so a test can see none was.
 */
export function network(reply: (method: string, params: unknown[]) => Reply, o: { failOpen?: boolean; limits?: ReadonlyMap<string, number> } = {}) {
  const made: string[][] = [];
  class AnsweringSocket implements SocketLike {
    readonly sent: string[] = [];
    private readonly listeners: [string, (e: SocketEvent) => void][] = [];
    constructor(_url: string) {
      made.push(this.sent);
      setTimeout(() => (o.failOpen ? this.emit("error", { message: "connection refused" }) : this.emit("open", {})), 0);
    }
    addEventListener(type: string, l: (e: SocketEvent) => void): void {
      this.listeners.push([type, l]);
    }
    send(data: string): void {
      this.sent.push(data);
      const m = JSON.parse(data) as { id: number; method: string; params: unknown[] };
      const r = reply(m.method, m.params);
      if (r === "silent") return;
      const text = "raw" in r ? r.raw(m.id) : JSON.stringify({ jsonrpc: "2.0", id: m.id, ...r });
      setTimeout(() => this.emit("message", { data: text }), 0);
    }
    close(): void {}
    emit(type: string, e: SocketEvent): void {
      for (const [t, l] of this.listeners) if (t === type) l(e);
    }
  }
  const t = new NetTransport({ socketClass: AnsweringSocket, httpCall: async () => Promise.reject(new Error("no GET in a recording")), answerLimits: o.limits ?? RECORD_ANSWER_LIMITS, timeoutMs: 50 });
  return { t, made };
}

