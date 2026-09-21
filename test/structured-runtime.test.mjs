import assert from "node:assert/strict";
import test from "node:test";
import { createRuntime } from "../dist/structured/runtime.js";
import { TransportError } from "../dist/internal/http.js";
import { runSmoke } from "../scripts/mistral-live.mjs";

const request = () => ({ provider: "mistral", model: "mistral-ocr-4-1", apiKey: "secret", timeoutMs: 1000, schema: { type: "object", required: ["requiredField"] }, inputs: [{ url: "https://files.example/a?secret=yes", kind: "document" }] });
const runtime = execute => createRuntime(new Map([["mistral", { provider: "mistral", execute }]]));

test("annotation gates parse exactly once, never repair or validate business data", async () => {
  const cases = [[undefined, "STRUCTURED_OUTPUT_MISSING"], [null, "STRUCTURED_OUTPUT_MISSING"], [{}, "UNKNOWN_PROVIDER_ERROR"], [1, "UNKNOWN_PROVIDER_ERROR"], ["{", "STRUCTURED_OUTPUT_INVALID_JSON"], ["```json\n{}\n```", "STRUCTURED_OUTPUT_INVALID_JSON"], ["null", "STRUCTURED_OUTPUT_INVALID_SHAPE"], ["[]", "STRUCTURED_OUTPUT_INVALID_SHAPE"], ["42", "STRUCTURED_OUTPUT_INVALID_SHAPE"], [JSON.stringify("{}"), "STRUCTURED_OUTPUT_INVALID_SHAPE"]];
  for (const [annotation, code] of cases) {
    const result = await runtime(async () => ({ kind: "annotation", annotation }))(request());
    assert.equal(result.items[0].error.code, code);
  }
  const result = await runtime(async () => ({ kind: "annotation", annotation: '{"extra":[],"secret":"secret"}' }))(request());
  assert.deepEqual(result.items[0].data, { extra: [], secret: "secret" });
});

test("explicit incomplete wins, safe errors exclude adapter details and retain caller id", async () => {
  const r = request(); r.inputs[0].id = r.inputs[0].url;
  const outputs = [{ kind: "incomplete", reason: "provider-declared-incomplete", annotation: "{}" }, ...["UNSUPPORTED_FILE", "FILE_LIMIT_EXCEEDED", "RATE_LIMITED"].map(code => ({ kind: "error", error: { code, message: "secret", providerRequestId: r.inputs[0].url, providerStatus: 429 } }))];
  for (const output of outputs) {
    const { items } = await runtime(async () => output)(r);
    assert.equal(items[0].status, "error");
    assert.equal(items[0].id, r.inputs[0].id);
    assert.doesNotMatch(JSON.stringify(items[0].error), /secret|https/);
  }
});

test("batch stays serial, snapshots all caller values and continues after failure", async () => {
  const r = request(); r.inputs = [0, 1, 2].map(i => ({ ...r.inputs[0], id: `${i}` })); r.providerOptions = { pages: [0] };
  let release; const gate = new Promise(resolve => { release = resolve; });
  const seen = []; let active = 0;
  const run = runtime(async (input, context) => {
    assert.equal(++active, 1);
    seen.push([input.id, input.url, context.providerOptions.pages, context.schema, context.prompt]);
    try { if (input.index === 0) await gate; if (input.index === 1) throw new TransportError("NETWORK_ERROR"); return { kind: "annotation", annotation: "{}" }; }
    finally { active--; }
  });
  const pending = run(r);
  r.inputs[1].id = "changed"; r.inputs[1].url = "https://changed.example"; r.inputs.pop(); r.providerOptions.pages.push(9); r.schema.required.push("changed"); r.prompt = "changed";
  release();
  const { items } = await pending;
  assert.deepEqual(items.map(i => i.status), ["success", "error", "success"]);
  assert.deepEqual(items.map(i => i.id), ["0", "1", "2"]);
  assert.equal(items[1].error.code, "NETWORK_ERROR");
  assert.equal(seen[1][1], "https://files.example/a?secret=yes");
  assert.deepEqual(seen[1][2], [0]); assert.deepEqual(seen[1][3].required, ["requiredField"]); assert.equal(seen[1][4], undefined);
});

test("independent calls overlap without a global lock", async () => {
  let active = 0; let release; const gate = new Promise(resolve => { release = resolve; });
  const run = runtime(async () => { if (++active === 2) release(); await gate; return { kind: "annotation", annotation: "{}" }; });
  await Promise.all([run(request()), run(request())]);
  assert.equal(active, 2);
});

test("deadline wins after synchronous annotation parsing", async t => {
  const original = JSON.parse;
  t.mock.method(JSON, "parse", function (value, ...args) {
    const parsed = original(value, ...args);
    if (value === '{"slow":true}') { const end = performance.now() + 40; while (performance.now() < end) {} }
    return parsed;
  });
  const result = await runtime(async () => ({ kind: "annotation", annotation: '{"slow":true}' }))({ ...request(), timeoutMs: 20 });
  assert.equal(result.items[0].error.code, "TIMEOUT");
});

test("live script preflights both inputs and distinguishes PASS/FAILED/NOT RUN offline", async () => {
  const env = { MISTRAL_API_KEY: "test-secret", MISTRAL_OCR_TEST_DOCUMENT_URL: "https://files.example/a?private=yes", MISTRAL_OCR_TEST_IMAGE_URL: "https://files.example/b" };
  const logs = []; let calls = 0;
  const good = async r => { calls++; assert.equal(r.model, "mistral-ocr-4-1"); return { items: [{ status: "success", data: { text: "test-secret" } }] }; };
  for (const key of Object.keys(env)) {
    const missing = { ...env }; delete missing[key];
    assert.equal(await runSmoke(missing, good, line => logs.push(line)), 2);
  }
  assert.equal(await runSmoke({ ...env, MISTRAL_API_KEY: "bad\r\nkey" }, good, line => logs.push(line)), 2);
  assert.equal(calls, 0);
  assert.equal(await runSmoke(env, good, line => logs.push(line)), 0); assert.equal(calls, 2);
  for (const code of ["TIMEOUT", "AUTHENTICATION_FAILED", "NETWORK_ERROR"]) {
    let count = 0;
    assert.equal(await runSmoke(env, async () => ++count === 1 ? { items: [{ status: "error", error: { code } }] } : { items: [{ status: "success", data: { text: "ok" } }] }, line => logs.push(line)), 1);
    assert.equal(count, 2);
  }
  let count = 0;
  assert.equal(await runSmoke(env, async () => { count++; throw new Error("test-secret"); }, line => logs.push(line)), 1); assert.equal(count, 2);
  assert.equal(await runSmoke(env, async () => ({ items: [{ status: "success", data: {} }] }), line => logs.push(line)), 1);
  assert.doesNotMatch(logs.join("\n"), /test-secret|private=yes|https/);
});
