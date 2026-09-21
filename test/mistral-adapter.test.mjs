import assert from "node:assert/strict";
import test from "node:test";
import { listExtractionModels } from "../dist/index.js";
import { createMistralAdapter, providerRegistry } from "../dist/providers/mistral.js";
import { createRuntime } from "../dist/structured/runtime.js";

const base = () => ({ provider: "mistral", model: "mistral-ocr-4-1", apiKey: " test ", timeoutMs: 1000, schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false }, inputs: [{ kind: "document", url: "https://files.example/a?signature=secret" }] });
const runtime = transport => createRuntime(new Map([["mistral", createMistralAdapter(transport)]]));

test("catalog and static registry agree in both directions", () => {
  assert.deepEqual([...providerRegistry.keys()].sort(), [...new Set(listExtractionModels().map(m => m.provider))].sort());
  for (const [id, adapter] of providerRegistry) assert.equal(adapter.provider, id);
});

test("exact document/image mapping, optional omission, key and schema preservation", async () => {
  const seen = [];
  const run = runtime(async (url, headers, body) => { seen.push({ url: url.href, headers, body: JSON.parse(body) }); return { status: 200, bodyText: '{"document_annotation":"{}","pages":[{"markdown":"private"}]}' }; });
  const req = base();
  await run({ ...req, prompt: "Extract title", providerOptions: { pages: [2, 0, 2] } });
  assert.deepEqual(seen[0], {
    url: "https://api.mistral.ai/v1/ocr",
    headers: { Authorization: "Bearer  test ", "Content-Type": "application/json", Accept: "application/json", "Accept-Encoding": "identity" },
    body: { model: req.model, document: { type: "document_url", document_url: req.inputs[0].url }, document_annotation_format: { type: "json_schema", json_schema: { name: "extraction_result", strict: true, schema: req.schema } }, include_image_base64: false, include_blocks: false, document_annotation_prompt: "Extract title", pages: [2, 0, 2] },
  });
  const output = await run({ ...req, baseUrl: "https://gateway.example/mistral///", inputs: [{ ...req.inputs[0], kind: "image" }] });
  assert.equal(seen[1].url, "https://gateway.example/mistral/v1/ocr");
  assert.deepEqual(seen[1].body.document, { type: "image_url", image_url: req.inputs[0].url });
  assert.equal("pages" in seen[1].body, false); assert.equal("document_annotation_prompt" in seen[1].body, false);
  assert.deepEqual(output.items[0].data, {}); assert.equal("pages" in output.items[0], false);
  await run({ ...req, providerOptions: { pages: "0,2-4" } });
  assert.equal(seen[2].body.pages, "0,2-4");
});

test("HTTP mapping uses status only and malformed envelopes stay protocol errors", async () => {
  for (const [status, code] of [[301,"PROVIDER_REJECTED"],[401,"AUTHENTICATION_FAILED"],[403,"AUTHENTICATION_FAILED"],[408,"PROVIDER_REJECTED"],[413,"PROVIDER_REJECTED"],[415,"PROVIDER_REJECTED"],[421,"PROVIDER_REJECTED"],[422,"PROVIDER_REJECTED"],[429,"RATE_LIMITED"],[500,"UNKNOWN_PROVIDER_ERROR"],[504,"UNKNOWN_PROVIDER_ERROR"]]) {
    let attempts = 0;
    const result = await runtime(async () => { attempts++; return { status, bodyText: "secret file format unsupported" }; })(base());
    assert.equal(result.items[0].error.code, code); assert.equal(result.items[0].error.providerStatus, status); assert.equal(attempts, 1);
    assert.doesNotMatch(JSON.stringify(result), /secret|signature/);
  }
  for (const bodyText of ["not-json", "[]", "null", "1"]) {
    const result = await runtime(async () => ({ status: 200, bodyText }))(base());
    assert.equal(result.items[0].error.code, "UNKNOWN_PROVIDER_ERROR");
  }
});

test("unknown schema keyword is sent once; no invented Mistral completion marker", async () => {
  let attempts = 0;
  const run = runtime(async (_url, _headers, body) => { attempts++; assert.equal(JSON.parse(body).document_annotation_format.json_schema.schema.futureKeyword, true); return { status: 422 }; });
  const req = { ...base(), schema: { type: "object", futureKeyword: true } };
  assert.equal((await run(req)).items[0].error.code, "PROVIDER_REJECTED"); assert.equal(attempts, 1);
  const result = await runtime(async () => ({ status: 200, bodyText: '{"document_annotation":"{}","finish_reason":"length"}' }))(base());
  assert.equal(result.items[0].status, "success");
});
