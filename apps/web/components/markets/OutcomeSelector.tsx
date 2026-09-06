"use client";

import type { MarketOutcome } from "@verdictvaut/shared-types";
import { cn } from "../../lib/cn";

/**
 * An outcome is always identified by its id (marketId + outcomeId), never
 * inferred from its label — two outcomes could share a label in theory,
 * and only `outcome.id` is what the backend actually keys orders/order
 * books/positions by.
 */
export function OutcomeSelector({
  outcomes,
  selectedOutcomeId,
  onSelect,
}: {
  outcomes: MarketOutcome[];
  selectedOutcomeId: string | null;
  onSelect: (outcomeId: string) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Select an outcome" className="flex flex-wrap gap-2">
      {[...outcomes]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((outcome) => {
          const isSelected = outcome.id === selectedOutcomeId;
          return (
            <button
              key={outcome.id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => onSelect(outcome.id)}
              className={cn(
                "rounded-lg border px-4 py-2 text-sm font-medium transition-colors",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vault-gold",
                isSelected ? "border-vault-gold bg-vault-gold/10 text-vault-gold" : "border-vault-border text-white/70 hover:bg-white/5 hover:text-white",
              )}
            >
              {outcome.label}
            </button>
          );
        })}
    </div>
  );
}
