import { isTerminalDepositStatus, DEPOSIT_STATUS_LABEL } from "../lib/wallet/deposit-status";
import { DEPOSIT_STATUSES } from "@verdictvaut/shared-types";

describe("isTerminalDepositStatus", () => {
  it("treats CREDITED, REJECTED, and FAILED as terminal", () => {
    expect(isTerminalDepositStatus("CREDITED")).toBe(true);
    expect(isTerminalDepositStatus("REJECTED")).toBe(true);
    expect(isTerminalDepositStatus("FAILED")).toBe(true);
  });

  it("treats PENDING and CONFIRMED as non-terminal", () => {
    expect(isTerminalDepositStatus("PENDING")).toBe(false);
    expect(isTerminalDepositStatus("CONFIRMED")).toBe(false);
  });

  it("has a label for every backend-defined status", () => {
    for (const status of DEPOSIT_STATUSES) {
      expect(DEPOSIT_STATUS_LABEL[status]).toBeTruthy();
    }
  });
});
