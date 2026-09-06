"use client";

import type { OrderStatus } from "@verdictvaut/shared-types";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { formatAmount, formatDateTime, formatExactAmount } from "../../lib/format";
import { useMyOrders } from "../../lib/trading/hooks";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/Card";
import { Skeleton } from "../ui/Skeleton";
import { cn } from "../../lib/cn";
import { OrderStatusBadge } from "./OrderStatusBadge";

const PAGE_SIZE = 10;

const FILTERS: Array<{ value: OrderStatus | "ALL"; label: string }> = [
  { value: "ALL", label: "All" },
  { value: "FILLED", label: "Filled" },
  { value: "CANCELLED", label: "Cancelled" },
  { value: "EXPIRED", label: "Expired" },
  { value: "REJECTED", label: "Rejected" },
];

export function OrderHistoryTable() {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<OrderStatus | "ALL">("ALL");

  const { data, isLoading, isError, isPlaceholderData, refetch } = useMyOrders({
    page,
    pageSize: PAGE_SIZE,
    status: statusFilter === "ALL" ? undefined : statusFilter,
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  function handleFilterChange(value: OrderStatus | "ALL") {
    setStatusFilter(value);
    setPage(1);
  }

  return (
    <Card>
      <CardHeader className="flex-wrap">
        <CardTitle>Order history</CardTitle>
        <div role="tablist" aria-label="Filter order history by status" className="flex flex-wrap justify-end gap-1.5">
          {FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              role="tab"
              aria-selected={statusFilter === filter.value}
              onClick={() => handleFilterChange(filter.value)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vault-gold",
                statusFilter === filter.value
                  ? "border-vault-gold bg-vault-gold/10 text-vault-gold"
                  : "border-vault-border text-white/60 hover:bg-white/5",
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </CardHeader>

      {isLoading && (
        <CardBody className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </CardBody>
      )}

      {isError && !isLoading && (
        <CardBody className="flex flex-col items-start gap-3 text-sm text-white/60">
          <p>Couldn&apos;t load your order history.</p>
          <button
            type="button"
            onClick={() => refetch()}
            className="rounded-md border border-vault-border px-3 py-1.5 text-xs font-medium text-white hover:bg-white/5"
          >
            Retry
          </button>
        </CardBody>
      )}

      {data && !isLoading && data.items.length === 0 && (
        <CardBody className="py-10 text-center text-sm text-white/50">No orders match this filter.</CardBody>
      )}

      {data && !isLoading && data.items.length > 0 && (
        <div className={isPlaceholderData ? "opacity-60 transition-opacity" : "transition-opacity"}>
          <div className="divide-y divide-vault-border">
            {data.items.map((order) => (
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
                    {formatAmount(order.filledQuantity)} of {formatAmount(order.quantity)} filled
                    {order.price && <> @ {formatExactAmount(order.price)}</>} · {formatDateTime(order.createdAt)}
                  </p>
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between border-t border-vault-border px-5 py-3">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-white/70 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
              Previous
            </button>
            <p className="text-xs text-white/40">
              Page {data.page} of {totalPages}
            </p>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-white/70 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-30"
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
