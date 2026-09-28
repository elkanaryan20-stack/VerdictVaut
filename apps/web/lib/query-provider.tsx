"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "./api-client";

export function shouldRetry(failureCount: number, error: unknown): boolean {
  // Never retry an auth/ownership/not-found failure — retrying won't
  // change the outcome, it just delays showing the user what happened.
  if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404)) {
    return false;
  }
  // Phase 38 — nor a 429: the server just said to back off, and an
  // automatic retry only spends more of the same per-IP budget (polling
  // resumes on its normal interval anyway).
  if (error instanceof ApiError && error.isRateLimited) {
    return false;
  }
  return failureCount < 2;
}

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: shouldRetry,
            staleTime: 15_000,
            refetchOnWindowFocus: true,
          },
          mutations: {
            retry: false,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
