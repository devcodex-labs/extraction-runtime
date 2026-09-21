import { request as httpRequest } from "node:http";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isUtf8 } from "node:buffer";

export class TransportError extends Error {
  constructor(readonly code: "TIMEOUT" | "NETWORK_ERROR" | "UNKNOWN_PROVIDER_ERROR") { super(code); }
}

export interface DeadlineScope {
  readonly signal: AbortSignal;
  checkDeadline(): void;
}

/** Segments long timers and checks synchronous parsing against a monotonic clock. */
export async function withDeadline<T>(timeoutMs: number, work: (scope: DeadlineScope) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const remaining = () => timeoutMs - (performance.now() - startedAt);
  const checkDeadline = () => {
    if (controller.signal.aborted || remaining() <= 0) {
      controller.abort();
      throw new TransportError("TIMEOUT");
    }
  };
  const schedule = () => {
    const left = remaining();
    if (left <= 0) { controller.abort(); return; }
    timer = setTimeout(schedule, Math.min(left, 2_147_483_647));
  };
  schedule();
  try {
    const result = await work({ signal: controller.signal, checkDeadline });
    checkDeadline();
    return result;
  } catch (error) {
    checkDeadline();
    throw error;
  } finally { clearTimeout(timer); }
}

export interface HttpResponseSnapshot { readonly status: number; readonly bodyText?: string; }
export type RequestOnce = (endpoint: URL, headers: Readonly<Record<string, string>>, body: string, scope: DeadlineScope) => Promise<HttpResponseSnapshot>;

/** One ClientRequest, no redirects/retries; settle only after owned streams close. */
export const requestOnce: RequestOnce = (endpoint, headers, body, scope) => new Promise((resolve, reject) => {
  let request: ClientRequest | undefined;
  let response: IncomingMessage | undefined;
  let requestClosed = false;
  let responseClosed = true;
  let result: HttpResponseSnapshot | undefined;
  let failure: TransportError | undefined;
  let settled = false;
  const chunks: Buffer[] = [];
  const finish = () => {
    if (settled || !requestClosed || !responseClosed) return;
    settled = true;
    scope.signal.removeEventListener("abort", abort);
    chunks.length = 0;
    if (scope.signal.aborted) reject(new TransportError("TIMEOUT"));
    else if (failure || !result) reject(failure ?? new TransportError("NETWORK_ERROR"));
    else resolve(result);
  };
  const stop = (code: TransportError["code"]) => {
    failure ??= new TransportError(code);
    response?.destroy();
    request?.destroy();
  };
  const abort = () => stop("TIMEOUT");
  try {
    scope.checkDeadline();
    request = (endpoint.protocol === "https:" ? httpsRequest : httpRequest)(endpoint, {
      method: "POST", agent: false, headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
    }, incoming => {
      response = incoming;
      responseClosed = false;
      incoming.on("error", () => { if (!result) stop("NETWORK_ERROR"); });
      incoming.on("aborted", () => { if (!result) stop("NETWORK_ERROR"); });
      incoming.on("close", () => { responseClosed = true; finish(); });
      const status = incoming.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        result = { status };
        incoming.destroy();
        return;
      }
      const encoding = incoming.headers["content-encoding"];
      if (encoding !== undefined && encoding.trim().toLowerCase() !== "identity") {
        stop("UNKNOWN_PROVIDER_ERROR");
        return;
      }
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        if (!incoming.complete) { stop("NETWORK_ERROR"); return; }
        try {
          const body = Buffer.concat(chunks);
          chunks.length = 0;
          // Buffer decoding otherwise replaces corrupt bytes with business-visible U+FFFD.
          if (!isUtf8(body)) { stop("UNKNOWN_PROVIDER_ERROR"); return; }
          result = { status, bodyText: body.toString("utf8") };
        } catch { stop("UNKNOWN_PROVIDER_ERROR"); }
      });
    });
    request.on("error", () => stop("NETWORK_ERROR"));
    request.on("close", () => { requestClosed = true; finish(); });
    scope.signal.addEventListener("abort", abort, { once: true });
    if (scope.signal.aborted) abort();
    else request.end(body);
  } catch {
    if (request) stop(scope.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR");
    else {
      requestClosed = true;
      failure = new TransportError(scope.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR");
      finish();
    }
  }
});
