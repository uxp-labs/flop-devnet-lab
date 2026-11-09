// Tests never touch the network: any fetch or websocket attempt fails loudly.
globalThis.fetch = (() => {
  throw new Error("network disabled in tests");
}) as typeof fetch;
(globalThis as { WebSocket?: unknown }).WebSocket = class {
  constructor() {
    throw new Error("network disabled in tests");
  }
};
