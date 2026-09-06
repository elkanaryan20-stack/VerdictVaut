/** Renders only what the backend reports — never a fabricated confirmation count. */
export function ConfirmationProgress({ confirmations, requiredConfirmations }: { confirmations: number; requiredConfirmations: number }) {
  const capped = Math.min(confirmations, requiredConfirmations);
  const percent = requiredConfirmations > 0 ? Math.round((capped / requiredConfirmations) * 100) : 100;

  return (
    <div className="w-full">
      <div className="flex items-center justify-between text-xs text-white/60">
        <span>
          {confirmations} / {requiredConfirmations} confirmations
        </span>
        <span>{percent}%</span>
      </div>
      <div
        className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/10"
        role="progressbar"
        aria-valuenow={capped}
        aria-valuemin={0}
        aria-valuemax={requiredConfirmations}
        aria-label={`${confirmations} of ${requiredConfirmations} confirmations`}
      >
        <div className="h-full rounded-full bg-vault-gold transition-[width]" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
