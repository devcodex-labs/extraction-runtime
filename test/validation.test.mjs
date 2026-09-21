import assert from "node:assert/strict";
import test from "node:test";
import { createRuntime } from "../dist/structured/runtime.js";
import { ExtractionRuntimeError } from "../dist/index.js";

const base = () => ({ provider: "mistral", model: "mistral-ocr-4-1", apiKey: "test", timeoutMs: 1000, schema: { type: "object" }, inputs: [{ url: "https://files.example/a", kind: "document" }] });

test("call-level validation rejects without provider attempts", async () => {
  let attempts = 0;
  const run = createRuntime(new Map([["mistral", { provider: "mistral", execute: async () => { attempts++; return { kind: "annotation", annotation: "{}" }; } }]]));
  const cycle = {}; cycle.self = cycle;
  const cases = [
    [null, "INVALID_ARGUMENT"], [{ ...base(), inputs: [] }, "INVALID_ARGUMENT"],
    [{ ...base(), provider: "other" }, "UNSUPPORTED_PROVIDER"], [{ ...base(), model: "latest" }, "UNSUPPORTED_MODEL"],
    ...["", " ", "key\r\nInjected: value", 3].map(apiKey => [{ ...base(), apiKey }, "INVALID_PROVIDER_CONFIG"]),
    ...[0, -1, 1.5, NaN, Infinity, "10"].map(timeoutMs => [{ ...base(), timeoutMs }, "INVALID_PROVIDER_CONFIG"]),
    ...["ftp://a", "https://u:p@a", "https://a?", "https://a#", "https://a/v1/ocr", "https://a/prefix/v1/ocr/extra"].map(baseUrl => [{ ...base(), baseUrl }, "INVALID_PROVIDER_CONFIG"]),
    ...[[], [-1], [1.5], [NaN], [Infinity], "", "3-1", "0,", "1.5", "9007199254740992"].map(pages => [{ ...base(), providerOptions: { pages } }, "INVALID_PROVIDER_CONFIG"]),
    [{ ...base(), providerOptions: { unknown: true } }, "INVALID_PROVIDER_CONFIG"],
    ...[null, [], { type: "string" }, ...[undefined, NaN, Infinity, 1n, () => {}, Symbol(), new Date(), cycle].map(x => ({ type: "object", x }))].map(schema => [{ ...base(), schema }, "INVALID_SCHEMA"]),
    [{ ...base(), prompt: 1 }, "INVALID_ARGUMENT"],
  ];
  for (const [request, code] of cases) await assert.rejects(run(request), error => error.code === code && !error.cause);
  assert.equal(attempts, 0);
});

test("invalid input slots preserve order and string ids; no generated ids", async () => {
  let attempts = 0;
  const run = createRuntime(new Map([["mistral", { provider: "mistral", execute: async () => { attempts++; return { kind: "annotation", annotation: "{}" }; } }]]));
  const good = base().inputs[0];
  const inputs = [null, { ...good, id: 4 }, { ...good, url: "file:///a", id: "keep" }, { ...good, kind: "pdf" }, { ...good, url: "https://u:p@a" }, { ...good, id: "" }, good, { ...good, id: "same" }, { ...good, id: "same" }];
  const { items } = await run({ ...base(), inputs });
  assert.deepEqual(items.map(i => i.index), inputs.map((_, i) => i));
  assert.deepEqual(items.map(i => i.status), [...Array(5).fill("error"), ...Array(4).fill("success")]);
  assert.equal(attempts, 4);
  assert.equal(items[2].id, "keep");
  assert.equal(items[5].id, "");
  assert.equal("id" in items[1], false);
  assert.equal("id" in items[6], false);
});

test("schema arrays reject hooks, accessors, holes and forbidden values without invoking them", async () => {
  let attempts = 0; let hooks = 0;
  const run = createRuntime(new Map([["mistral", { provider: "mistral", execute: async () => { attempts++; return { kind: "annotation", annotation: "{}" }; } }]]));
  const serialized = ['name']; serialized.toJSON = () => { hooks++; return ['changed']; };
  const iterated = [Infinity]; iterated[Symbol.iterator] = function* () { hooks++; yield 'safe'; };
  const accessor = ['name']; Object.defineProperty(accessor, '0', { get() { hooks++; return 'changed'; } });
  const custom = ['name']; Object.setPrototypeOf(custom, { toJSON() { hooks++; return []; } });
  const hidden = ['name']; Object.defineProperty(hidden, '0', { enumerable: false });
  const extra = ['name']; extra.metadata = 'ignored-by-JSON';
  const cycle = []; cycle.push(cycle);
  const cases = [serialized, iterated, accessor, custom, hidden, extra, cycle, Array(1), [undefined], [Infinity], [NaN], [1n], [Symbol()], [() => {}]];
  for (const value of cases) {
    await assert.rejects(run({ ...base(), schema: { type: 'object', enum: value } }), error => error instanceof ExtractionRuntimeError && error.code === 'INVALID_SCHEMA');
  }
  const schema = { properties: {} };
  Object.defineProperty(schema, 'type', { enumerable: true, get() { hooks++; return 'object'; } });
  await assert.rejects(run({ ...base(), schema }), error => error.code === 'INVALID_SCHEMA');
  assert.equal(hooks, 0); assert.equal(attempts, 0);
});

test("schema snapshots preserve plain JSON, special keys and frozen or null-prototype arrays", async () => {
  const required = Object.freeze(['name']);
  const values = [null, true, 1, 'text', [], {}]; Object.setPrototypeOf(values, null);
  const special = JSON.parse('{"__proto__":{"type":"string"},"constructor":{"enum":["x"]}}');
  const schema = { type: 'object', required, properties: special, enum: values };
  const expected = JSON.parse(JSON.stringify(schema));
  const run = createRuntime(new Map([["mistral", { provider: "mistral", execute: async (_input, context) => {
    assert.deepEqual(JSON.parse(JSON.stringify(context.schema)), expected);
    assert.notEqual(context.schema.required, required);
    assert.equal(Object.hasOwn(context.schema.properties, '__proto__'), true);
    return { kind: 'annotation', annotation: '{}' };
  } }]]));
  assert.equal((await run({ ...base(), schema })).items[0].status, 'success');
});

test("schema snapshot never re-reads checked proxy values through serialization", async () => {
  let reads = 0;
  const values = new Proxy(['name'], { get() { reads++; throw new Error('Must not read or serialize original'); } });
  const run = createRuntime(new Map([["mistral", { provider: "mistral", execute: async (_input, context) => {
    assert.deepEqual(context.schema.required, ['name']);
    return { kind: 'annotation', annotation: '{}' };
  } }]]));
  assert.equal((await run({ ...base(), schema: { type: 'object', required: values } })).items[0].status, 'success');
  assert.equal(reads, 0);
});

test("throwing input getters, proxies and array slots stay isolated and retain safe ids", async () => {
  let attempts = 0;
  const run = createRuntime(new Map([["mistral", { provider: "mistral", execute: async () => { attempts++; return { kind: 'annotation', annotation: '{}' }; } }]]));
  const bad = () => { throw new Error('synthetic-private-detail'); };
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const good = { ...base().inputs[0], id: 'last' };
  const inputs = [
    { ...good, id: 'keep-url', get url() { return bad(); } },
    { ...good, id: 'keep-kind', get kind() { return bad(); } },
    { ...good, get id() { return bad(); } },
    new Proxy(good, { get: bad }), revoked.proxy, null, good,
  ];
  Object.defineProperty(inputs, '5', { get: bad });
  inputs[Symbol.iterator] = bad;
  const { items } = await run({ ...base(), inputs });
  assert.deepEqual(items.map(i => i.index), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(items.map(i => i.status), [...Array(6).fill('error'), 'success']);
  for (const item of items.slice(0, 6)) assert.deepEqual(item.error, { code: 'INVALID_INPUT', message: 'Invalid extraction input.' });
  assert.equal(items[0].id, 'keep-url'); assert.equal(items[1].id, 'keep-kind');
  for (const item of items.slice(2, 6)) assert.equal('id' in item, false);
  assert.equal(attempts, 1); assert.doesNotMatch(JSON.stringify(items), /synthetic-private-detail/);
});

test("public configuration read failures become typed call errors before attempts", async () => {
  let attempts = 0;
  const run = createRuntime(new Map([["mistral", { provider: "mistral", execute: async () => { attempts++; return { kind: 'annotation', annotation: '{}' }; } }]]));
  for (const [key, code] of [['inputs', 'INVALID_ARGUMENT'], ['provider', 'UNSUPPORTED_PROVIDER'], ['model', 'UNSUPPORTED_MODEL'], ['apiKey', 'INVALID_PROVIDER_CONFIG'], ['baseUrl', 'INVALID_PROVIDER_CONFIG'], ['timeoutMs', 'INVALID_PROVIDER_CONFIG'], ['providerOptions', 'INVALID_PROVIDER_CONFIG'], ['schema', 'INVALID_SCHEMA'], ['prompt', 'INVALID_ARGUMENT']]) {
    const request = base(); Object.defineProperty(request, key, { get() { throw new Error('private-detail'); } });
    await assert.rejects(run(request), error => error instanceof ExtractionRuntimeError && error.code === code && !JSON.stringify(error).includes('private-detail') && !error.cause);
  }
  await assert.rejects(run({ ...base(), providerOptions: { get pages() { throw new Error('private-detail'); } } }), error => error.code === 'INVALID_PROVIDER_CONFIG');
  assert.equal(attempts, 0);
});

test("configuration and pages getters are snapshotted once", async () => {
  let keyReads = 0; let pageReads = 0;
  const pages = [0]; Object.defineProperty(pages, '0', { get() { return pageReads++ === 0 ? 0 : Infinity; } });
  const request = { ...base(), get apiKey() { keyReads++; return 'test'; }, providerOptions: { pages } };
  const run = createRuntime(new Map([["mistral", { provider: "mistral", execute: async (_input, context) => {
    assert.equal(context.headers.Authorization, 'Bearer test');
    assert.deepEqual(context.providerOptions.pages, [0]);
    return { kind: 'annotation', annotation: '{}' };
  } }]]));
  assert.equal((await run(request)).items[0].status, 'success');
  assert.equal(keyReads, 1); assert.equal(pageReads, 1);
});
