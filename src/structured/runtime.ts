import { TransportError, withDeadline } from "../internal/http.js";
import type { ProviderAdapter } from "../providers/contracts.js";
import { providerRegistry } from "../providers/mistral.js";
import type { ItemErrorCode, JsonObject, ProviderId, StructuredExtractionItem, StructuredExtractionItemError, StructuredExtractionRequest, StructuredExtractionResponse } from "./contracts.js";
import { isObject, normalizeRequest } from "./validation.js";

const messages: Record<ItemErrorCode, string> = {
  INVALID_INPUT: "Invalid extraction input.",
  NETWORK_ERROR: "Provider connection failed.",
  TIMEOUT: "Extraction deadline exceeded.",
  AUTHENTICATION_FAILED: "Provider authentication failed.",
  RATE_LIMITED: "Provider rate limit exceeded.",
  UNSUPPORTED_FILE: "Provider does not support this file.",
  FILE_LIMIT_EXCEEDED: "Provider file limit exceeded.",
  PROVIDER_REJECTED: "Provider rejected the request.",
  PROVIDER_RESPONSE_INCOMPLETE: "Provider declared an incomplete response.",
  STRUCTURED_OUTPUT_MISSING: "Structured output is missing.",
  STRUCTURED_OUTPUT_INVALID_JSON: "Structured output is not valid JSON.",
  STRUCTURED_OUTPUT_INVALID_SHAPE: "Structured output must be an object.",
  UNKNOWN_PROVIDER_ERROR: "Invalid provider response.",
};

function safeError(code: ItemErrorCode, status?: number): StructuredExtractionItemError {
  return { code, message: messages[code], ...(status === undefined ? {} : { providerStatus: status }) };
}

/** Internal factory keeps fake adapters out of the public extension surface. */
export function createRuntime(registry: ReadonlyMap<ProviderId, ProviderAdapter>) {
  return async function extractStructured<TData extends object = JsonObject>(request: StructuredExtractionRequest): Promise<StructuredExtractionResponse<TData>> {
    const { adapter, context, slots } = normalizeRequest(request, registry);
    const items: StructuredExtractionItem<TData>[] = [];
    for (const slot of slots) {
      const identity = { index: slot.index, ...(slot.id === undefined ? {} : { id: slot.id }), provider: adapter.provider, model: context.model };
      if (!slot.input) {
        items.push({ ...identity, status: "error", error: safeError("INVALID_INPUT") });
        continue;
      }
      try {
        const item = await withDeadline(context.timeoutMs, async scope => {
          const output = await adapter.execute(slot.input!, context, scope);
          scope.checkDeadline();
          const error = (code: ItemErrorCode, status?: number): StructuredExtractionItem<TData> => ({ ...identity, status: "error", error: safeError(code, status) });
          if (output.kind === "incomplete") return error("PROVIDER_RESPONSE_INCOMPLETE");
          if (output.kind === "error") return error(output.error.code, output.error.providerStatus);
          if (output.annotation === null || output.annotation === undefined) return error("STRUCTURED_OUTPUT_MISSING");
          if (typeof output.annotation !== "string") return error("UNKNOWN_PROVIDER_ERROR");
          let data: unknown;
          try { data = JSON.parse(output.annotation); }
          catch { return error("STRUCTURED_OUTPUT_INVALID_JSON"); }
          scope.checkDeadline();
          if (!isObject(data)) return error("STRUCTURED_OUTPUT_INVALID_SHAPE");
          return { ...identity, status: "success" as const, data: data as TData };
        });
        items.push(item);
      } catch (error) {
        items.push({ ...identity, status: "error", error: safeError(error instanceof TransportError ? error.code : "UNKNOWN_PROVIDER_ERROR") });
      }
    }
    return { items };
  };
}

/** Extract URL inputs serially. Configuration errors reject; item failures do not. */
export const extractStructured = createRuntime(providerRegistry);
