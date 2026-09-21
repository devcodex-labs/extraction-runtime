import { requestOnce } from "../internal/http.js";
import type { RequestOnce } from "../internal/http.js";
import type { ItemErrorCode } from "../structured/contracts.js";
import { isObject } from "../structured/validation.js";
import type { ProviderAdapter } from "./contracts.js";

/** Internal injection point; not exported from the package. */
export function createMistralAdapter(transport: RequestOnce = requestOnce): ProviderAdapter {
  return {
    provider: "mistral",
    async execute(input, context, scope) {
      const body = JSON.stringify({
        model: context.model,
        document: input.kind === "document"
          ? { type: "document_url", document_url: input.url }
          : { type: "image_url", image_url: input.url },
        document_annotation_format: {
          type: "json_schema", json_schema: { name: "extraction_result", strict: true, schema: context.schema },
        },
        include_image_base64: false,
        include_blocks: false,
        ...(context.prompt === undefined ? {} : { document_annotation_prompt: context.prompt }),
        ...(context.providerOptions.pages === undefined ? {} : { pages: context.providerOptions.pages }),
      });
      scope.checkDeadline();
      const response = await transport(context.endpoint, context.headers, body, scope);
      scope.checkDeadline();
      if (response.status < 200 || response.status >= 300) {
        const code: ItemErrorCode = [401, 403].includes(response.status) ? "AUTHENTICATION_FAILED"
          : response.status === 429 ? "RATE_LIMITED"
          : response.status >= 300 && response.status < 500 ? "PROVIDER_REJECTED" : "UNKNOWN_PROVIDER_ERROR";
        return { kind: "error", error: { code, message: "Provider request failed.", providerStatus: response.status } };
      }
      let envelope: unknown;
      try { envelope = JSON.parse(response.bodyText ?? ""); }
      catch { return { kind: "error", error: { code: "UNKNOWN_PROVIDER_ERROR", message: "Invalid provider response." } }; }
      scope.checkDeadline();
      if (!isObject(envelope)) return { kind: "error", error: { code: "UNKNOWN_PROVIDER_ERROR", message: "Invalid provider response." } };
      // OCR has no documented finish marker. Do not infer one from chat fields.
      return { kind: "annotation", annotation: envelope.document_annotation };
    },
  };
}

export const providerRegistry = new Map([["mistral", createMistralAdapter()]] as const);
