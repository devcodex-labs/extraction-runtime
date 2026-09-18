# extraction-runtime

`@devcodex-labs/extraction-runtime` is a small, extensible runtime for parsing files and extracting text, metadata, and structured sections.

## Install

```sh
npm install @devcodex-labs/extraction-runtime
```

## Usage

```ts
import { extract } from "@devcodex-labs/extraction-runtime";

const result = await extract("./README.md");

console.log(result.text);
console.log(result.metadata);
```

## Supported Inputs

- Local file paths
- `URL` objects that point to local files
- `Buffer`, `Uint8Array`, and `ArrayBuffer`
- Node.js readable streams

## Built-In Parsers

- Plain text: `.txt`
- Markdown: `.md`, `.markdown`
- JSON: `.json`
- CSV: `.csv`
- HTML: `.html`, `.htm`

## API

### `extract(input, options)`

Extracts text, metadata, and structured sections from a file-like input.

```ts
const result = await extract(buffer, {
  filename: "data.json",
  mimeType: "application/json"
});
```

### `detectFileType(input, options)`

Detects the likely file type from filename, MIME type, and lightweight content sniffing.

### `registerParser(parser)`

Registers a parser at runtime.

```ts
import { registerParser } from "@devcodex-labs/extraction-runtime";

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

## Publishing

Versions are published from GitHub Actions when a semver tag is pushed:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The publish workflow is configured for npm trusted publishing with GitHub Actions OIDC. Configure the package trusted publisher on npm before pushing the first release tag.
