import { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/** Never renders placeholder financial figures — purely a shimmering shape, no invented numbers. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-testid="skeleton"
      role="presentation"
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-white/5", className)}
      {...props}
    />
  );
}
