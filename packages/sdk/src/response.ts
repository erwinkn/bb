import { extractErrorMessage } from "@bb/core-ui";

export const DEFAULT_BB_REQUEST_TIMEOUT_MS = 75_000;

export type FetchImplementation = typeof fetch;

export interface RequestTimeoutFetchOptions {
  timeoutMs: number;
}

interface RequestTimeoutContext {
  requestSignal: AbortSignal;
  timeoutMs: number;
  timeoutReason(): DOMException | null;
  finish(): void;
}

interface WrapRequestTimeoutResponseArgs {
  context: RequestTimeoutContext;
  response: Response;
}

interface WrapRequestTimeoutBodyArgs {
  context: RequestTimeoutContext;
  stream: ReadableStream<Uint8Array>;
}

export type SdkResponseLike = Pick<
  Response,
  "arrayBuffer" | "headers" | "json" | "ok" | "status" | "statusText" | "text"
>;

export type JsonBodyOf<TResponse> = TResponse extends {
  json(): Promise<infer TBody>;
}
  ? TBody
  : never;

const ORIGINAL_RESPONSE_PROPERTIES = new Set<PropertyKey>([
  "headers",
  "redirected",
  "type",
  "url",
]);

const ERROR_EXTRACT_OPTS: { legacyKeys: readonly ["detail", "error"] } = {
  legacyKeys: ["detail", "error"],
};

function formatRequestTimeoutDuration(timeoutMs: number): string {
  const seconds = timeoutMs / 1000;
  if (!Number.isInteger(seconds)) {
    return `${timeoutMs} ms`;
  }
  return seconds === 1 ? "1 second" : `${seconds} seconds`;
}

export class BbRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `BB request timed out after ${formatRequestTimeoutDuration(timeoutMs)}.`,
    );
    this.name = "BbRequestTimeoutError";
  }
}

export interface BbHttpErrorArgs {
  body: unknown;
  code: string | null;
  message: string;
  status: number;
}

export class BbHttpError extends Error {
  readonly body: unknown;
  readonly code: string | null;
  readonly status: number;

  constructor(args: BbHttpErrorArgs) {
    super(`HTTP ${args.status}: ${args.message}`);
    this.name = "BbHttpError";
    this.body = args.body;
    this.code = args.code;
    this.status = args.status;
  }
}

export function createRequestTimeoutFetch(
  options: RequestTimeoutFetchOptions,
): FetchImplementation {
  validateRequestTimeoutMs(options.timeoutMs);

  return async (input, init) => {
    const context = startRequestTimeout(options.timeoutMs, init?.signal);

    try {
      const response = await fetch(input, {
        ...init,
        signal: context.requestSignal,
      });
      return wrapRequestTimeoutResponse({ context, response });
    } catch (error) {
      context.finish();
      if (isRequestTimeoutError(context, error)) {
        throw new BbRequestTimeoutError(options.timeoutMs);
      }
      throw error;
    }
  };
}

function startRequestTimeout(
  timeoutMs: number,
  callerSignal: AbortSignal | null | undefined,
): RequestTimeoutContext {
  const controller = new AbortController();
  let timeoutReason: DOMException | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onCallerAbort = () => abort(callerSignal?.reason);
  const finish = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    callerSignal?.removeEventListener("abort", onCallerAbort);
  };
  const abort = (reason: unknown) => {
    finish();
    controller.abort(reason);
  };
  const context: RequestTimeoutContext = {
    requestSignal: controller.signal,
    timeoutMs,
    timeoutReason: () => timeoutReason,
    finish,
  };

  if (callerSignal?.aborted) {
    controller.abort(callerSignal.reason);
    return context;
  }
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  timer = setTimeout(() => {
    timeoutReason = new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    );
    abort(timeoutReason);
  }, timeoutMs);
  timer.unref?.();
  return context;
}

export async function readJsonResponse<TResponse extends SdkResponseLike>(
  response: Promise<TResponse>,
): Promise<JsonBodyOf<TResponse>> {
  const resolved = await resolveResponse(response);
  return resolved.json();
}

export async function readVoidResponse<TResponse extends SdkResponseLike>(
  response: Promise<TResponse>,
): Promise<void> {
  const resolved = await resolveResponse(response);
  await resolved.arrayBuffer();
}

export async function resolveResponse<TResponse extends SdkResponseLike>(
  responsePromise: Promise<TResponse>,
): Promise<TResponse> {
  let response: TResponse;
  try {
    response = await responsePromise;
  } catch (error) {
    if (isTypeErrorWithCauseCode(error, "ECONNREFUSED")) {
      throw new Error(
        "Cannot connect to BB server. Ensure it is running and BB_SERVER_URL is correct.",
      );
    }
    throw error;
  }
  if (!response.ok) {
    const { body, code, message } = await readHttpErrorInfo(response);
    throw new BbHttpError({ body, code, message, status: response.status });
  }
  return response;
}

function wrapRequestTimeoutResponse(
  args: WrapRequestTimeoutResponseArgs,
): Response {
  const { context, response } = args;
  if (response.body === null) {
    context.finish();
    return response;
  }
  const body = new Response(
    wrapRequestTimeoutBody({ context, stream: response.body }),
    {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    },
  );
  return proxyResponseBody(response, body);
}

function proxyResponseBody(response: Response, body: Response): Response {
  return new Proxy(body, {
    get(target, property) {
      if (property === "clone") {
        return () => proxyResponseBody(response, target.clone());
      }
      const source = ORIGINAL_RESPONSE_PROPERTIES.has(property)
        ? response
        : target;
      const value = Reflect.get(source, property, source);
      return typeof value === "function" ? value.bind(source) : value;
    },
  });
}

function wrapRequestTimeoutBody(
  args: WrapRequestTimeoutBodyArgs,
): ReadableStream<Uint8Array> {
  const reader = args.stream.getReader();

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            args.context.finish();
            controller.close();
            return;
          }
          controller.enqueue(result.value);
        } catch (error) {
          args.context.finish();
          if (isRequestTimeoutError(args.context, error)) {
            controller.error(new BbRequestTimeoutError(args.context.timeoutMs));
            return;
          }
          controller.error(error);
        }
      },
      cancel(reason) {
        return reader.cancel(reason).finally(args.context.finish);
      },
    },
    { highWaterMark: 0 },
  );
}

function isRequestTimeoutError(
  context: RequestTimeoutContext,
  error: unknown,
): boolean {
  const timeoutReason = context.timeoutReason();
  if (timeoutReason === null) {
    return false;
  }
  if (error === timeoutReason) {
    return true;
  }

  return (
    context.requestSignal.reason === timeoutReason &&
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function validateRequestTimeoutMs(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError(
      "BB request timeout must be a non-negative finite number.",
    );
  }
}

function isTypeErrorWithCauseCode(
  error: unknown,
  expectedCode: string,
): boolean {
  if (!(error instanceof TypeError)) {
    return false;
  }
  const { cause } = error;
  if (!cause || typeof cause !== "object") {
    return false;
  }
  return "code" in cause && cause.code === expectedCode;
}

interface HttpErrorInfo {
  body: unknown;
  code: string | null;
  message: string;
}

function readHttpErrorCode(parsed: unknown): string | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  if (!("code" in parsed)) {
    return null;
  }
  const { code } = parsed;
  return typeof code === "string" ? code : null;
}

async function readHttpErrorInfo(
  response: SdkResponseLike,
): Promise<HttpErrorInfo> {
  let rawBody: string;
  try {
    rawBody = await response.text();
  } catch (error) {
    if (error instanceof BbRequestTimeoutError) {
      throw error;
    }
    rawBody = "";
  }
  const normalized = rawBody.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return { body: null, code: null, message: response.statusText };
  }

  const contentType = response.headers.get("content-type");
  const shouldParseJson =
    (contentType?.includes("application/json") ?? false) ||
    normalized.startsWith("{") ||
    normalized.startsWith("[");
  if (!shouldParseJson) {
    const message = normalized.startsWith("<")
      ? response.statusText || `Request failed with status ${response.status}`
      : normalized;
    return { body: null, code: null, message };
  }

  try {
    const parsed: unknown = JSON.parse(normalized);
    return {
      body: parsed,
      code: readHttpErrorCode(parsed),
      message: extractErrorMessage(parsed, ERROR_EXTRACT_OPTS) ?? normalized,
    };
  } catch {
    return { body: null, code: null, message: normalized };
  }
}
