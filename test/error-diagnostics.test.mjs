import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { extractStructured } from "../dist/index.js";
import { createMistralAdapter } from "../dist/providers/mistral.js";
import { createRuntime } from "../dist/structured/runtime.js";

const request = baseUrl => ({ provider: "mistral", model: "mistral-ocr-4-1", apiKey: "probe-private-key", baseUrl, timeoutMs: 1000,
  schema: { type: "object" }, inputs: [{ url: "https://files.example/a?signature=private-signature", kind: "document" }] });

async function fixture(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port;
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    assert.equal(server.listening, false);
    const probe = http.createServer();
    await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", resolve); });
    await new Promise(resolve => probe.close(resolve));
  });
  return `http://127.0.0.1:${port}`;
}

test("public entry preserves upstream reasons and IDs without changing HTTP classification or retrying", async t => {
  let status = 422; let hits = 0;
  const url = await fixture(t, (r, s) => {
    hits++; r.resume(); s.writeHead(status, { "Content-Type": "application/json", "X-Request-Id": `req_${status}` });
    s.end(JSON.stringify({ message: "Document download failed: signed URL expired.", type: "invalid_request_error", code: "document_fetch_failed", param: "document", ignored: "raw-body-only" }));
  });
  for (const [next, code] of [[401,"AUTHENTICATION_FAILED"],[403,"AUTHENTICATION_FAILED"],[422,"PROVIDER_REJECTED"],[429,"RATE_LIMITED"],[500,"UNKNOWN_PROVIDER_ERROR"]]) {
    status = next;
    const { items } = await extractStructured(request(url));
    assert.equal(items[0].error.code, code); assert.equal(items[0].error.providerStatus, next);
    assert.equal(items[0].error.providerRequestId, `req_${next}`);
    assert.deepEqual(items[0].error.providerError, { message: "Document download failed: signed URL expired.", type: "invalid_request_error", code: "document_fetch_failed", param: "document" });
    assert.doesNotMatch(JSON.stringify(items), /raw-body-only/);
  }
  assert.equal(hits, 5);
});

test("invalid, excessive, encoded or interrupted error bodies retain HTTP status and safe request ID", async t => {
  let mode = ""; let hits = 0;
  const url = await fixture(t, (r, s) => {
    hits++; r.resume();
    s.writeHead(422, { "request-id": "req_fallback", ...(mode === "compressed" ? { "Content-Encoding": "gzip" } : {}), ...(mode === "broken" ? { "Content-Length": 9000 } : {}) });
    if (mode === "broken") { s.write('{"message":'); setImmediate(() => s.destroy()); }
    else if (mode === "limit") s.end(JSON.stringify({ message: "x".repeat(16_384) }));
    else if (mode === "utf8") s.end(Buffer.from([255]));
    else s.end({ empty: "", html: "<html>private</html>", json: "{", compressed: "gzip-bytes", shape: "[]" }[mode]);
  });
  for (const value of ["empty", "html", "json", "shape", "compressed", "utf8", "limit", "broken"]) {
    mode = value;
    const { items } = await extractStructured(request(url));
    assert.deepEqual(items[0].error, { code: "PROVIDER_REJECTED", message: "Provider rejected the request.", providerStatus: 422, providerRequestId: "req_fallback" });
  }
  assert.equal(hits, 8);
});

test("error body budget accepts the exact boundary and cancels oversized or hanging streams", async t => {
  let mode = "exact"; let closed = 0; let hits = 0; let release;
  const streamsClosed = new Promise(resolve => { release = resolve; });
  const exact = JSON.stringify({ message: "Useful error", padding: "" });
  const body = JSON.stringify({ message: "Useful error", padding: "x".repeat(16_384 - Buffer.byteLength(exact)) });
  assert.equal(Buffer.byteLength(body), 16_384);
  const url = await fixture(t, (r, s) => {
    hits++; r.resume(); s.on("close", () => { if (++closed === 3) release(); }); s.writeHead(429);
    if (mode === "exact") s.end(body);
    else if (mode === "over") s.write(body + " ");
    else { s.flushHeaders(); s.write("{"); }
  });
  assert.equal((await extractStructured(request(url))).items[0].error.providerError.message, "Useful error");
  mode = "over";
  assert.equal((await extractStructured(request(url))).items[0].error.code, "RATE_LIMITED");
  mode = "hang";
  const { items } = await extractStructured({ ...request(url), timeoutMs: 80 });
  assert.equal(items[0].error.code, "TIMEOUT");
  await streamsClosed;
  assert.equal(hits, 3); assert.equal(closed, 3);
});

test("safe detail strings and validation messages survive; arbitrary objects and input echoes do not", async () => {
  for (const [detail, expected] of [["Unsupported document setting", "Unsupported document setting"], [[{ msg: "Unknown document field", input: "never-return-input", ctx: { error: "never-return-ctx" } }], "Unknown document field"]]) {
    const adapter = createMistralAdapter(async () => ({ status: 422, bodyText: JSON.stringify({ detail }) }));
    const result = await createRuntime(new Map([["mistral", adapter]]))(request());
    assert.deepEqual(result.items[0].error.providerError, { message: expected });
  }
  const adapter = createMistralAdapter(async () => ({ status: 422, bodyText: JSON.stringify({ detail: { message: "not-supported" }, code: 123, type: [], param: null }) }));
  assert.equal((await createRuntime(new Map([["mistral", adapter]]))(request())).items[0].error.providerError, undefined);
});

test("runtime re-sanitizes adapter diagnostics across all input URLs and bounds strings", async () => {
  const req = request(); req.prompt = "private custom prompt";
  req.inputs.push({ url: "https://other.example/b?token=other-private-token", kind: "image", id: "caller-id" });
  const raw = `${req.apiKey} ${encodeURIComponent(req.apiKey)} ${req.inputs[0].url} private-signature ${encodeURIComponent(req.inputs[1].url)} other-private-token ${req.prompt}`;
  const run = createRuntime(new Map([["mistral", { provider: "mistral", execute: async () => ({ kind: "error", error: { code: "PROVIDER_REJECTED", message: "unsafe overwritten", providerStatus: 422, providerRequestId: req.apiKey, providerError: { message: raw, type: "x".repeat(1100), code: "safe_code", param: req.inputs[0].url, extra: "never" } } }) }]]));
  const result = await run(req);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /probe-private-key|private-signature|other-private-token|https|private custom prompt|unsafe overwritten|never/);
  assert.equal(result.items[0].error.providerRequestId, undefined);
  assert.equal(result.items[0].error.providerError.type.length, 1024);
  assert.equal(result.items[0].error.providerError.code, "safe_code");
  assert.equal(result.items[1].id, "caller-id");
  assert.equal(result.items[0].error.message, "Provider rejected the request.");
});

test("HTTP diagnostics survive a failed item while the next input still succeeds", async t => {
  let hits = 0;
  const url = await fixture(t, (r, s) => {
    r.resume(); if (++hits === 1) { s.writeHead(422); s.end('{"message":"Invalid document"}'); }
    else s.end('{"document_annotation":"{}"}');
  });
  const req = request(url); req.inputs = [req.inputs[0], req.inputs[0]];
  const result = await extractStructured(req);
  assert.deepEqual(result.items.map(item => item.status), ["error", "success"]);
  assert.equal(result.items[0].error.providerError.message, "Invalid document");
  assert.equal(hits, 2);
});

test("credential echoes, query fragments, controls and unsafe request IDs are filtered", async () => {
  const req = request(); req.apiKey = " private-key-with-padding ";
  const adapter = createMistralAdapter(async () => ({ status: 422, requestId: "private-key-with-padding", bodyText: JSON.stringify({
    message: "Reason: private-key-with-padding; Bearer something-private; ?signature=private-signature\nTry again.",
    type: "invalid_request_error", param: { nested: "never-return" },
  }) }));
  const result = await createRuntime(new Map([["mistral", adapter]]))(req);
  const error = result.items[0].error;
  assert.equal(error.providerRequestId, undefined);
  assert.equal(error.providerError.type, "invalid_request_error");
  assert.match(error.providerError.message, /Reason:/);
  assert.doesNotMatch(JSON.stringify(error), /private-key|something-private|signature=|private-signature|never-return|\\n/);
});
