import type { SecurityEvent } from "@verdictvaut/shared-types";
import { screen } from "@testing-library/react";
import { SecurityEventsList } from "../components/account/SecurityEventsList";
import { renderWithQueryClient } from "../test-support/render";
import * as accountApi from "../lib/account/api";

jest.mock("../lib/account/api");
const mockedApi = accountApi as jest.Mocked<typeof accountApi>;

function event(overrides: Partial<SecurityEvent>): SecurityEvent {
  return {
    id: "event-1",
    action: "user.login",
    resourceType: "User",
    resourceId: "user-1",
    reason: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("SecurityEventsList", () => {
  it("shows an empty state when no security events are recorded", async () => {
    mockedApi.fetchSecurityEvents.mockResolvedValue([]);
    renderWithQueryClient(<SecurityEventsList />);
    expect(await screen.findByText("No security events recorded yet.")).toBeInTheDocument();
  });

  it("shows a human-readable label for a known action", async () => {
    mockedApi.fetchSecurityEvents.mockResolvedValue([event({ action: "user.change_password" })]);
    renderWithQueryClient(<SecurityEventsList />);
    expect(await screen.findByText("Password changed")).toBeInTheDocument();
  });

  it("never hides an unrecognized action — renders it verbatim instead of dropping it", async () => {
    mockedApi.fetchSecurityEvents.mockResolvedValue([event({ action: "user.future_event_type" })]);
    renderWithQueryClient(<SecurityEventsList />);
    expect(await screen.findByText("user.future_event_type")).toBeInTheDocument();
  });

  it("shows an error state on API failure", async () => {
    mockedApi.fetchSecurityEvents.mockRejectedValue(new Error("network down"));
    renderWithQueryClient(<SecurityEventsList />);
    expect(await screen.findByText("Couldn't load your security events.")).toBeInTheDocument();
  });
});
