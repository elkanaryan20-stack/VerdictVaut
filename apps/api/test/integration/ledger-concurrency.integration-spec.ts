import { InsufficientBalanceError } from "../../src/ledger/ledger.errors";
import { createTestUser, fundUserForTest, getUserAccount, ledger, txRunner } from "./helpers";

function postSigned(userId: string, assetSymbol: string, amount: string, referenceId: string) {
  return txRunner.run((tx) =>
    ledger.postTransaction(tx, {
      assetSymbol,
      type: "ADJUSTMENT",
      referenceType: "ConcurrencyTest",
      referenceId,
      idempotencyKey: `concurrency-test:${referenceId}`,
      postings: [
        { account: { type: "USER", userId }, amount },
        { account: { type: "HOUSE", key: "FEE_REVENUE" }, amount: (-Number(amount)).toString() },
      ],
    }),
  );
}

describe("Ledger transaction isolation under concurrency (real Postgres, SERIALIZABLE)", () => {
  it("20 concurrent credits to the same account all land — no lost updates", async () => {
    const user = await createTestUser();

    await Promise.all(
      Array.from({ length: 20 }, (_, i) => postSigned(user.id, "USDC", "10", `credit-${user.id}-${i}`)),
    );

    const account = await getUserAccount(user.id, "USDC");
    expect(account?.cachedBalance.toString()).toBe("200"); // 20 * 10, not less
  });

  it("concurrent debits never let the balance go negative, even racing right at the edge of available funds", async () => {
    const user = await createTestUser();
    await fundUserForTest(user.id, "USDC", "100");

    // 15 concurrent attempts to debit 10 each against a balance of 100 —
    // at most 10 can succeed; the rest must fail cleanly, and the
    // account must never be observed negative at any point.
    const results = await Promise.allSettled(
      Array.from({ length: 15 }, (_, i) => postSigned(user.id, "USDC", "-10", `debit-${user.id}-${i}`)),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(10);
    expect(rejected).toHaveLength(5);
    for (const r of rejected as PromiseRejectedResult[]) {
      expect(r.reason).toBeInstanceOf(InsufficientBalanceError);
    }

    const account = await getUserAccount(user.id, "USDC");
    expect(account?.cachedBalance.toString()).toBe("0"); // exactly drained, never negative
  });

  it("a mixed concurrent workload of credits and debits nets out exactly right", async () => {
    const user = await createTestUser();
    await fundUserForTest(user.id, "USDC", "500");

    const ops = [
      ...Array.from({ length: 10 }, (_, i) => ({ amount: "50", id: `mix-credit-${i}` })),
      ...Array.from({ length: 10 }, (_, i) => ({ amount: "-50", id: `mix-debit-${i}` })),
    ];

    await Promise.all(ops.map((op) => postSigned(user.id, "USDC", op.amount, `${user.id}-${op.id}`)));

    const account = await getUserAccount(user.id, "USDC");
    expect(account?.cachedBalance.toString()).toBe("500"); // +500 -500 net zero change
  });
});
