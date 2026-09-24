import { cn } from "@/lib/cn";

/** Pill group for picking one of a few options. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-lg bg-inset border border-line p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={disabled}
          onClick={() => o.value !== value && onChange(o.value)}
          className={cn(
            "h-8 px-3 rounded-md text-sm transition-[background-color,color,box-shadow] duration-150",
            o.value === value ? "bg-surface text-ink font-medium shadow-card" : "text-muted hover:text-ink",
            disabled && o.value !== value && "hover:text-muted cursor-not-allowed",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** On/off switch with a label and optional hint. */
export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <div className={cn("flex items-start gap-3 pt-1", disabled && "opacity-60")}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors duration-200 disabled:cursor-not-allowed",
          checked ? "bg-accent" : "bg-rule",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform duration-200",
            checked && "translate-x-4",
          )}
        />
      </button>
      <span>
        <span className="block text-sm text-ink">{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </div>
  );
}
