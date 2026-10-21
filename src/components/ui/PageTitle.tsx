import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { InfoTip } from "@/components/ui/InfoTip";

/** "1 project", "4 projects", "2 deliveries". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A page's title: big, heavy and tight, with an optional count pill beside it. */
export function PageTitle({
  children,
  count,
  info,
  className,
}: {
  children: ReactNode;
  count?: string | false | null;
  /** What the page is for, behind an (i) next to the title. */
  info?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2.5 gap-y-1", className)}>
      <h1 className="min-w-0 break-words text-xl sm:text-2xl font-extrabold text-ink tracking-[-0.03em]">{children}</h1>
      {info && <InfoTip text={info} className="self-center" />}
      {count && (
        <span className="shrink-0 rounded-full bg-accent-soft px-2.5 py-0.5 text-sm font-semibold text-accent tabular-nums animate-fade-in">
          {count}
        </span>
      )}
    </div>
  );
}
