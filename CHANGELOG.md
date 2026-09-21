# Changelog

## 1.0.0 (Unreleased)

- Establish 1.0.0 as the initial stable release version; it has not been published.
- Provide a consumer-only README with an executable JavaScript quickstart.

- Reject schema array serialization hooks, validate UTF-8 before response decoding, and isolate input property-read errors without stopping later inputs.

- Add URL-only `extractStructured` and the offline `listExtractionModels` catalog.
- Add the fixed `mistral-ocr-4-1` adapter, serial batches, typed errors, request snapshots, and per-item deadlines.
- Use one native HTTP request per valid input; no retries, redirects, fallback models, or continuation.
- Preserve `extract`, `detectFileType`, and `registerParser` as deprecated, compatible legacy APIs.
- Do not perform local business-schema validation, repair, or partial-result classification.
- Add opt-in document/image live verification, Node 20/22/24 CI, and Node 22/npm 11 OIDC publishing checks.
- The pre-review candidate passed document and image live verification on 2026-09-21; review fixes were validated offline. Final-candidate checks, trusted-publisher verification and separate release authorization remain required.

## 0.1.0

- Initial extraction runtime package.
- Added built-in parsers for TXT, Markdown, JSON, CSV, and HTML.
- Added GitHub Actions workflows for CI and tag-based npm publishing.
