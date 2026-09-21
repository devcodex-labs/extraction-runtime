import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { detectFileType, extract, registerParser } from "../dist/index.js";

// Keep legacy behavior covered through the public root after the module move.

test("extracts markdown headings", async () => {
  const result = await extract(Buffer.from("# Title\n\nHello"), { filename: "note.md" });

  assert.equal(result.source.parserId, "markdown");
  assert.equal(result.sections[0].title, "Title");
  assert.equal(result.text.includes("Hello"), true);
});

test("detects json from content", async () => {
  const detected = await detectFileType(Buffer.from("{\"ok\":true}"));

  assert.equal(detected.parserId, "json");
});

test("extracts csv metadata", async () => {
  const result = await extract(Buffer.from("name,age\nAda,36"), { filename: "people.csv" });

  assert.equal(result.metadata.rows, 2);
  assert.deepEqual(result.metadata.headers, ["name", "age"]);
  assert.equal(result.text, "name\tage\nAda\t36");
});

test("preserves quoted CSV fields across records", async () => {
  const cases = [
    {
      input: "name,note\nAda,\"\"",
      expectedText: "name\tnote\nAda\t"
    },
    {
      input: "name,note\nAda,\"hello\nworld\"",
      expectedText: "name\tnote\nAda\thello\nworld"
    },
    {
      input: "name,note\nAda,\"  keep  \"",
      expectedText: "name\tnote\nAda\t  keep  "
    },
    {
      input: "name,note\r\nAda,\"say \"\"hello\"\"\"",
      expectedText: "name\tnote\nAda\tsay \"hello\""
    }
  ];

  for (const { input, expectedText } of cases) {
    const result = await extract(Buffer.from(input), { filename: "people.csv" });

    assert.equal(result.metadata.rows, 2);
    assert.deepEqual(result.metadata.headers, ["name", "note"]);
    assert.equal(result.text, expectedText);
  }

  const detected = await detectFileType(Buffer.from(cases[1].input));
  assert.equal(detected.parserId, "csv");
});

test("extracts html text", async () => {
  const result = await extract(Buffer.from("<html><body><h1>Hello</h1><script>no</script></body></html>"), {
    filename: "page.html"
  });

  assert.equal(result.text, "Hello");
});

test("supports readable streams", async () => {
  const stream = Readable.from(["plain text"]);
  const result = await extract(stream, { filename: "note.txt" });

  assert.equal(result.text, "plain text");
});

test("supports custom parsers", async () => {
  registerParser({
    id: "upper",
    extensions: [".upper"],
    parse(context) {
      return {
        text: context.text.toUpperCase(),
        metadata: {},
        sections: [],
        pages: [],
        warnings: [],
        source: context.source
      };
    }
  });

  const result = await extract(Buffer.from("hello"), { filename: "sample.upper" });

  assert.equal(result.source.parserId, "upper");
  assert.equal(result.text, "HELLO");
});
