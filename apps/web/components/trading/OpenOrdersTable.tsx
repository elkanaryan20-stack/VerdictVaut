"use client";

import type { Order } from "@verdictvaut/shared-types";
import { ApiError } from "../../lib/api-client";
import { formatAmount, formatExactAmount } from "../../lib/format";
import { useCancelOrder, useMyOrders } from "../../lib/trading/hooks";
import { isCancellableOrderStatus } from "../../lib/trading/order-status";
import { Button } from "../ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/Card";
import { Skeleton } from "../ui/Skeleton";
import { OrderStatusBadge } from "./OrderStatusBadge";

function mergeOpenOrders(open: Order[] | undefined, partiallyFilled: Order[] | undefined): Order[] {
  return [...(open ?? []), ...(partiallyFilled ?? [])].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function CancelButton({ order }: { order: Order }) {
  const cancelMutation = useCancelOrder();
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => cancelMutation.mutate(order.id)}
        isLoading={cancelMutation.isPending}
      >
        Cancel
      </Button>
      {cancelMutation.isError && (
        <p role="alert" className="max-w-[12rem] text-right text-[11px] text-vault-down">
          {/* A 400 here most often means the order already reached a terminal
              state (e.g. it just filled) between page load and this click —
              refetch below shows its real current status. */}
          {cancelMutation.error instanceof ApiError ? cancelMutation.error.message : "Couldn't cancel this order."}
        </p>
      )}
    </div>
  );
}

export function OpenOrdersTable() {
  const openQuery = useMyOrders({ status: "OPEN", pageSize: 50 });
  const partialQuery = useMyOrders({ status: "PARTIALLY_FILLED", pageSize: 50 });

  const isLoading = openQuery.isLoading || partialQuery.isLoading;
  const isError = openQuery.isError || partialQuery.isError;
  const orders = mergeOpenOrders(openQuery.data?.items, partialQuery.data?.items);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Open orders</CardTitle>
      </CardHeader>

      {isLoading && (
        <CardBody className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </CardBody>
      )}

      {isError && !isLoading && (
        <CardBody className="flex flex-col items-start gap-3 text-sm text-white/60">
          <p>Couldn&apos;t load your open orders.</p>
          <button
            type="button"
            onClick={() => {
              openQuery.refetch();
              partialQuery.refetch();
            }}
            className="rounded-md border border-vault-border px-3 py-1.5 text-xs font-medium text-white hover:bg-white/5"
          >
            Retry
          </button>
        </CardBody>
      )}

      {!isLoading && !isError && orders.length === 0 && (
        <CardBody className="py-10 text-center text-sm text-white/50">You have no open orders.</CardBody>
      )}

      {!isLoading && orders.length > 0 && (
        <div className="divide-y divide-vault-border">
          {orders.map((order) => (
            <div key={order.id} className="flex items-center justify-between gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className={order.side === "BUY" ? "text-xs font-semibold text-vault-up" : "text-xs font-semibold text-vault-down"}>
                    {order.side}
                  </span>
                  <span className="truncate text-sm text-white">{order.market?.title ?? order.marketId}</span>
                  <OrderStatusBadge status={order.status} />
                </div>
                <p className="mt-1 text-xs text-white/40">
                  {formatAmount(order.remainingQuantity)} of {formatAmount(order.quantity)} remaining
                  {order.price && <> @ {formatExactAmount(order.price)}</>}
                </p>
              </div>
              {isCancellableOrderStatus(order.status) && <CancelButton order={order} />}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
