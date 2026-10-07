import { getEventListeners, once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BbRequestTimeoutError,
  createRequestTimeoutFetch,
  readJsonResponse,
  readVoidResponse,
} from "../src/response.js";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

interface TestServer {
  url: string;
  close(): Promise<void>;
}

const servers: TestServer[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function startServer(handler: Handler): Promise<TestServer> {
  const server: Server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const testServer = {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
  servers.push(testServer);
  return testServer;
}

function abortListeners(signal: AbortSignal): number {
  return getEventListeners(signal, "abort").length;
}

function recordedDependants(signal: AbortSignal): number {
  const key = Object.getOwnPropertySymbols(signal).find(
    (symbol) => symbol.description === "kDependantSignals",
  );
  if (key === undefined) return 0;
  const dependants: unknown = Reflect.get(signal, key);
  if (typeof dependants !== "object" || dependants === null) return 0;
  const size: unknown = Reflect.get(dependants, "size");
  return typeof size === "number" ? size : 0;
}

describe("createRequestTimeoutFetch() on a long-lived signal", () => {
  it("leaves no listeners and no composite signals after many calls", async () => {
    const server = await startServer((request, response) => {
      if (request.url === "/void") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"id":"thread-1"}');
    });
    const lifetime = new AbortController();
    const timeoutFetch = createRequestTimeoutFetch({ timeoutMs: 60_000 });

    for (let call = 0; call < 200; call += 1) {
      const path = call % 2 === 0 ? "/json" : "/void";
      const response = timeoutFetch(`${server.url}${path}`, {
        signal: lifetime.signal,
      });
      if (path === "/json") {
        await expect(readJsonResponse(response)).resolves.toEqual({
          id: "thread-1",
        });
      } else {
        await readVoidResponse(response);
      }
    }

    expect(abortListeners(lifetime.signal)).toBe(0);
    expect(recordedDependants(lifetime.signal)).toBe(0);
  });

  it("clears the timeout timer once the body is read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response('{"ok":true}')),
    );
    const lifetime = new AbortController();
    const timeoutFetch = createRequestTimeoutFetch({ timeoutMs: 60_000 });

    await readJsonResponse(
      timeoutFetch("http://server/api/v1/hosts", { signal: lifetime.signal }),
    );
    await readVoidResponse(
      timeoutFetch("http://server/api/v1/hosts", { signal: lifetime.signal }),
    );
    const cancelled = await timeoutFetch("http://server/api/v1/hosts", {
      signal: lifetime.signal,
    });
    await cancelled.body?.cancel();

    expect(vi.getTimerCount()).toBe(0);
    expect(abortListeners(lifetime.signal)).toBe(0);
  });

  it("keeps the abort link until a streaming body ends", async () => {
    const streaming: ServerResponse[] = [];
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("first");
      streaming.push(response);
    });
    const lifetime = new AbortController();
    const timeoutFetch = createRequestTimeoutFetch({ timeoutMs: 60_000 });

    const response = await timeoutFetch(server.url, {
      signal: lifetime.signal,
    });
    const text = response.text();
    expect(abortListeners(lifetime.signal)).toBe(1);

    streaming[0]?.end("last");
    await expect(text).resolves.toBe("firstlast");
    expect(abortListeners(lifetime.signal)).toBe(0);
  });

  it("cancels a streaming body when the caller aborts mid-stream", async () => {
    let serverSawClose: Promise<unknown> = Promise.resolve();
    const server = await startServer((_request, response) => {
      serverSawClose = once(response, "close");
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("first");
    });
    const lifetime = new AbortController();
    const reason = new Error("caller stopped");
    const timeoutFetch = createRequestTimeoutFetch({ timeoutMs: 60_000 });

    const response = await timeoutFetch(server.url, {
      signal: lifetime.signal,
    });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Expected a response body");
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("first");

    lifetime.abort(reason);

    await expect(reader.read()).rejects.toBe(reason);
    await serverSawClose;
    expect(abortListeners(lifetime.signal)).toBe(0);
  });

  it("times out a stalled streaming body and releases the caller signal", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("first");
    });
    const lifetime = new AbortController();
    const timeoutFetch = createRequestTimeoutFetch({ timeoutMs: 50 });

    const response = await timeoutFetch(server.url, {
      signal: lifetime.signal,
    });

    await expect(response.text()).rejects.toBeInstanceOf(BbRequestTimeoutError);
    expect(lifetime.signal.aborted).toBe(false);
    expect(abortListeners(lifetime.signal)).toBe(0);
  });

  it("releases the caller signal when the request fails before headers", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("socket reset"));
    const lifetime = new AbortController();
    const timeoutFetch = createRequestTimeoutFetch({ timeoutMs: 60_000 });

    await expect(
      timeoutFetch("http://server/api/v1/hosts", { signal: lifetime.signal }),
    ).rejects.toThrow("socket reset");
    expect(abortListeners(lifetime.signal)).toBe(0);
  });

  it("keeps the abort link when a second body read fails", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("first");
    });
    const lifetime = new AbortController();
    const reason = new Error("caller stopped");
    const timeoutFetch = createRequestTimeoutFetch({ timeoutMs: 60_000 });

    const response = await timeoutFetch(server.url, {
      signal: lifetime.signal,
    });
    const firstRead = response.text();
    await expect(response.json()).rejects.toBeInstanceOf(TypeError);
    expect(abortListeners(lifetime.signal)).toBe(1);

    lifetime.abort(reason);

    await expect(firstRead).rejects.toBe(reason);
    expect(abortListeners(lifetime.signal)).toBe(0);
  });

  it("still times out a pending read after a second read fails", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("first");
    });
    const lifetime = new AbortController();
    const timeoutFetch = createRequestTimeoutFetch({ timeoutMs: 50 });

    const response = await timeoutFetch(server.url, {
      signal: lifetime.signal,
    });
    const firstRead = response.text();
    await expect(response.text()).rejects.toBeInstanceOf(TypeError);

    await expect(firstRead).rejects.toBeInstanceOf(BbRequestTimeoutError);
    expect(abortListeners(lifetime.signal)).toBe(0);
  });

  it("releases the caller signal once a clone has read the whole body", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    const lifetime = new AbortController();
    const timeoutFetch = createRequestTimeoutFetch({ timeoutMs: 60_000 });

    const response = await timeoutFetch(server.url, {
      signal: lifetime.signal,
    });
    await expect(response.clone().json()).resolves.toEqual({ ok: true });

    expect(abortListeners(lifetime.signal)).toBe(0);
    await expect(response.text()).resolves.toBe('{"ok":true}');
  });

  it("lets native Response methods read the wrapped body", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
    const lifetime = new AbortController();
    const timeoutFetch = createRequestTimeoutFetch({ timeoutMs: 60_000 });

    const read = await timeoutFetch(server.url, { signal: lifetime.signal });
    expect(read).toBeInstanceOf(Response);
    expect(read.url).toBe(`${server.url}/`);
    expect(read.bodyUsed).toBe(false);
    await expect(Response.prototype.text.call(read)).resolves.toBe("ok");
    expect(read.bodyUsed).toBe(true);
    expect(abortListeners(lifetime.signal)).toBe(0);

    const cloned = await timeoutFetch(server.url, { signal: lifetime.signal });
    await expect(Response.prototype.clone.call(cloned).text()).resolves.toBe(
      "ok",
    );
    await expect(cloned.text()).resolves.toBe("ok");
    expect(abortListeners(lifetime.signal)).toBe(0);
  });
});
