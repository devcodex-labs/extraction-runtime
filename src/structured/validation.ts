import { validateHeaderValue } from "node:http";
import type { NormalizedInput, ProviderAdapter, ProviderExecutionContext } from "../providers/contracts.js";
import { listExtractionModels } from "./catalog.js";
import { ExtractionRuntimeError } from "./contracts.js";
import type { CallErrorCode, JsonObject, JsonValue, MistralProviderOptions, ProviderId } from "./contracts.js";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function plain(value: unknown): value is Record<string, unknown> {
  return isObject(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function fail(code: CallErrorCode): never {
  throw new ExtractionRuntimeError(code, {
    INVALID_ARGUMENT: "Invalid extraction arguments.",
    UNSUPPORTED_PROVIDER: "Unsupported extraction provider.",
    UNSUPPORTED_MODEL: "Unsupported extraction model.",
    INVALID_PROVIDER_CONFIG: "Invalid provider configuration.",
    INVALID_SCHEMA: "Invalid submission schema.",
  }[code]);
}

/** Read caller-controlled values inside the appropriate public error boundary. */
function checked<T>(code: CallErrorCode, read: () => T): T {
  try { return read(); } catch { return fail(code); }
}

/** Copy checked data descriptors; never serialize or iterate the caller's objects. */
function jsonSnapshot(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if ((!Array.isArray(value) && !plain(value)) || ancestors.has(value as object)) fail("INVALID_SCHEMA");
  ancestors.add(value as object);
  const keys = Reflect.ownKeys(value as object);
  let copy: JsonValue;
  if (Array.isArray(value)) {
    if (![Array.prototype, null].includes(Object.getPrototypeOf(value))) fail("INVALID_SCHEMA");
    const length = Object.getOwnPropertyDescriptor(value, "length")!.value as number;
    if (keys.length !== length + 1) fail("INVALID_SCHEMA");
    const entries: JsonValue[] = [];
    for (const key of keys) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length) fail("INVALID_SCHEMA");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) fail("INVALID_SCHEMA");
      entries[Number(key)] = jsonSnapshot(descriptor.value, ancestors);
    }
    copy = entries;
  } else {
    const properties: Record<string, JsonValue> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== "string") fail("INVALID_SCHEMA");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) fail("INVALID_SCHEMA");
      properties[key] = jsonSnapshot(descriptor.value, ancestors);
    }
    copy = properties;
  }
  ancestors.delete(value as object);
  return copy;
}

export function validInputUrl(value: unknown): value is string {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

function endpoint(value: unknown): URL {
  if (value === undefined) value = "https://api.mistral.ai";
  try {
    if (!validInputUrl(value)) fail("INVALID_PROVIDER_CONFIG");
    const url = new URL(value);
    if (url.search || url.hash || value.includes("?") || value.includes("#") ||
        /(?:^|\/)v1\/ocr(?:\/|$)/.test(decodeURIComponent(url.pathname))) fail("INVALID_PROVIDER_CONFIG");
    url.pathname = url.pathname.replace(/\/+$/, "") + "/";
    return new URL("v1/ocr", url);
  } catch { return fail("INVALID_PROVIDER_CONFIG"); }
}

function options(value: unknown): MistralProviderOptions {
  if (value === undefined) return {};
  if (!plain(value) || Reflect.ownKeys(value).some(key => key !== "pages")) fail("INVALID_PROVIDER_CONFIG");
  const pages = value.pages;
  if (pages === undefined) return {};
  if (Array.isArray(pages)) {
    const copy = Array.from({ length: pages.length }, (_, index) => pages[index]);
    if (!copy.length || copy.some(n => !Number.isSafeInteger(n) || n < 0)) fail("INVALID_PROVIDER_CONFIG");
    return { pages: copy };
  }
  if (typeof pages !== "string" || !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(pages)) fail("INVALID_PROVIDER_CONFIG");
  for (const range of pages.split(",")) {
    const [start, end = start] = range.split("-").map(Number);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) fail("INVALID_PROVIDER_CONFIG");
  }
  return { pages };
}

export type InputSlot = { readonly index: number; readonly id?: string; readonly input?: NormalizedInput };

/** Snapshot every slot before the first await; invalid slots remain item errors. */
export function normalizeRequest(value: unknown, registry: ReadonlyMap<ProviderId, ProviderAdapter>) {
  const request = checked("INVALID_ARGUMENT", () => {
    if (!isObject(value)) fail("INVALID_ARGUMENT");
    return value;
  });
  const { inputs, length } = checked("INVALID_ARGUMENT", () => {
    const inputs = request.inputs;
    if (!Array.isArray(inputs)) fail("INVALID_ARGUMENT");
    const length = inputs.length;
    if (!Number.isSafeInteger(length) || length <= 0) fail("INVALID_ARGUMENT");
    return { inputs, length };
  });
  const provider = checked("UNSUPPORTED_PROVIDER", () => request.provider);
  const adapter = registry.get(provider as ProviderId);
  if (!adapter) fail("UNSUPPORTED_PROVIDER");
  const modelId = checked("UNSUPPORTED_MODEL", () => request.model);
  const model = listExtractionModels().find(m => m.provider === provider && m.model === modelId && m.status === "active");
  if (!model) fail("UNSUPPORTED_MODEL");
  const apiKey = checked("INVALID_PROVIDER_CONFIG", () => request.apiKey);
  if (typeof apiKey !== "string" || !apiKey.trim()) fail("INVALID_PROVIDER_CONFIG");
  const authorization = `Bearer ${apiKey}`;
  try { validateHeaderValue("Authorization", authorization); } catch { fail("INVALID_PROVIDER_CONFIG"); }
  const target = checked("INVALID_PROVIDER_CONFIG", () => endpoint(request.baseUrl));
  const timeoutMs = checked("INVALID_PROVIDER_CONFIG", () => request.timeoutMs);
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs <= 0) fail("INVALID_PROVIDER_CONFIG");
  const providerOptions = checked("INVALID_PROVIDER_CONFIG", () => options(request.providerOptions));
  const schema = checked("INVALID_SCHEMA", () => {
    const snapshot = jsonSnapshot(request.schema);
    if (!plain(snapshot) || snapshot.type !== "object") fail("INVALID_SCHEMA");
    return snapshot as JsonObject;
  });
  const prompt = checked("INVALID_ARGUMENT", () => request.prompt);
  if (prompt !== undefined && typeof prompt !== "string") fail("INVALID_ARGUMENT");
  const context: ProviderExecutionContext = {
    model: model.model, endpoint: target, timeoutMs, schema, providerOptions,
    headers: { Authorization: authorization, "Content-Type": "application/json", Accept: "application/json", "Accept-Encoding": "identity" },
    ...(prompt === undefined ? {} : { prompt }),
  };
  const slots: InputSlot[] = Array.from({ length }, (_, index) => {
    let identity: InputSlot = { index };
    try {
      const entry: unknown = inputs[index];
      if (!isObject(entry)) return identity;
      const id = entry.id;
      identity = { index, ...(typeof id === "string" ? { id } : {}) };
      const url = entry.url;
      const kind = entry.kind;
      if (!validInputUrl(url) || (kind !== "image" && kind !== "document") || (id !== undefined && typeof id !== "string")) return identity;
      return { ...identity, input: { ...identity, url, kind } };
    } catch { return identity; }
  });
  return { adapter, context, slots };
}
