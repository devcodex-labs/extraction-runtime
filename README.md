# extraction-runtime

**English** | [简体中文](README.zh-CN.md)

`@devcodex/extraction-runtime` extracts structured JSON from document and image URLs using Mistral OCR. It also provides local text parsers for TXT, Markdown, JSON, CSV, and HTML.

## Contents

- [Install](#install)
- [Structured Extraction](#structured-extraction)
- [Configuration](#configuration)
- [Responses and Errors](#responses-and-errors)
- [Runtime Boundaries](#runtime-boundaries)
- [Local Text Extraction](#local-text-extraction)

## Install

```sh
npm install @devcodex/extraction-runtime
```

Requires Node.js 20+. The package is ESM-only and ships TypeScript declarations together with the Node.js type definitions they reference. It has no runtime JavaScript dependencies.

## Structured Extraction

The model catalog is static, needs no credentials, and makes no network requests:

```js
import { listExtractionModels } from "@devcodex/extraction-runtime";

const models = listExtractionModels();
// [{ provider: "mistral", model: "mistral-ocr-4-1", name: "Mistral OCR 4.1",
//    inputKinds: ["image", "document"], status: "active" }]
```

Each invocation returns a fresh, deeply frozen catalog. `active` means supported by this adapter, not verified for your account.

### Extract a Document

Use the following as your application's `extract.mjs` entry point:

```js
import {
  extractStructured,
  ExtractionRuntimeError,
} from "@devcodex/extraction-runtime";

const apiKey = process.env.MISTRAL_API_KEY;
const documentUrl = process.env.INVOICE_URL;
if (!apiKey || !documentUrl) throw new Error("Provide a key and document URL.");

try {
  const result = await extractStructured({
    provider: "mistral",
    model: "mistral-ocr-4-1",
    apiKey,
    timeoutMs: 120_000,
    schema: {
      type: "object",
      properties: {
        invoiceNumber: { type: "string" },
        total: { type: "number" },
      },
      required: ["invoiceNumber", "total"],
      additionalProperties: false,
    },
    prompt: "Extract the invoice number and total.",
    inputs: [{ id: "invoice-1", kind: "document", url: documentUrl }],
    // providerOptions: { pages: [0] }, // Optional zero-based selection.
  });

  for (const item of result.items) {
    if (item.status === "success") {
      // Validate business rules before using the extracted value.
      console.log(item.index, item.id, item.data);
    } else {
      console.error(item.index, item.error.code, item.error.message);
    }
  }
} catch (error) {
  if (error instanceof ExtractionRuntimeError) {
    console.error(error.code, error.message); // Entire call rejected, zero requests.
  } else throw error;
}
```

Set your Mistral API key and a document URL that Mistral can access, then run the entry point. Requests use your Mistral account and may incur provider charges.

PowerShell:

```powershell
$env:MISTRAL_API_KEY = "YOUR_MISTRAL_API_KEY"
$env:INVOICE_URL = "https://your-host.example/invoice.pdf"
node extract.mjs
```

Bash or zsh:

```sh
export MISTRAL_API_KEY="YOUR_MISTRAL_API_KEY"
export INVOICE_URL="https://your-host.example/invoice.pdf"
node extract.mjs
```

For images use `kind: "image"` and an HTTP(S) image URL. For batches supply multiple entries in `inputs`; no separate batch method is needed. File accessibility, supported document formats and account limits are enforced by Mistral, not local file inspection.

In TypeScript, `extractStructured<Invoice>(request)` can describe the expected data shape. It does not validate extracted fields; apply your own business validation before relying on them.

## Configuration

| Field | Contract |
|---|---|
| `provider` / `model` | `mistral` / `mistral-ocr-4-1`; no `latest` alias |
| `apiKey` | Required nonblank string, valid as an HTTP header; sent as provided |
| `timeoutMs` | Required positive finite integer, milliseconds per valid input |
| `baseUrl` | Optional service root; default `https://api.mistral.ai` |
| `schema` | Plain JSON object with root `type: "object"`; basic serializability only |
| `prompt` | Optional string, forwarded unchanged |
| `providerOptions.pages` | Optional nonempty zero-based safe-integer array or range string such as `0,2-4` |
| `inputs` | Required nonempty array of `{ url, kind, id? }` |
| `url` | Absolute HTTP(S) string without embedded username/password |
| `kind` | `document` or `image` |
| `id` | Optional string; empty and duplicate strings are allowed |

No other provider option is accepted. Page values are not sorted, deduplicated, or expanded. A gateway prefix such as `https://gateway.example/mistral` becomes `https://gateway.example/mistral/v1/ocr`. Do not supply an operation URL, credentials, query, or fragment in `baseUrl`. A custom gateway receives your API key and request contents.

Schemas must contain plain JSON data. Custom serialization hooks, accessors, sparse arrays, and custom array prototypes are rejected before any request. Validated values are copied without invoking those hooks.

## Responses and Errors

The response has exactly one ordered item per input. `index` always identifies the original slot; a provided string `id` is echoed unchanged. Missing or invalid ids are not generated or coerced.

An input whose properties cannot be read produces `INVALID_INPUT` without stopping later inputs. An unreadable id is omitted; an already read string id is retained. Invalid UTF-8 in a complete provider response produces `UNKNOWN_PROVIDER_ERROR`, never silently replaced business text.

```json
{
  "items": [
    {
      "status": "success", "index": 0, "id": "invoice-1",
      "provider": "mistral", "model": "mistral-ocr-4-1",
      "data": { "invoiceNumber": "INV-001", "total": 42 }
    },
    {
      "status": "error", "index": 1,
      "provider": "mistral", "model": "mistral-ocr-4-1",
      "error": { "code": "RATE_LIMITED", "message": "Provider rate limit exceeded.", "providerStatus": 429 }
    }
  ]
}
```

Call-level failures reject with `ExtractionRuntimeError` before any request: `INVALID_ARGUMENT`, `UNSUPPORTED_PROVIDER`, `UNSUPPORTED_MODEL`, `INVALID_PROVIDER_CONFIG`, `INVALID_SCHEMA`.

| Item error | Meaning |
|---|---|
| `INVALID_INPUT` | Invalid URL, kind, id or input shape; no request for this slot |
| `NETWORK_ERROR` / `TIMEOUT` | Connection/stream failure or local deadline exceeded |
| `AUTHENTICATION_FAILED` / `RATE_LIMITED` | HTTP 401/403 or 429 |
| `PROVIDER_REJECTED` | 3xx or other 4xx, including 408/413/415/421 |
| `PROVIDER_RESPONSE_INCOMPLETE` | Explicit normalized provider incompletion; current Mistral OCR exposes no documented completion flag |
| `STRUCTURED_OUTPUT_MISSING` | Annotation absent or null |
| `STRUCTURED_OUTPUT_INVALID_JSON` | Annotation string is not valid JSON |
| `STRUCTURED_OUTPUT_INVALID_SHAPE` | Parsed annotation is not a nonnull, nonarray object |
| `UNKNOWN_PROVIDER_ERROR` | 5xx, invalid envelope, nonstring annotation, unsupported encoding or other protocol failure |
| `UNSUPPORTED_FILE` / `FILE_LIMIT_EXCEEDED` | Reserved codes; this version reports Mistral HTTP 413/415 as `PROVIDER_REJECTED` |

`providerStatus` is optional and comes only from HTTP status. `providerRequestId` is reserved but omitted in this version. Errors use fixed messages and never expose raw responses, keys, URLs, schema, prompt, or underlying causes. Caller `id` and business `data` are deliberately not sanitized; avoid logging sensitive values yourself.

## Runtime Boundaries

- Inputs are processed serially within one invocation; independent invocations may overlap. Input/config/schema snapshots are taken before the first await.
- Each valid input makes at most one native HTTP request attempt. There are no retries, redirect following, model fallback, repair, or automatic continuation. A failed item does not stop later inputs.
- Only `document_annotation` is parsed, exactly once, into object `data`. There is no local business-schema validation, field coercion, default filling, confidence, evidence checking, or `partial` status. A generic type describes your expectation, not a validation guarantee.
- The runtime sends file URLs to the provider; it does not fetch files itself, transform Office files, or accept local paths/bytes through `extractStructured`.
- Deadlines cover the single network exchange, complete response body, and parse checks. Expiry destroys local streams. Synchronous JSON parsing cannot be preempted, but an overdue result cannot become success. Local cancellation does not undo provider processing or charges.
- OCR pages/Markdown are received as part of the upstream response but are not exposed or retained after unpacking. There is no response-size cap; peak memory includes the full response, parsing temporaries, and accumulated batch data.

## Local Text Extraction

The following deprecated APIs remain compatible. They are separate from structured OCR and do not call Mistral.

### Usage

```ts
import { extract } from "@devcodex/extraction-runtime";

const result = await extract("./README.md");

console.log(result.text);
console.log(result.metadata);
```

### Supported Inputs

- Local file paths
- `URL` objects that point to local files
- `Buffer`, `Uint8Array`, and `ArrayBuffer`
- Node.js readable streams

### Built-In Parsers

- Plain text: `.txt`
- Markdown: `.md`, `.markdown`
- JSON: `.json`
- CSV: `.csv`
- HTML: `.html`, `.htm`

### Functions

#### `extract(input, options)`

Extracts text, metadata, and structured sections from a file-like input.

```ts
const result = await extract(buffer, {
  filename: "data.json",
  mimeType: "application/json"
});
```

#### `detectFileType(input, options)`

Detects the likely file type from filename, MIME type, and lightweight content sniffing.

#### `registerParser(parser)`

Registers a parser at runtime.

```ts
import { registerParser } from "@devcodex/extraction-runtime";

registerParser({
  id: "custom",
  extensions: [".custom"],
  async parse(context) {
    return {
      text: context.content.toString("utf8"),
      metadata: {},
      sections: [],
      pages: [],
      warnings: [],
      source: context.source
    };
  }
});
```
