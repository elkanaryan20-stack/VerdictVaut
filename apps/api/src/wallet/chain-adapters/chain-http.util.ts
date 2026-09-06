import { ServiceUnavailableException } from "@nestjs/common";

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Thin REST GET helper for chain explorers/indexers (Esplora, etc.) that
 * speak plain JSON over HTTP. Never swallows a non-OK response as empty
 * data — a provider error must surface as an error, not a fabricated
 * "nothing found".
 */
export async function fetchJson<T>(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new ServiceUnavailableException(`Chain provider request failed: GET ${url} -> ${response.status}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof ServiceUnavailableException) throw error;
    throw new ServiceUnavailableException(`Chain provider request errored: GET ${url} (${(error as Error).message})`);
  } finally {
    clearTimeout(timer);
  }
}

export interface JsonRpcErrorShape {
  code: number;
  message: string;
}

/**
 * JSON-RPC 2.0 POST helper shared by the EVM and Solana adapters (and
 * usable for any other JSON-RPC chain). A JSON-RPC-level `error` field is
 * treated as a hard failure, never as "no result" — an adapter must never
 * interpret an RPC error as "transaction not found".
 */
export async function fetchJsonRpc<T>(
  url: string,
  method: string,
  params: unknown[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ServiceUnavailableException(`Chain RPC request failed: ${method} -> ${response.status}`);
    }
    const body = (await response.json()) as { result?: T; error?: JsonRpcErrorShape };
    if (body.error) {
      throw new ServiceUnavailableException(`Chain RPC error for ${method}: [${body.error.code}] ${body.error.message}`);
    }
    return body.result as T;
  } catch (error) {
    if (error instanceof ServiceUnavailableException) throw error;
    throw new ServiceUnavailableException(`Chain RPC request errored: ${method} (${(error as Error).message})`);
  } finally {
    clearTimeout(timer);
  }
}
