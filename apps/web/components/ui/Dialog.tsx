"use client";

import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "../../lib/cn";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * Built on Radix's unstyled Dialog primitive rather than hand-rolled —
 * focus trap, Escape-to-close, aria-labelledby/aria-describedby wiring,
 * and returning focus to the trigger on close all come for free and
 * correctly, which is easy to get subtly wrong writing a modal from
 * scratch. All visual styling below is VerdictVaut's own.
 */
export function Dialog({ open, onOpenChange, title, description, children, className }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" />
        <RadixDialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2",
            "rounded-xl border border-vault-border bg-vault-surface p-6 shadow-2xl focus:outline-none",
            "max-h-[85vh] overflow-y-auto",
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <RadixDialog.Title className="font-display text-base font-semibold text-white">{title}</RadixDialog.Title>
              {description && <RadixDialog.Description className="mt-1 text-sm text-white/60">{description}</RadixDialog.Description>}
            </div>
            <RadixDialog.Close asChild>
              <button
                type="button"
                aria-label="Close"
                className="rounded-md p-1.5 text-white/50 transition-colors hover:bg-white/5 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-vault-gold"
              >
                <X className="h-4 w-4" />
              </button>
            </RadixDialog.Close>
          </div>
          <div className="mt-4">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
