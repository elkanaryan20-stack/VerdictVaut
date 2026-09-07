import type { Session } from "@verdictvaut/shared-types";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionsList } from "../components/account/SessionsList";
import { renderWithQueryClient } from "../test-support/render";
import * as accountApi from "../lib/account/api";

jest.mock("../lib/account/api");
const mockedApi = accountApi as jest.Mocked<typeof accountApi>;

function session(overrides: Partial<Session>): Session {
  return {
    id: "session-1",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1_000_000).toISOString(),
    revokedAt: null,
    ...overrides,
  };
}

describe("SessionsList", () => {
  it("shows an empty state when there are no sessions", async () => {
    mockedApi.fetchSessions.mockResolvedValue([]);
    renderWithQueryClient(<SessionsList />);
    expect(await screen.findByText("No sessions found.")).toBeInTheDocument();
  });

  it("shows a Sign out control only for an active session, not a revoked one", async () => {
    mockedApi.fetchSessions.mockResolvedValue([
      session({ id: "active-1" }),
      session({ id: "revoked-1", revokedAt: new Date().toISOString() }),
    ]);
    renderWithQueryClient(<SessionsList />);

    expect(await screen.findAllByText("Active")).toHaveLength(1);
    expect(screen.getByText("Revoked")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Sign out" })).toHaveLength(1);
  });

  it("revokes a session and refetches to show the real, updated state", async () => {
    mockedApi.fetchSessions
      .mockResolvedValueOnce([session({ id: "active-1" })])
      .mockResolvedValueOnce([session({ id: "active-1", revokedAt: new Date().toISOString() })]);
    mockedApi.revokeSession.mockResolvedValue(undefined);

    const user = userEvent.setup();
    renderWithQueryClient(<SessionsList />);

    const signOutButton = await screen.findByRole("button", { name: "Sign out" });
    await user.click(signOutButton);

    expect(mockedApi.revokeSession).toHaveBeenCalledWith("active-1");
    expect(await screen.findByText("Revoked")).toBeInTheDocument();
  });

  it("shows an error state on API failure", async () => {
    mockedApi.fetchSessions.mockRejectedValue(new Error("network down"));
    renderWithQueryClient(<SessionsList />);
    expect(await screen.findByText("Couldn't load your sessions.")).toBeInTheDocument();
  });
});
