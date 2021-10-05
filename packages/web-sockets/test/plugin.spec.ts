import assert from "assert";
import { Request } from "@miniflare/core";
import {
  NoOpLog,
  noop,
  triggerPromise,
  useMiniflare,
  useServer,
} from "@miniflare/shared-test";
import {
  CloseEvent,
  ErrorEvent,
  MessageEvent,
  WebSocket,
  WebSocketPair,
  WebSocketPlugin,
} from "@miniflare/web-sockets";
import test from "ava";

test("WebSocketPlugin: setup: includes WebSocket stuff in globals", (t) => {
  const plugin = new WebSocketPlugin(new NoOpLog());
  const result = plugin.setup();
  t.deepEqual(result.globals, {
    MessageEvent,
    CloseEvent,
    ErrorEvent,
    WebSocketPair,
    WebSocket,
    fetch: plugin.fetch,
  });
});

test("WebSocketPlugin: fetch, reload, dispose: closes WebSockets", async (t) => {
  const plugin = new WebSocketPlugin(new NoOpLog());
  let [eventTrigger, eventPromise] =
    triggerPromise<{ code: number; reason: string }>();
  const server = await useServer(t, noop, (ws) => {
    ws.addEventListener("close", eventTrigger);
  });
  let res = await plugin.fetch(server.ws, {
    headers: { upgrade: "websocket" },
  });
  let webSocket = res.webSocket;
  t.not(webSocket, undefined);
  assert(webSocket);
  webSocket.accept();

  // Check reload closes WebSockets
  plugin.reload();
  let event = await eventPromise;
  t.is(event.code, 1012);
  t.is(event.reason, "Service Restart");

  // Check dispose closes WebSockets
  [eventTrigger, eventPromise] = triggerPromise();
  res = await plugin.fetch(server.ws, {
    headers: { upgrade: "websocket" },
  });
  webSocket = res.webSocket;
  t.not(webSocket, undefined);
  assert(webSocket);
  webSocket.accept();
  plugin.dispose();
  event = await eventPromise;
  t.is(event.code, 1012);
  t.is(event.reason, "Service Restart");
});
test("WebSocketPlugin: fetch, reload: ignores already closed WebSockets", async (t) => {
  const plugin = new WebSocketPlugin(new NoOpLog());
  const [eventTrigger, eventPromise] =
    triggerPromise<{ code: number; reason: string }>();
  const server = await useServer(t, noop, (ws) => {
    ws.addEventListener("close", eventTrigger);
  });
  const res = await plugin.fetch(server.ws, {
    headers: { upgrade: "websocket" },
  });
  const webSocket = res.webSocket;
  t.not(webSocket, undefined);
  assert(webSocket);
  webSocket.accept();
  webSocket.close(1000, "Test Closure");

  plugin.reload(); // Shouldn't throw
  const event = await eventPromise;
  t.is(event.code, 1000);
  t.is(event.reason, "Test Closure"); // Not "Service Restart"
});

test("MiniflareCore: sends and responds to web socket messages", async (t) => {
  const script = `(${(() => {
    const sandbox = self as any;
    sandbox.addEventListener("fetch", (e: FetchEvent) => {
      const [client, worker] = Object.values(new sandbox.WebSocketPair());
      worker.accept();
      // Echo received messages
      worker.addEventListener("message", (e: MessageEvent) => {
        worker.send(e.data);
      });
      // Send message to test queuing
      worker.send("hello client");
      e.respondWith(
        new sandbox.Response(null, {
          status: 101,
          webSocket: client,
        })
      );
    });
  }).toString()})()`;
  const mf = useMiniflare({ WebSocketPlugin }, { script });
  const res = await mf.dispatchFetch(new Request("http://localhost:8787/"));
  t.not(res.webSocket, undefined);
  assert(res.webSocket); // for TypeScript

  const [eventTrigger, eventPromise] = triggerPromise<void>();
  const messages: (string | ArrayBuffer)[] = [];
  res.webSocket.addEventListener("message", (e) => {
    messages.push(e.data);
    if (e.data === "hello worker") eventTrigger();
  });
  // accept() after addEventListener() as it dispatches queued messages
  res.webSocket.accept();
  res.webSocket.send("hello worker");

  await eventPromise;
  t.deepEqual(messages, ["hello client", "hello worker"]);
});