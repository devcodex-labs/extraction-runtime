import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { extractStructured } from "../dist/index.js";
import { withDeadline } from "../dist/internal/http.js";

const req = baseUrl => ({ provider: "mistral", model: "mistral-ocr-4-1", apiKey: "test-key", baseUrl, timeoutMs: 1000, schema: { type: "object" }, inputs: [{ url: "https://files.example/a?private=yes", kind: "document" }] });

async function fixture(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => {
    const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed;
    assert.equal(server.listening, false);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function countRequests(t) {
  let count = 0;
  for (const api of [http, https]) {
    const original = api.request;
    t.mock.method(api, "request", function (...args) { count++; return original.apply(this, args); });
  }
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return () => count;
}

test("real transport sends UTF-8 body and never follows or retries HTTP failures", async t => {
  const count = countRequests(t); let hits = 0; let targetHits = 0; let status = 200;
  const target = await fixture(t, (_r, s) => { targetHits++; s.end(); });
  const source = await fixture(t, async (r, s) => {
    hits++;
    const chunks = []; for await (const chunk of r) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    assert.equal(r.method, "POST"); assert.equal(r.url, "/prefix/v1/ocr");
    assert.equal(Number(r.headers["content-length"]), body.length);
    assert.equal(r.headers["accept-encoding"], "identity");
    assert.equal(JSON.parse(body).document_annotation_prompt, "中文");
    s.writeHead(status, { Location: target.url, "x-request-id": "test-key https://files.example/a?private=yes" });
    s.end(status === 200 ? '{"document_annotation":"{}"}' : "test-key private=yes");
  });
  for (const next of [200,301,302,307,308,413,415,421,429,500]) {
    status = next;
    const result = await extractStructured({ ...req(source.url + "/prefix"), prompt: "中文" });
    assert.equal(result.items[0].status, next === 200 ? "success" : "error");
    if (next !== 200) assert.equal(result.items[0].error.code, next === 429 ? "RATE_LIMITED" : next >= 500 ? "UNKNOWN_PROVIDER_ERROR" : "PROVIDER_REJECTED");
    assert.doesNotMatch(JSON.stringify(result), /test-key|private=yes|https/);
  }
  assert.equal(hits, 10); assert.equal(count(), 10); assert.equal(targetHits, 0);
});

test("response truncation is network failure; full invalid JSON and compression are protocol failures", async t => {
  let mode = "truncate";
  const f = await fixture(t, (_r, s) => {
    if (mode === "truncate") { s.writeHead(200, { "Content-Length": "1000" }); s.write('{"document_annotation":'); setImmediate(() => s.destroy()); }
    else if (mode === "compress") { s.writeHead(200, { "Content-Encoding": "gzip" }); s.end("not-gzip"); }
    else s.end("not-json");
  });
  for (const [value, code] of [["truncate","NETWORK_ERROR"],["invalid","UNKNOWN_PROVIDER_ERROR"],["compress","UNKNOWN_PROVIDER_ERROR"]]) {
    mode = value; const result = await extractStructured(req(f.url)); assert.equal(result.items[0].error.code, code);
  }
});

test("timeout aborts a hanging body before continuing the next input", async t => {
  const count = countRequests(t); let hits = 0; let firstClosed;
  const closed = new Promise(resolve => { firstClosed = resolve; });
  const f = await fixture(t, (_r, s) => {
    if (++hits === 1) { s.writeHead(200); s.write("{"); s.on("close", firstClosed); }
    else s.end('{"document_annotation":"{}"}');
  });
  const r = req(f.url); r.timeoutMs = 80; r.inputs = [r.inputs[0], r.inputs[0]];
  const result = await extractStructured(r);
  await closed;
  assert.deepEqual(result.items.map(i => i.status), ["error", "success"]);
  assert.equal(result.items[0].error.code, "TIMEOUT"); assert.equal(count(), 2);
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(hits, 2);
});

test("DNS, connection and TLS errors create one ClientRequest each", async t => {
  const count = countRequests(t);
  const originalLookup = dns.lookup;
  t.mock.method(dns, "lookup", (hostname, ...args) => {
    if (hostname === "lookup-failure.invalid") { const cb = args.at(-1); queueMicrotask(() => cb(Object.assign(new Error("private"), { code: "ENOTFOUND" }))); return; }
    return originalLookup(hostname, ...args);
  });
  const f = await fixture(t, (_r, s) => s.end());
  const closedServer = http.createServer(); closedServer.listen(0, "127.0.0.1"); await once(closedServer, "listening");
  const unused = closedServer.address().port; await new Promise(resolve => closedServer.close(resolve));
  for (const url of ["http://lookup-failure.invalid", `http://127.0.0.1:${unused}`, f.url.replace("http:", "https:")]) {
    const result = await extractStructured(req(url)); assert.equal(result.items[0].error.code, "NETWORK_ERROR");
  }
  assert.equal(count(), 3);
});

test("deadline timer segments values above Node timer maximum", async t => {
  let now = 0; const scheduled = []; const cleared = [];
  t.mock.method(performance, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (fn, delay) => { const task = { fn, delay }; scheduled.push(task); return task; });
  t.mock.method(globalThis, "clearTimeout", timer => cleared.push(timer));
  let release; const gate = new Promise(resolve => { release = resolve; });
  const pending = withDeadline(2_147_483_648, async scope => { await gate; scope.checkDeadline(); return "ok"; });
  assert.equal(scheduled[0].delay, 2_147_483_647);
  now = 2_147_483_647; scheduled[0].fn(); assert.equal(scheduled[1].delay, 1);
  release(); assert.equal(await pending, "ok"); assert.equal(cleared.at(-1), scheduled[1]);
});

test("invalid UTF-8 is a per-item protocol error; valid split text and U+FFFD survive", async t => {
  const count = countRequests(t); let hits = 0;
  const malformed = [[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe4, 0xb8]];
  const text = '\u4e2d\u6587\ufffd';
  const f = await fixture(t, (r, s) => {
    r.resume();
    const index = hits++;
    s.writeHead(200, { 'Content-Type': 'application/json' });
    if (index < malformed.length) {
      const envelope = Buffer.from(JSON.stringify({ document_annotation: '{"name":"X"}' }));
      const at = envelope.indexOf('X');
      s.end(Buffer.concat([envelope.subarray(0, at), Buffer.from(malformed[index]), envelope.subarray(at + 1)]));
    } else {
      const body = Buffer.from(JSON.stringify({ document_annotation: JSON.stringify({ name: text }) }));
      const split = body.indexOf(Buffer.from(text)) + 1;
      s.write(body.subarray(0, split));
      setImmediate(() => s.end(body.subarray(split)));
    }
  });
  const request = req(f.url); request.inputs = Array.from({ length: malformed.length + 1 }, () => request.inputs[0]);
  const { items } = await extractStructured(request);
  for (const item of items.slice(0, malformed.length)) {
    assert.equal(item.status, 'error');
    assert.deepEqual(item.error, { code: 'UNKNOWN_PROVIDER_ERROR', message: 'Invalid provider response.' });
  }
  assert.deepEqual(items.at(-1).data, { name: text });
  assert.equal(hits, 6); assert.equal(count(), 6);
});

test("public preflight rejects hooked schemas and continues after throwing input properties", async t => {
  const count = countRequests(t); let hits = 0;
  const f = await fixture(t, (r, s) => { hits++; r.resume(); s.end('{"document_annotation":"{}"}'); });
  const required = ['name']; required.toJSON = () => ['changed'];
  await assert.rejects(extractStructured({ ...req(f.url), schema: { type: 'object', required } }), error => error.code === 'INVALID_SCHEMA');
  assert.equal(count(), 0);
  const request = req(f.url);
  request.inputs.unshift({ kind: 'document', get url() { throw new Error('private-detail'); } });
  const { items } = await extractStructured(request);
  assert.equal(items[0].error.code, 'INVALID_INPUT');
  assert.equal(items[1].status, 'success');
  assert.deepEqual(items.map(i => i.index), [0, 1]);
  assert.equal(hits, 1); assert.equal(count(), 1);
  assert.doesNotMatch(JSON.stringify(items), /private-detail/);
});
