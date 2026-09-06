import { InputHTMLAttributes, forwardRef, useId } from "react";
import { cn } from "../../lib/cn";

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(({ label, error, hint, id, className, ...props }, ref) => {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-white/80">
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined}
        className={cn(
          "h-10 rounded-md border bg-white/5 px-3 text-sm text-white placeholder:text-white/30",
          "focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
          error ? "border-vault-down focus-visible:outline-vault-down" : "border-vault-border focus-visible:outline-vault-gold",
          className,
        )}
        {...props}
      />
      {hint && !error && (
        <p id={hintId} className="text-xs text-white/40">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-vault-down">
          {error}
        </p>
      )}
    </div>
  );
});
TextField.displayName = "TextField";
