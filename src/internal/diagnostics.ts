import type { ProviderErrorDetails, StructuredExtractionItemError } from "../structured/contracts.js";

const redacted = "[REDACTED]";

/** Include URL query values because providers may echo them without the URL. */
export function diagnosticSecrets(values: readonly string[]): readonly string[] {
  const secrets = new Set<string>();
  for (const value of values) {
    if (value) secrets.add(value);
    if (value.trim()) secrets.add(value.trim());
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      secrets.add(url.href);
      if (url.search.length > 1) secrets.add(url.search.slice(1));
      for (const part of url.searchParams.values()) if (part) secrets.add(part);
    } catch { /* Non-URL credentials are already included verbatim. */ }
  }
  for (const value of [...secrets]) {
    try { secrets.add(encodeURIComponent(value)); } catch { /* Malformed Unicode is still matched verbatim. */ }
    secrets.add(value.replace(/./g, char => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`));
  }
  return [...secrets].sort((a, b) => b.length - a.length);
}

function text(value: unknown, secrets: readonly string[]): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.length > 16_384) return undefined;
  let safe = value;
  // Normalize ordinary percent-encoded echoes before applying URL/credential rules.
  for (let pass = 0; pass < 2; pass++) {
    try { safe = decodeURIComponent(safe); } catch { break; }
  }
  safe = safe.replace(/https?:\/\/[^\s"'<>]+/gi, redacted)
    .replace(/\bBearer\s+[^\s,;"']+/gi, redacted)
    .replace(/[?&][^\s"'<>]+/g, redacted);
  for (const secret of secrets) safe = safe.split(secret).join(redacted);
  safe = safe.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return safe ? safe.slice(0, 1024) : undefined;
}

/** Reapply at the runtime boundary so an adapter cannot bypass the public contract. */
export function safeDiagnostics(error: Pick<StructuredExtractionItemError, "providerError" | "providerRequestId">, secrets: readonly string[]): Pick<StructuredExtractionItemError, "providerError" | "providerRequestId"> {
  const details: { -readonly [K in keyof ProviderErrorDetails]: ProviderErrorDetails[K] } = {};
  for (const key of ["message", "type", "code", "param"] as const) {
    const value = text(error.providerError?.[key], secrets);
    if (value !== undefined) details[key] = value;
  }
  const id = error.providerRequestId;
  // IDs are opaque tokens, not a free-text channel for a gateway to echo secrets.
  const providerRequestId = typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(id)
    && text(id, secrets) === id ? id : undefined;
  return {
    ...(Object.keys(details).length ? { providerError: details } : {}),
    ...(providerRequestId === undefined ? {} : { providerRequestId }),
  };
}
