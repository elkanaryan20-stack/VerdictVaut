"use client";

import type { MarketOutcome } from "@verdictvaut/shared-types";
import { useAuth } from "../../lib/auth/auth-context";
import { formatAmount, formatExactAmount } from "../../lib/format";
import { useCancelOrder, useMyOrders, useMyPositions } from "../../lib/trading/hooks";
import { isCancellableOrderStatus } from "../../lib/trading/order-status";
import { Button } from "../ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/Card";
import { Skeleton } from "../ui/Skeleton";
import { OrderStatusBadge } from "../trading/OrderStatusBadge";

/** This market's own slice of "my orders"/"my positions" — the full cross-market view lives at /portfolio. */
export function MarketMyActivity({ marketId, outcomes }: { marketId: string; outcomes: MarketOutcome[] }) {
  const { status: authStatus } = useAuth();
  const authenticated = authStatus === "authenticated";
  const ordersQuery = useMyOrders({ marketId, pageSize: 20, enabled: authenticated });
  const positionsQuery = useMyPositions(authenticated);
  const cancelMutation = useCancelOrder();

  if (authStatus !== "authenticated") {
    return null;
  }

  const positions = (positionsQuery.data ?? []).filter((p) => p.marketId === marketId);
  const outcomeLabel = (outcomeId: string) => outcomes.find((o) => o.id === outcomeId)?.label ?? outcomeId;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your activity in this market</CardTitle>
      </CardHeader>

      {(ordersQuery.isLoading || positionsQuery.isLoading) && (
        <CardBody className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </CardBody>
      )}

      {!ordersQuery.isLoading && !positionsQuery.isLoading && (
        <CardBody className="space-y-4">
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-white/40">Your positions</p>
            {positions.length === 0 ? (
              <p className="text-sm text-white/50">No positions in this market.</p>
            ) : (
              <ul className="space-y-2">
                {positions.map((position) => (
                  <li key={position.id} className="flex items-center justify-between text-sm">
                    <span className="text-white/70">{outcomeLabel(position.outcomeId)}</span>
                    <span className="tabular-nums text-white">
                      {formatAmount(position.quantity)}
                      {Number(position.reservedQuantity) > 0 && <span className="text-white/40"> ({formatAmount(position.reservedQuantity)} reserved)</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-white/40">Your orders</p>
            {!ordersQuery.data || ordersQuery.data.items.length === 0 ? (
              <p className="text-sm text-white/50">No orders in this market.</p>
            ) : (
              <ul className="space-y-2">
                {ordersQuery.data.items.map((order) => (
                  <li key={order.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate text-white/70">
                      <span className={order.side === "BUY" ? "font-semibold text-vault-up" : "font-semibold text-vault-down"}>{order.side}</span>{" "}
                      {outcomeLabel(order.outcomeId)} · {formatAmount(order.remainingQuantity)} rem.
                      {order.price && <> @ {formatExactAmount(order.price)}</>}
                    </span>
                    <OrderStatusBadge status={order.status} />
                    {isCancellableOrderStatus(order.status) && (
                      <Button type="button" variant="secondary" size="sm" onClick={() => cancelMutation.mutate(order.id)} isLoading={cancelMutation.isPending}>
                        Cancel
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardBody>
      )}
    </Card>
  );
}
