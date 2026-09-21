export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** A submission schema, not a promise of local business-data validation. */
export type JsonSchemaObject = Readonly<Record<string, unknown>>;
export type ProviderId = "mistral";
export type ExtractionModelId = "mistral-ocr-4-1";
export type ExtractionInputKind = "image" | "document";
export type ExtractionModelStatus = "active" | "deprecated";

export interface ExtractionModelDescriptor {
  readonly provider: ProviderId;
  readonly model: ExtractionModelId;
  readonly name: string;
  readonly inputKinds: readonly ExtractionInputKind[];
  readonly status: ExtractionModelStatus;
}

export interface MistralProviderOptions {
  readonly pages?: string | readonly number[];
}

export interface StructuredExtractionInput {
  readonly url: string;
  readonly kind: ExtractionInputKind;
  readonly id?: string;
}

export interface StructuredExtractionCommonRequest {
  readonly schema: JsonSchemaObject;
  readonly prompt?: string;
  readonly inputs: readonly StructuredExtractionInput[];
}

export interface MistralExtractionRequestConfig {
  readonly provider: ProviderId;
  readonly model: ExtractionModelId;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly timeoutMs: number;
  readonly providerOptions?: MistralProviderOptions;
}

export type StructuredExtractionRequest =
  StructuredExtractionCommonRequest & MistralExtractionRequestConfig;

/** TData describes the caller's expectation, without runtime schema validation. */
export interface StructuredExtractionResponse<TData extends object = JsonObject> {
  readonly items: readonly StructuredExtractionItem<TData>[];
}

export type StructuredExtractionItem<TData extends object = JsonObject> =
  | StructuredExtractionSuccess<TData>
  | StructuredExtractionFailure;

export interface StructuredExtractionSuccess<TData extends object = JsonObject> {
  readonly status: "success";
  readonly index: number;
  readonly id?: string;
  readonly provider: ProviderId;
  readonly model: ExtractionModelId;
  readonly data: TData;
}

export interface StructuredExtractionFailure {
  readonly status: "error";
  readonly index: number;
  readonly id?: string;
  readonly provider: ProviderId;
  readonly model: ExtractionModelId;
  readonly error: StructuredExtractionItemError;
}

export interface StructuredExtractionItemError {
  readonly code: ItemErrorCode;
  readonly message: string;
  readonly providerStatus?: number;
  readonly providerRequestId?: string;
}

export type CallErrorCode =
  | "INVALID_ARGUMENT"
  | "UNSUPPORTED_PROVIDER"
  | "UNSUPPORTED_MODEL"
  | "INVALID_PROVIDER_CONFIG"
  | "INVALID_SCHEMA";

export type ItemErrorCode =
  | "INVALID_INPUT"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "AUTHENTICATION_FAILED"
  | "RATE_LIMITED"
  | "UNSUPPORTED_FILE"
  | "FILE_LIMIT_EXCEEDED"
  | "PROVIDER_REJECTED"
  | "PROVIDER_RESPONSE_INCOMPLETE"
  | "STRUCTURED_OUTPUT_MISSING"
  | "STRUCTURED_OUTPUT_INVALID_JSON"
  | "STRUCTURED_OUTPUT_INVALID_SHAPE"
  | "UNKNOWN_PROVIDER_ERROR";

/** Call-level validation failure. Runtime messages must not contain request data. */
export class ExtractionRuntimeError extends Error {
  readonly name = "ExtractionRuntimeError";

  constructor(readonly code: CallErrorCode, message: string) {
    super(message);
  }
}
