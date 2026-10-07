import { EventEmitter, once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket as NodeWebSocket } from "ws";
import { decodeFrame, encodeFrame, type Frame } from "@bb/tunnel-contract";
import { TunnelSession } from "../src/session.js";

class FakeTunnel extends EventEmitter {
  readonly readyState = 1;
  readonly frames: Frame[] = [];
  readonly terminate = vi.fn();

  send(data: Uint8Array): void {
    this.frames.push(decodeFrame(data));
  }

  deliver(frame: Frame): void {
    this.emit("message", Buffer.from(encodeFrame(frame)), true);
  }
}

interface Harness {
  tunnel: FakeTunnel;
  warnings: string[];
  infos: string[];
  waitingResponses: ServerResponse[];
  advance(ms: number): void;
  request(streamId: number, path: string): void;
  cancel(streamId: number): void;
  dispose(): void;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function startHarness(): Promise<Harness> {
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const waitingResponses: ServerResponse[] = [];
  const server = createServer((_request, response) => {
    waitingResponses.push(response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const tunnel = new FakeTunnel();
  const warnings: string[] = [];
  const infos: string[] = [];
  const session = new TunnelSession({
    tunnel: tunnel as unknown as NodeWebSocket,
    log: {
      info: (message) => infos.push(message),
      warn: (message) => warnings.push(message),
    },
    resolveOrigin: () => ({
      kind: "ok",
      resolved: {
        origin: `http://127.0.0.1:${port}`,
        publicOrigin: "https://handle.getbb.app",
      },
    }),
  });
  session.start();
  cleanups.push(async () => {
    session.dispose();
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  });
  return {
    tunnel,
    warnings,
    infos,
    waitingResponses,
    advance(ms) {
      clock += ms;
    },
    cancel(streamId) {
      tunnel.deliver({
        type: "close-stream",
        streamId,
        code: 1000,
        reason: "visitor canceled response body",
      });
    },
    dispose() {
      session.dispose();
    },
    request(streamId, path) {
      tunnel.deliver({
        type: "open-http",
        streamId,
        method: "GET",
        path,
        headers: [],
        hasBody: false,
      });
    },
  };
}

async function nextOriginResponse(harness: Harness): Promise<ServerResponse> {
  await vi.waitFor(() => expect(harness.waitingResponses).toHaveLength(1));
  const response = harness.waitingResponses.shift();
  if (response === undefined) throw new Error("expected an origin request");
  return response;
}

async function bodyEnded(harness: Harness, streamId: number): Promise<void> {
  await vi.waitFor(() =>
    expect(harness.tunnel.frames).toContainEqual({
      type: "body-end",
      streamId,
    }),
  );
}

describe("tunnel request logging", () => {
  it("logs a slow request without its query string", async () => {
    const harness = await startHarness();

    harness.request(1, "/api/v1/threads/thr_1/timeline?token=secret-token");
    const response = await nextOriginResponse(harness);
    harness.advance(6_000);
    response.writeHead(200);
    response.write("first");
    await vi.waitFor(() =>
      expect(harness.tunnel.frames).toContainEqual(
        expect.objectContaining({ type: "resp-head", streamId: 1 }),
      ),
    );
    harness.advance(1_500);
    response.end("ok");
    await bodyEnded(harness, 1);

    await vi.waitFor(() =>
      expect(harness.warnings).toContain(
        "bb connect slow request method=GET path=/api/v1/threads/thr_1/timeline status=200 originTtfbMs=6000 totalMs=7500",
      ),
    );
    expect(harness.warnings.join("\n")).not.toContain("secret-token");
  });

  it("logs an initial thread load without its query string", async () => {
    const harness = await startHarness();

    harness.request(
      6,
      "/api/v1/threads/thr_1/conversation-outline?limit=50&token=secret-token",
    );
    const response = await nextOriginResponse(harness);
    response.end("ok");
    await bodyEnded(harness, 6);

    await vi.waitFor(() => expect(harness.infos).toHaveLength(1));
    expect(harness.infos[0]).toMatch(
      /^bb connect thread load path=\/api\/v1\/threads\/thr_1\/conversation-outline status=200 /u,
    );
    expect(harness.infos[0]).not.toContain("secret-token");
  });

  it("stays quiet for requests under 5 s", async () => {
    const harness = await startHarness();

    harness.request(2, "/api/v1/hosts");
    const response = await nextOriginResponse(harness);
    harness.advance(4_900);
    response.end("ok");
    await bodyEnded(harness, 2);

    expect(harness.warnings).toEqual([]);
  });

  it("logs a request the relay cancelled mid-stream", async () => {
    const harness = await startHarness();

    harness.request(3, "/api/v1/server/export?key=secret-key");
    const response = await nextOriginResponse(harness);
    response.writeHead(200);
    response.write("first");
    await vi.waitFor(() =>
      expect(harness.tunnel.frames).toContainEqual(
        expect.objectContaining({ type: "body-chunk", streamId: 3 }),
      ),
    );
    harness.advance(250);
    harness.tunnel.deliver({
      type: "close-stream",
      streamId: 3,
      code: 1000,
      reason: "visitor canceled response body",
    });

    await vi.waitFor(() =>
      expect(harness.warnings).toEqual([
        'bb connect request cancelled by relay method=GET path=/api/v1/server/export status=200 originTtfbMs=0 totalMs=250 reason="visitor canceled response body"',
      ]),
    );
    await vi.waitFor(() => expect(response.closed).toBe(true));
    expect(response.writableFinished).toBe(false);
  });

  it("flags a response head the relay had already timed out", async () => {
    const harness = await startHarness();

    harness.request(4, "/api/v1/plugins/slow/rpc/run");
    const response = await nextOriginResponse(harness);
    harness.advance(31_000);
    response.writeHead(502);
    response.end();
    await bodyEnded(harness, 4);

    await vi.waitFor(() =>
      expect(harness.warnings).toEqual([
        "bb connect slow request method=GET path=/api/v1/plugins/slow/rpc/run status=502 originTtfbMs=31000 totalMs=31000 relayTimedOut=true",
      ]),
    );
  });

  it("logs a relay cancellation of a path that is not a valid URL", async () => {
    const harness = await startHarness();
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      harness.request(5, "//[bad?token=secret-token");
      const response = await nextOriginResponse(harness);
      response.writeHead(200);
      response.write("first");
      await vi.waitFor(() =>
        expect(harness.tunnel.frames).toContainEqual(
          expect.objectContaining({ type: "body-chunk", streamId: 5 }),
        ),
      );
      harness.cancel(5);

      await vi.waitFor(() =>
        expect(harness.warnings).toEqual([
          'bb connect request cancelled by relay method=GET path=//[bad status=200 originTtfbMs=0 totalMs=0 reason="visitor canceled response body"',
        ]),
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("logs one line for a burst of cancellations and counts the rest", async () => {
    const harness = await startHarness();
    const streamIds = Array.from({ length: 100 }, (_, index) => 100 + index);

    for (const streamId of streamIds) {
      harness.request(streamId, "/api/v1/hosts?token=secret-token");
    }
    await vi.waitFor(() =>
      expect(harness.waitingResponses).toHaveLength(streamIds.length),
    );
    for (const response of harness.waitingResponses) {
      response.writeHead(200);
      response.write("first");
    }
    await vi.waitFor(() =>
      expect(
        harness.tunnel.frames.filter((frame) => frame.type === "body-chunk"),
      ).toHaveLength(streamIds.length),
    );
    for (const streamId of streamIds) harness.cancel(streamId);

    await vi.waitFor(() =>
      expect(harness.warnings).toEqual([
        'bb connect request cancelled by relay method=GET path=/api/v1/hosts status=200 originTtfbMs=0 totalMs=0 reason="visitor canceled response body"',
      ]),
    );
    harness.dispose();
    expect(harness.warnings).toEqual([
      'bb connect request cancelled by relay method=GET path=/api/v1/hosts status=200 originTtfbMs=0 totalMs=0 reason="visitor canceled response body"',
      "bb connect request cancelled by relay method=GET path=/api/v1/hosts suppressed=99 maxTotalMs=0",
    ]);
    expect(harness.warnings.join("\n")).not.toContain("secret-token");
  });
});
