"use client";

import type { Market, MarketOutcome, OrderSide, Position } from "@verdictvaut/shared-types";
import Link from "next/link";
import { useState } from "react";
import { ApiError } from "../../lib/api-client";
import { useAuth } from "../../lib/auth/auth-context";
import { cn } from "../../lib/cn";
import { formatAmount, formatExactAmount } from "../../lib/format";
import { generateClientOrderId } from "../../lib/trading/client-order-id";
import { multiplyDecimalStrings } from "../../lib/trading/decimal";
import { usePlaceOrder, useSettlementCurrencyBalance } from "../../lib/trading/hooks";
import { Button } from "../ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/Card";
import { TextField } from "../ui/TextField";
import { OrderStatusBadge } from "./OrderStatusBadge";

const DECIMAL_STRING = /^\d+(\.\d+)?$/;

function validatePositiveDecimal(value: string, label: string): string | null {
  if (!value.trim()) return `${label} is required.`;
  if (!DECIMAL_STRING.test(value)) return `${label} must be a positive number.`;
  if (Number(value) <= 0) return `${label} must be greater than zero.`;
  return null;
}

/** Mirrors the backend's own constraint (CreateOrderDto / orders_price_probability_check) so an out-of-range price is caught before a round trip. */
function validatePrice(value: string): string | null {
  const basic = validatePositiveDecimal(value, "Price");
  if (basic) return basic;
  if (Number(value) >= 1) return "Price must be less than 1.";
  return null;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "Something went wrong placing this order. Please try again.";
}

/**
 * Rendered once per selected outcome (parent passes `key={outcomeId}`) so
 * switching outcomes always starts a completely fresh attempt — new
 * clientOrderId, cleared fields, cleared result — rather than needing
 * manual reset wiring for that case.
 */
export function OrderTicket({ market, outcome, position }: { market: Market; outcome: MarketOutcome; position: Position | null }) {
  const { status: authStatus } = useAuth();
  const [side, setSide] = useState<OrderSide>("BUY");
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [clientOrderId, setClientOrderId] = useState(() => generateClientOrderId());
  const [localError, setLocalError] = useState<string | null>(null);

  const placeOrderMutation = usePlaceOrder();
  const settlementBalance = useSettlementCurrencyBalance(authStatus === "authenticated");

  const tradable = market.status === "OPEN";

  function startNewAttemptIfNeeded() {
    if (placeOrderMutation.isError || placeOrderMutation.isSuccess) {
      setClientOrderId(generateClientOrderId());
      placeOrderMutation.reset();
    }
  }

  function handleSideChange(next: OrderSide) {
    setSide(next);
    startNewAttemptIfNeeded();
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const priceError = validatePrice(price);
    const quantityError = validatePositiveDecimal(quantity, "Quantity");
    const validationError = priceError ?? quantityError;
    if (validationError) {
      setLocalError(validationError);
      return;
    }
    setLocalError(null);
    placeOrderMutation.mutate({
      marketId: market.id,
      outcomeId: outcome.id,
      side,
      type: "LIMIT",
      price,
      quantity,
      clientOrderId,
    });
  }

  function handleNewOrder() {
    setPrice("");
    setQuantity("");
    setLocalError(null);
    setClientOrderId(generateClientOrderId());
    placeOrderMutation.reset();
  }

  if (authStatus !== "authenticated") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Trade {outcome.label}</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col items-start gap-3 text-sm text-white/60">
          <p>Log in to place an order.</p>
          <Link
            href="/login"
            className="rounded-md border border-vault-border px-3 py-1.5 text-xs font-medium text-white hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-vault-gold"
          >
            Log in
          </Link>
        </CardBody>
      </Card>
    );
  }

  if (!tradable) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Trade {outcome.label}</CardTitle>
        </CardHeader>
        <CardBody className="text-sm text-white/60">
          Trading is not available for this market — it is currently <span className="font-medium text-white">{market.status}</span>.
        </CardBody>
      </Card>
    );
  }

  const result = placeOrderMutation.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Trade {outcome.label}</CardTitle>
      </CardHeader>
      <CardBody className="space-y-4">
        <div role="radiogroup" aria-label="Order side" className="grid grid-cols-2 gap-2">
          {(["BUY", "SELL"] as const).map((option) => {
            const isSelected = side === option;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={isSelected}
                onClick={() => handleSideChange(option)}
                disabled={placeOrderMutation.isPending}
                className={cn(
                  "rounded-lg border px-3 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vault-gold",
                  isSelected
                    ? option === "BUY"
                      ? "border-vault-up bg-vault-up/10 text-vault-up"
                      : "border-vault-down bg-vault-down/10 text-vault-down"
                    : "border-vault-border text-white/60 hover:bg-white/5",
                )}
              >
                {option}
              </button>
            );
          })}
        </div>

        <div className="rounded-lg border border-vault-border bg-white/[0.02] px-3 py-2 text-xs text-white/50">
          {side === "BUY" ? (
            settlementBalance.isLoading ? (
              "Loading available balance…"
            ) : settlementBalance.balance ? (
              <>
                Available to spend:{" "}
                <span className="font-medium text-white">
                  {formatAmount(settlementBalance.balance.availableBalance)} {settlementBalance.balance.symbol}
                </span>
              </>
            ) : (
              "Available balance unavailable."
            )
          ) : position ? (
            <>
              Your position: <span className="font-medium text-white">{formatAmount(position.quantity)} shares</span>
              {Number(position.reservedQuantity) > 0 && <> ({formatAmount(position.reservedQuantity)} reserved in other orders)</>}
            </>
          ) : (
            "You don't hold a position in this outcome."
          )}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <TextField
            label="Limit price (0–1)"
            inputMode="decimal"
            placeholder="0.50"
            value={price}
            onChange={(e) => {
              setPrice(e.target.value);
              startNewAttemptIfNeeded();
            }}
            disabled={placeOrderMutation.isPending}
          />
          <TextField
            label="Quantity"
            inputMode="decimal"
            placeholder="10"
            value={quantity}
            onChange={(e) => {
              setQuantity(e.target.value);
              startNewAttemptIfNeeded();
            }}
            disabled={placeOrderMutation.isPending}
          />

          {price && quantity && DECIMAL_STRING.test(price) && DECIMAL_STRING.test(quantity) && (
            <p className="text-xs text-white/40">Est. {side === "BUY" ? "cost" : "proceeds"}: ~{formatExactAmount(multiplyDecimalStrings(price, quantity))}</p>
          )}

          {localError && (
            <p role="alert" className="text-xs text-vault-down">
              {localError}
            </p>
          )}

          {placeOrderMutation.isError && (
            <p role="alert" className="text-xs text-vault-down">
              {errorMessage(placeOrderMutation.error)}
            </p>
          )}

          {!placeOrderMutation.isSuccess && (
            <Button type="submit" isLoading={placeOrderMutation.isPending} className="w-full" variant={side === "BUY" ? "primary" : "danger"}>
              {placeOrderMutation.isPending ? "Placing order…" : `${side} ${outcome.label}`}
            </Button>
          )}
        </form>

        {result && (
          <div className="space-y-2 rounded-lg border border-vault-border bg-white/[0.02] p-3 text-sm">
            <div className="flex items-center justify-between">
              <OrderStatusBadge status={result.status} />
              {result.matchingDeferred && <span className="text-xs text-white/40">Matching in progress…</span>}
            </div>
            <p className="text-xs text-white/60">
              Filled {formatAmount(result.filledQuantity)} of {formatAmount(result.quantity)}
              {result.averageExecutionPrice && <> at an average price of {formatExactAmount(result.averageExecutionPrice)}</>}
            </p>
            {Number(result.reservedAmountRemaining) > 0 && (
              <p className="text-xs text-white/40">{formatAmount(result.reservedAmountRemaining)} still earmarked by this order.</p>
            )}
            <Button type="button" variant="secondary" size="sm" onClick={handleNewOrder}>
              Place another order
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
