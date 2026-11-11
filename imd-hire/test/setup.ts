// This package never touches the network, and its tests prove it: any attempt fails loudly.
globalThis.fetch = (() => {
  throw new Error("network disabled in tests");
}) as typeof fetch;
(globalThis as { WebSocket?: unknown }).WebSocket = class {
  constructor() {
    throw new Error("network disabled in tests");
  }
};
