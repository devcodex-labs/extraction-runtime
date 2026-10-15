# Changelog

## 1.0.2 (2026-10-15)

- Return bounded, sanitized upstream HTTP error details in optional `providerError`, and safe `providerRequestId` values when available.
- Preserve existing runtime codes/messages, HTTP status classification, deadlines and zero-retry behavior; cap error body reads at 16 KiB.

## 1.0.1 (2026-09-29)

- Disable embedded-image extraction for document OCR requests with `image_limit: 0`, while leaving image URL requests unchanged.
- Document the document-image response behavior in English and Simplified Chinese.

## 1.0.0 (2026-09-21)

- Establish 1.0.0 as the initial stable release version.
- Provide a consumer-only README with an executable JavaScript quickstart.
- Ship `@types/node` as a package dependency so clean TypeScript consumers can resolve the public legacy declarations.
- Preserve empty, multiline, spaced, and escaped quoted fields when parsing legacy CSV input.
- Publish the initial package under the `@devcodex/extraction-runtime` npm scope.

- Reject schema array serialization hooks, validate UTF-8 before response decoding, and isolate input property-read errors without stopping later inputs.

- Add URL-only `extractStructured` and the offline `listExtractionModels` catalog.
- Add the fixed `mistral-ocr-4-1` adapter, serial batches, typed errors, request snapshots, and per-item deadlines.
- Use one native HTTP request per valid input; no retries, redirects, fallback models, or continuation.
- Preserve `extract`, `detectFileType`, and `registerParser` as deprecated, compatible legacy APIs.
- Do not perform local business-schema validation, repair, or partial-result classification.
- Add opt-in document/image live verification, Node 20/22/24 CI, and Node 22/npm 11 OIDC publishing checks.
- The final candidate passed document and image live verification, trusted-publisher verification, and public consumer installation checks on 2026-09-21.

## 0.1.0

- Initial extraction runtime package.
- Added built-in parsers for TXT, Markdown, JSON, CSV, and HTML.
- Added GitHub Actions workflows for CI and tag-based npm publishing.
