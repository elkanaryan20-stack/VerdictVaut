"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { changePassword, ChangePasswordInput, fetchSecurityEvents, fetchSessions, revokeSession } from "./api";

export const accountKeys = {
  sessions: ["account", "sessions"] as const,
  securityEvents: ["account", "security-events"] as const,
};

export function useSessions() {
  return useQuery({
    queryKey: accountKeys.sessions,
    queryFn: fetchSessions,
  });
}

export function useRevokeSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => revokeSession(sessionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: accountKeys.sessions });
    },
  });
}

/**
 * A successful change revokes every session server-side (see
 * AuthService.changePassword), including whichever one is driving this
 * very request — the caller is expected to sign the user out and send
 * them back to /login on success, not keep rendering an authenticated
 * page against tokens the backend just invalidated.
 */
export function useChangePassword() {
  return useMutation({
    mutationFn: (input: ChangePasswordInput) => changePassword(input),
  });
}

export function useSecurityEvents() {
  return useQuery({
    queryKey: accountKeys.securityEvents,
    queryFn: fetchSecurityEvents,
  });
}
