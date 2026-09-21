import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { extractStructured } from "../dist/index.js";
import { normalizeRequest } from "../dist/structured/validation.js";
import { providerRegistry } from "../dist/providers/mistral.js";

const safeCodes = new Set([
  "INVALID_INPUT", "NETWORK_ERROR", "TIMEOUT", "AUTHENTICATION_FAILED", "RATE_LIMITED",
  "UNSUPPORTED_FILE", "FILE_LIMIT_EXCEEDED", "PROVIDER_REJECTED", "PROVIDER_RESPONSE_INCOMPLETE",
  "STRUCTURED_OUTPUT_MISSING", "STRUCTURED_OUTPUT_INVALID_JSON", "STRUCTURED_OUTPUT_INVALID_SHAPE", "UNKNOWN_PROVIDER_ERROR",
]);

/** Explicit, opt-in smoke test. Logs never contain request or business data. */
export async function runSmoke(env, run = extractStructured, log = console.log) {
  const common = {
    provider: "mistral", model: "mistral-ocr-4-1", apiKey: env.MISTRAL_API_KEY,
    timeoutMs: 120_000,
    schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  };
  const cases = [
    { name: "document", request: { ...common, prompt: "Extract the text of the selected pages into text.", providerOptions: { pages: [0] }, inputs: [{ kind: "document", url: env.MISTRAL_OCR_TEST_DOCUMENT_URL }] } },
    { name: "image", request: { ...common, inputs: [{ kind: "image", url: env.MISTRAL_OCR_TEST_IMAGE_URL }] } },
  ];
  try {
    for (const entry of cases) {
      const normalized = normalizeRequest(entry.request, providerRegistry);
      if (normalized.slots.some(slot => !slot.input)) throw new Error("Invalid input.");
    }
  } catch { log("NOT RUN: Mistral credentials and both HTTP(S) sample URLs are required."); return 2; }
  let failed = false;
  for (const entry of cases) {
    try {
      const result = await run(entry.request);
      const item = result.items?.[0];
      if (result.items?.length !== 1 || item?.status !== "success" || typeof item.data !== "object" || item.data === null || Array.isArray(item.data) || typeof item.data.text !== "string") {
        failed = true;
        // Do not trust injected/upstream error strings as log-safe diagnostics.
        const code = safeCodes.has(item?.error?.code) ? item.error.code : "ASSERTION_FAILED";
        const status = item?.error?.providerStatus;
        const http = Number.isInteger(status) && status >= 100 && status <= 599 ? ` HTTP ${status}` : "";
        log(`${entry.name}: FAILED ${code}${http} (${common.model})`);
      } else log(`${entry.name}: PASS (${common.model})`);
    } catch { failed = true; log(`${entry.name}: FAILED (${common.model})`); }
  }
  log(failed ? "FAILED" : "PASS");
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runSmoke(process.env);
}
