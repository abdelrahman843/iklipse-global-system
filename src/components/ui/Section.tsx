import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/cn";

// -----------------------------------------------------------------------------
// The page layout everywhere: no boxed cards. A section is a clear heading with
// a line under it, then its content (lists split by hairlines). Figures sit in
// a strip between two lines, label above a big value.
// -----------------------------------------------------------------------------

export function Section({
  title,
  count,
  hint,
  action,
  children,
  className,
  id,
}: {
  title: ReactNode;
  count?: number | string | null;
  hint?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cn("min-w-0", className)}>
      <SectionHeading title={title} count={count} hint={hint} action={action} />
      {children}
    </section>
  );
}

export function SectionHeading({
  title,
  count,
  hint,
  action,
  className,
}: {
  title: ReactNode;
  count?: number | string | null;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex items-end justify-between gap-3 pb-2 mb-1 border-b border-rule", className)}>
      <div className="min-w-0">
        <h2 className="flex items-baseline gap-2 text-base font-semibold text-ink">
          <span className="truncate">{title}</span>
          {count != null && count !== "" && <span className="text-sm font-normal text-subtle tabular-nums">{count}</span>}
        </h2>
        {hint && <p className="mt-0.5 text-sm text-muted">{hint}</p>}
      </div>
      {action && <div className="shrink-0 flex items-center gap-2">{action}</div>}
    </header>
  );
}

/** Figures in a row between two lines (two per row on phones). */
export function StatStrip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid grid-cols-2 sm:grid-flow-col sm:auto-cols-fr border-y border-rule divide-line", className)}>
      {children}
    </div>
  );
}

const TONE = { success: "text-success", warn: "text-warn", danger: "text-danger", accent: "text-accent" } as const;

export function Stat({
  label,
  value,
  hint,
  tone,
  className,
  style,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: keyof typeof TONE;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div style={style} className={cn("min-w-0 py-3 pr-3 sm:px-4 sm:first:pl-0 sm:[&:not(:first-child)]:border-l border-line", className)}>
      <div className="text-sm text-muted truncate">{label}</div>
      <div className={cn("mt-0.5 text-2xl font-semibold tabular-nums truncate", tone ? TONE[tone] : "text-ink")}>{value}</div>
      {hint && <div className="mt-0.5 text-sm text-subtle truncate">{hint}</div>}
    </div>
  );
}

/** A list split by hairlines; rows light up on hover. */
export const ROWS = "divide-y divide-line";
export const ROW = "py-3 hover:bg-inset/60 transition-colors";
