import { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export type BadgeTone = "neutral" | "up" | "down" | "gold" | "info";

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-white/5 text-white/70 border-white/10",
  up: "bg-vault-up/10 text-vault-up border-vault-up/30",
  down: "bg-vault-down/10 text-vault-down border-vault-down/30",
  gold: "bg-vault-gold/10 text-vault-gold border-vault-gold/30",
  info: "bg-sky-400/10 text-sky-300 border-sky-400/30",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ tone = "neutral", className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        TONE_CLASSES[tone],
        className,
      )}
      {...props}
    />
  );
}
