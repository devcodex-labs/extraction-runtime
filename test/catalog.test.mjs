import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { ExtractionRuntimeError, listExtractionModels } from "../dist/index.js";

test("lists the fixed model and exact public descriptor", () => {
  assert.deepEqual(listExtractionModels(), [{
    provider: "mistral",
    model: "mistral-ocr-4-1",
    name: "Mistral OCR 4.1",
    inputKinds: ["image", "document"],
    status: "active"
  }]);
});

test("each catalog snapshot is fresh and deeply readonly", () => {
  const first = listExtractionModels();
  const second = listExtractionModels();
  assert.notEqual(first, second);
  assert.notEqual(first[0], second[0]);
  assert.notEqual(first[0].inputKinds, second[0].inputKinds);
  for (const value of [first, first[0], first[0].inputKinds]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.throws(() => { first[0].model = "changed"; }, TypeError);
  assert.throws(() => { first[0].inputKinds.push("other"); }, TypeError);
  assert.throws(() => { first.pop(); }, TypeError);
  assert.deepEqual(listExtractionModels(), second);
});

test("import and catalog access read no credentials and attempt no network", () => {
  // Isolate built-in interception so it cannot affect other tests or consumers.
  const moduleUrl = new URL("../dist/index.js", import.meta.url).href;
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import http from "node:http";
    import https from "node:https";
    import net from "node:net";
    import tls from "node:tls";
    import { syncBuiltinESMExports } from "node:module";
    let attempts = 0;
    const deny = () => { attempts++; throw new Error("Network forbidden"); };
    globalThis.fetch = deny;
    http.request = http.get = https.request = https.get = deny;
    net.connect = net.createConnection = tls.connect = deny;
    syncBuiltinESMExports();
    const env = process.env;
    process.env = new Proxy(env, {
      get(target, key) {
        if (String(key).startsWith("MISTRAL")) throw new Error("Credential read");
        return Reflect.get(target, key);
      }
    });
    const { listExtractionModels } = await import(${JSON.stringify(moduleUrl)});
    assert.equal(listExtractionModels().length, 1);
    assert.equal(listExtractionModels().length, 1);
    assert.equal(attempts, 0);
  `], { encoding: "utf8", timeout: 10_000 });
  assert.ifError(probe.error);
  assert.equal(probe.status, 0, probe.stderr);
});

test("call-level errors preserve standard Error behavior without extra context", () => {
  for (const code of ["INVALID_ARGUMENT", "UNSUPPORTED_PROVIDER", "UNSUPPORTED_MODEL",
    "INVALID_PROVIDER_CONFIG", "INVALID_SCHEMA"]) {
    const error = new ExtractionRuntimeError(code, "Invalid request.");
    assert.ok(error instanceof Error);
    assert.ok(error instanceof ExtractionRuntimeError);
    assert.equal(error.name, "ExtractionRuntimeError");
    assert.equal(error.message, "Invalid request.");
    assert.equal(error.code, code);
    assert.deepEqual(Object.keys(error).sort(), ["code", "name"]);
    assert.equal("cause" in error, false);
  }
});

test("package declares Node types and root declarations enforce public contracts", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.dependencies?.["@types/node"], "^20.19.0");
  assert.equal(packageJson.devDependencies?.["@types/node"], undefined);

  const filename = fileURLToPath(new URL("../catalog-type-probe.mts", import.meta.url)).replaceAll("\\", "/");
  const source = `
    import {
      extract, detectFileType, registerParser, listExtractionModels, ExtractionRuntimeError, extractStructured,
      type ExtractOptions, type ExtractionInput, type ExtractionResult, type ExtractionParser,
      type StructuredExtractionRequest, type StructuredExtractionResponse,
      type JsonObject, type JsonSchemaObject, type ItemErrorCode
    } from "./dist/index.js";
    const input: ExtractionInput = new Uint8Array();
    const options: ExtractOptions = { filename: "note.txt" };
    const legacy: Promise<ExtractionResult> = extract(input, options);
    detectFileType(input, options);
    const parser: ExtractionParser = { id: "test", parse: () => legacy };
    registerParser(parser);
    const schema = { type: "object" } satisfies JsonSchemaObject;
    const request: StructuredExtractionRequest = {
      provider: "mistral", model: "mistral-ocr-4-1", apiKey: "test-only",
      timeoutMs: 1000, schema, providerOptions: { pages: [0, 2] },
      inputs: [{ kind: "document", url: "https://example.invalid/a", id: "same" }]
    };
    const json: JsonObject = { nested: { values: [true, null, 1, "a"] } };
    interface Invoice { amount: number }
    const structured: Promise<StructuredExtractionResponse<Invoice>> = extractStructured<Invoice>(request);
    function use(result: StructuredExtractionResponse<Invoice>) {
      const item = result.items[0];
      if (item.status === "success") {
        const amount: number = item.data.amount;
        // @ts-expect-error success has no error
        item.error;
      } else {
        const code: ItemErrorCode = item.error.code;
        // @ts-expect-error failure has no business data
        item.data;
      }
    }
    // @ts-expect-error model is a fixed identifier
    const wrongModel: StructuredExtractionRequest = { ...request, model: "latest" };
    // @ts-expect-error only pages is allowed
    const wrongOptions: StructuredExtractionRequest = { ...request, providerOptions: { retry: 1 } };
    // @ts-expect-error input id is a string
    const wrongId: StructuredExtractionRequest = { ...request, inputs: [{ url: "https://example.invalid", kind: "image", id: 1 }] };
    // @ts-expect-error inputs is readonly
    request.inputs.push({ kind: "image", url: "https://example.invalid" });
    // @ts-expect-error descriptor is readonly
    listExtractionModels()[0].name = "changed";
    // @ts-expect-error generic cannot be a scalar
    type InvalidResponse = StructuredExtractionResponse<string>;
    // @ts-expect-error call-level error codes are closed
    new ExtractionRuntimeError("OTHER", "Invalid request.");
  `;
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: false
  };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
    path === filename
      ? ts.createSourceFile(path, source, languageVersion, true)
      : originalGetSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([filename], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")), []);
});
