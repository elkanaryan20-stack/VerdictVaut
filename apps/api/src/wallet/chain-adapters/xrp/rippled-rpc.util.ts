import { ServiceUnavailableException } from "@nestjs/common";

/**
 * `rippled`'s HTTP JSON-RPC always responds 200 with a `{"result": ...}`
 * envelope, success or failure — an application-level error lands as
 * `result.error`/`result.status === "error"` inside that 200 response,
 * never as an HTTP error status or a top-level JSON-RPC `error` field.
 * Every rippled call (the deposit adapter and the custody provider both)
 * goes through here so that distinction is handled in exactly one place.
 */
export async function callRippled<T extends object>(
  url: string,
  method: string,
  params: Record<string, unknown>,
): Promise<T & { error?: string; status?: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params: [params] }),
  });
  if (!response.ok) {
    throw new ServiceUnavailableException(`XRPL provider request failed: ${method} -> ${response.status}`);
  }
  const body = (await response.json()) as { result: T & { error?: string; status?: string } };
  return body.result;
}
