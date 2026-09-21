import type { ExtractionModelDescriptor } from "./contracts.js";

/**
 * Lists statically supported models without credentials or network access.
 * Returns a fresh, frozen snapshot; this does not check account availability.
 */
export function listExtractionModels(): readonly ExtractionModelDescriptor[] {
  return Object.freeze([
    Object.freeze({
      provider: "mistral" as const,
      model: "mistral-ocr-4-1" as const,
      name: "Mistral OCR 4.1",
      inputKinds: Object.freeze(["image", "document"] as const),
      status: "active" as const
    })
  ]);
}
