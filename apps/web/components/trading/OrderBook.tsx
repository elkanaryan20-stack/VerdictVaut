"use client";

import type { OrderBookLevel } from "@verdictvaut/shared-types";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/Card";
import { Skeleton } from "../ui/Skeleton";
import { formatExactAmount } from "../../lib/format";

const MAX_LEVELS_SHOWN = 8;

function LevelRows({ levels, tone }: { levels: OrderBookLevel[]; tone: "up" | "down" }) {
  if (levels.length === 0) {
    return <p className="py-3 text-center text-xs text-white/30">No orders</p>;
  }
  return (
    <ul className="space-y-1">
      {levels.slice(0, MAX_LEVELS_SHOWN).map((level, index) => (
        <li key={`${level.price}-${index}`} className="flex items-center justify-between gap-2 text-xs tabular-nums">
          <span className={tone === "up" ? "text-vault-up" : "text-vault-down"}>{formatExactAmount(level.price)}</span>
          <span className="min-w-0 truncate text-white/50">{formatExactAmount(level.quantity)}</span>
        </li>
      ))}
    </ul>
  );
}

export function OrderBook({
  book,
  isLoading,
  isError,
  onRetry,
}: {
  book: { bids: OrderBookLevel[]; asks: OrderBookLevel[]; asOf: string } | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Order book</CardTitle>
      </CardHeader>

      {isLoading && (
        <CardBody className="grid grid-cols-2 gap-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </CardBody>
      )}

      {isError && !isLoading && (
        <CardBody className="flex flex-col items-start gap-3 text-sm text-white/60">
          <p>Couldn&apos;t load the order book.</p>
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md border border-vault-border px-3 py-1.5 text-xs font-medium text-white hover:bg-white/5"
          >
            Retry
          </button>
        </CardBody>
      )}

      {book && !isLoading && (
        <CardBody>
          <div className="mb-2 grid grid-cols-2 gap-4 text-[11px] font-medium uppercase tracking-wide text-white/40">
            <div className="flex items-center justify-between">
              <span>Bids</span>
              <span>Qty</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Asks</span>
              <span>Qty</span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <LevelRows levels={book.bids} tone="up" />
            <LevelRows levels={book.asks} tone="down" />
          </div>
        </CardBody>
      )}
    </Card>
  );
}
