import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

export type ExtractionInput = string | URL | ArrayBuffer | Uint8Array | Readable;

export interface ExtractOptions {
  filename?: string;
  mimeType?: string;
  encoding?: BufferEncoding;
  maxBytes?: number;
}

export interface ExtractionSource {
  filename?: string;
  extension?: string;
  mimeType?: string;
  parserId: string;
}

export interface ExtractionSection {
  type: string;
  title?: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface ExtractionPage {
  index: number;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface ExtractionResult {
  text: string;
  metadata: Record<string, unknown>;
  sections: ExtractionSection[];
  pages: ExtractionPage[];
  warnings: string[];
  source: ExtractionSource;
}

export interface ParserContext {
  content: Buffer;
  text: string;
  source: ExtractionSource;
  options: ExtractOptions;
}

export interface ExtractionParser {
  id: string;
  extensions?: string[];
  mimeTypes?: string[];
  matches?: (context: Omit<ParserContext, "source"> & { extension?: string; mimeType?: string }) => boolean;
  parse: (context: ParserContext) => Promise<ExtractionResult> | ExtractionResult;
}

export interface DetectedFileType {
  extension?: string;
  mimeType?: string;
  parserId: string;
}

const parsers = new Map<string, ExtractionParser>();

export function registerParser(parser: ExtractionParser): void {
  if (!parser.id) {
    throw new Error("Parser id is required.");
  }

  parsers.set(parser.id, parser);
}

export async function detectFileType(input: ExtractionInput, options: ExtractOptions = {}): Promise<DetectedFileType> {
  const prepared = await prepareInput(input, options);
  const extension = normalizeExtension(options.filename ?? prepared.filename);
  const mimeType = options.mimeType;
  const parser = findParser(prepared.content, prepared.text, extension, mimeType);

  return {
    extension,
    mimeType,
    parserId: parser.id
  };
}

export async function extract(input: ExtractionInput, options: ExtractOptions = {}): Promise<ExtractionResult> {
  const prepared = await prepareInput(input, options);
  const extension = normalizeExtension(options.filename ?? prepared.filename);
  const mimeType = options.mimeType;
  const parser = findParser(prepared.content, prepared.text, extension, mimeType);
  const source: ExtractionSource = {
    filename: options.filename ?? prepared.filename,
    extension,
    mimeType,
    parserId: parser.id
  };

  return parser.parse({
    content: prepared.content,
    text: prepared.text,
    source,
    options
  });
}

function findParser(content: Buffer, text: string, extension?: string, mimeType?: string): ExtractionParser {
  for (const parser of parsers.values()) {
    if (extension && parser.extensions?.includes(extension)) {
      return parser;
    }
  }

  for (const parser of parsers.values()) {
    if (mimeType && parser.mimeTypes?.includes(mimeType)) {
      return parser;
    }
  }

  for (const parser of parsers.values()) {
    if (parser.matches?.({ content, text, options: {}, extension, mimeType })) {
      return parser;
    }
  }

  return parsers.get("text")!;
}

async function prepareInput(input: ExtractionInput, options: ExtractOptions): Promise<{ content: Buffer; text: string; filename?: string }> {
  const encoding = options.encoding ?? "utf8";
  let content: Buffer;
  let filename: string | undefined;

  if (typeof input === "string") {
    filename = input;
    content = await readFile(input);
  } else if (input instanceof URL) {
    filename = fileURLToPath(input);
    content = await readFile(filename);
  } else if (input instanceof ArrayBuffer) {
    content = Buffer.from(input);
  } else if (input instanceof Uint8Array) {
    content = Buffer.from(input);
  } else if (input instanceof Readable) {
    content = await readStream(input);
  } else {
    throw new TypeError("Unsupported extraction input.");
  }

  if (options.maxBytes !== undefined && content.byteLength > options.maxBytes) {
    throw new Error(`Input exceeds maxBytes (${options.maxBytes}).`);
  }

  return {
    content,
    text: content.toString(encoding),
    filename
  };
}

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function normalizeExtension(filename?: string): string | undefined {
  if (!filename) {
    return undefined;
  }

  const extension = extname(filename).toLowerCase();
  return extension || undefined;
}

function createTextResult(context: ParserContext, metadata: Record<string, unknown> = {}, warnings: string[] = []): ExtractionResult {
  return {
    text: context.text,
    metadata,
    sections: [
      {
        type: "body",
        text: context.text
      }
    ],
    pages: [
      {
        index: 0,
        text: context.text
      }
    ],
    warnings,
    source: context.source
  };
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function looksLikeHtml(text: string): boolean {
  const trimmed = text.trimStart().toLowerCase();
  return trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html") || /<body[\s>]/i.test(trimmed);
}

function looksLikeCsv(text: string): boolean {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  return lines.length > 1 && lines.slice(0, 3).every((line) => parseCsvLine(line).length > 1);
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === "\"" && next === "\"") {
      current += "\"";
      index += 1;
      continue;
    }

    if (char === "\"") {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function markdownHeadings(text: string): ExtractionSection[] {
  return text
    .split(/\r?\n/)
    .map((line) => /^(#{1,6})\s+(.+)$/.exec(line))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => ({
      type: "heading",
      title: match[2],
      text: match[2],
      metadata: {
        depth: match[1].length
      }
    }));
}

registerParser({
  id: "text",
  extensions: [".txt"],
  mimeTypes: ["text/plain"],
  parse(context) {
    return createTextResult(context, {
      bytes: context.content.byteLength,
      characters: context.text.length
    });
  }
});

registerParser({
  id: "markdown",
  extensions: [".md", ".markdown"],
  mimeTypes: ["text/markdown", "text/x-markdown"],
  parse(context) {
    const headings = markdownHeadings(context.text);
    const result = createTextResult(context, {
      bytes: context.content.byteLength,
      characters: context.text.length,
      headings: headings.length
    });

    return {
      ...result,
      sections: headings.length > 0 ? headings : result.sections
    };
  }
});

registerParser({
  id: "json",
  extensions: [".json"],
  mimeTypes: ["application/json"],
  matches: ({ text }) => looksLikeJson(text),
  parse(context) {
    try {
      const value = JSON.parse(context.text) as unknown;
      const text = JSON.stringify(value, null, 2);
      const metadata: Record<string, unknown> = {
        type: Array.isArray(value) ? "array" : typeof value
      };

      if (value && typeof value === "object" && !Array.isArray(value)) {
        metadata.keys = Object.keys(value).length;
      }

      return {
        text,
        metadata,
        sections: [
          {
            type: "json",
            text
          }
        ],
        pages: [
          {
            index: 0,
            text
          }
        ],
        warnings: [],
        source: context.source
      };
    } catch (error) {
      return createTextResult(context, {}, [`Invalid JSON: ${(error as Error).message}`]);
    }
  }
});

registerParser({
  id: "csv",
  extensions: [".csv"],
  mimeTypes: ["text/csv"],
  matches: ({ text }) => looksLikeCsv(text),
  parse(context) {
    const rows = context.text.trim().split(/\r?\n/).filter(Boolean).map(parseCsvLine);
    const headers = rows[0] ?? [];
    const text = rows.map((row) => row.join("\t")).join("\n");

    return {
      text,
      metadata: {
        rows: rows.length,
        columns: headers.length,
        headers
      },
      sections: [
        {
          type: "table",
          title: "CSV",
          text,
          metadata: {
            headers
          }
        }
      ],
      pages: [
        {
          index: 0,
          text
        }
      ],
      warnings: [],
      source: context.source
    };
  }
});

registerParser({
  id: "html",
  extensions: [".html", ".htm"],
  mimeTypes: ["text/html"],
  matches: ({ text }) => looksLikeHtml(text),
  parse(context) {
    const text = stripHtml(context.text);
    return {
      text,
      metadata: {
        bytes: context.content.byteLength,
        characters: text.length
      },
      sections: [
        {
          type: "body",
          text
        }
      ],
      pages: [
        {
          index: 0,
          text
        }
      ],
      warnings: [],
      source: context.source
    };
  }
});
