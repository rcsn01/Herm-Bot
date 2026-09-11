import assert from "node:assert/strict";
import test from "node:test";
import { JsonRpcSocket } from "../src/json-rpc.js";

class FakeWebSocket extends EventTarget {
  static OPEN = 1;

  constructor() {
    super();
    this.readyState = 0;
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(raw) {
    const request = JSON.parse(raw);
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } }),
    })));
  }

  close() {
    this.readyState = 3;
    queueMicrotask(() => this.dispatchEvent(new Event("close")));
  }
}

test("JSON-RPC socket resolves responses and reports an explicit close", async () => {
  const socket = new JsonRpcSocket({
    url: "ws://gateway.example/api/ws",
    WebSocketImpl: FakeWebSocket,
  });
  await socket.connect();
  assert.deepEqual(await socket.request("gateway.ping"), { ok: true });

  let closed = 0;
  socket.onClose(() => { closed += 1; });
  socket.close();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(closed, 1);
});
