import { SecurityEvent, SecurityEventListSchema, Session, SessionListSchema } from "@verdictvaut/shared-types";
import { apiFetch } from "../api-client";
import { parseOrThrow } from "../api-validation";

export async function fetchSessions(): Promise<Session[]> {
  const data = await apiFetch<unknown>("/auth/sessions");
  return parseOrThrow(SessionListSchema, data, "GET /auth/sessions");
}

export async function revokeSession(sessionId: string): Promise<void> {
  await apiFetch<void>(`/auth/sessions/${encodeURIComponent(sessionId)}/revoke`, { method: "POST" });
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export async function changePassword(input: ChangePasswordInput): Promise<void> {
  await apiFetch<void>("/auth/change-password", { method: "POST", body: JSON.stringify(input) });
}

export async function fetchSecurityEvents(): Promise<SecurityEvent[]> {
  const data = await apiFetch<unknown>("/users/me/security-events");
  return parseOrThrow(SecurityEventListSchema, data, "GET /users/me/security-events");
}
