import type { AuditLogEntry } from "@verdictvaut/shared-types";
import { screen } from "@testing-library/react";
import { AuditLogFeed } from "../components/admin/AuditLogFeed";
import { renderWithQueryClient } from "../test-support/render";
import * as adminApi from "../lib/admin/api";

jest.mock("../lib/admin/api");
const mockedApi = adminApi as jest.Mocked<typeof adminApi>;

function entry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: "log-1",
    actorId: "admin-1",
    actorType: "ADMIN",
    action: "withdrawal.approve",
    resourceType: "Withdrawal",
    resourceId: "withdrawal-1",
    reason: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("AuditLogFeed", () => {
  it("shows an empty state when there are no audit entries", async () => {
    mockedApi.fetchAuditLogs.mockResolvedValue([]);
    renderWithQueryClient(<AuditLogFeed />);
    expect(await screen.findByText("No audit log entries yet.")).toBeInTheDocument();
  });

  it("renders a real entry's action, resource, and actor type", async () => {
    mockedApi.fetchAuditLogs.mockResolvedValue([entry()]);
    renderWithQueryClient(<AuditLogFeed />);
    expect(await screen.findByText("withdrawal.approve")).toBeInTheDocument();
    expect(screen.getByText("ADMIN")).toBeInTheDocument();
  });

  it("shows an error state instead of an empty list on API failure", async () => {
    mockedApi.fetchAuditLogs.mockRejectedValue(new Error("network down"));
    renderWithQueryClient(<AuditLogFeed />);
    expect(await screen.findByText("Couldn't load the audit log.")).toBeInTheDocument();
    expect(screen.queryByText("No audit log entries yet.")).not.toBeInTheDocument();
  });
});
