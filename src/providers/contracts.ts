import type { DeadlineScope } from "../internal/http.js";
import type { ExtractionInputKind, ExtractionModelId, JsonObject, MistralProviderOptions, ProviderId, StructuredExtractionItemError } from "../structured/contracts.js";

export interface NormalizedInput {
  readonly index: number;
  readonly id?: string;
  readonly url: string;
  readonly kind: ExtractionInputKind;
}

export interface ProviderExecutionContext {
  readonly model: ExtractionModelId;
  readonly headers: Readonly<Record<string, string>>;
  readonly endpoint: URL;
  readonly timeoutMs: number;
  readonly schema: JsonObject;
  readonly prompt?: string;
  readonly providerOptions: MistralProviderOptions;
}

export type ProviderExecutionResult =
  | { readonly kind: "annotation"; readonly annotation: unknown }
  | { readonly kind: "error"; readonly error: StructuredExtractionItemError }
  | { readonly kind: "incomplete"; readonly reason: "provider-declared-incomplete" };

export interface ProviderAdapter {
  readonly provider: ProviderId;
  execute(input: NormalizedInput, context: ProviderExecutionContext, scope: DeadlineScope): Promise<ProviderExecutionResult>;
}
