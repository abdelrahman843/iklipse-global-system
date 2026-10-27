import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/cn";

// -----------------------------------------------------------------------------
// Pager — pages for any table or list of records: 10 rows by default, 20 or
// 50 on request. The size picked is kept per table (by its key) on this
// device. usePaged takes every row and hands back the page to draw, plus the
// props for <Pager>; filtering or a shorter list moves back to a page that
// exists. With 10 rows or fewer there's nothing to page and <Pager> draws
// nothing.
// -----------------------------------------------------------------------------

export const PAGE_SIZES = [10, 20, 50] as const;
const DEFAULT = 10;

function storedSize(key: string): number {
  try {
    const n = Number(localStorage.getItem(`pager:${key}`));
    return (PAGE_SIZES as readonly number[]).includes(n) ? n : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export interface PagerProps {
  total: number;
  page: number;
  size: number;
  onPage: (page: number) => void;
  onSize: (size: number) => void;
  className?: string;
}

/** The page of rows to draw, and <Pager>'s props. key: which table (its size is remembered). */
export function usePaged<T>(rows: readonly T[], key: string): { rows: T[]; pager: PagerProps; offset: number } {
  const [size, setSize] = useState(() => storedSize(key));
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const at = Math.min(page, pages - 1);
  useEffect(() => {
    if (page !== at) setPage(at);
  }, [page, at]);
  const shown = useMemo(() => rows.slice(at * size, at * size + size), [rows, at, size]);
  return {
    rows: shown,
    offset: at * size,
    pager: {
      total: rows.length,
      page: at,
      size,
      onPage: setPage,
      onSize: (n) => {
        setSize(n);
        setPage(0);
        try {
          localStorage.setItem(`pager:${key}`, String(n));
        } catch {
          /* private mode: just this visit */
        }
      },
    },
  };
}

export function Pager({ total, page, size, onPage, onSize, className }: PagerProps) {
  if (total <= PAGE_SIZES[0]) return null;
  const pages = Math.max(1, Math.ceil(total / size));
  const from = page * size + 1;
  const to = Math.min(total, from + size - 1);
  const btn =
    "inline-flex items-center justify-center h-10 w-10 sm:h-8 sm:w-8 rounded-md border border-border bg-surface text-ink hover:bg-inset disabled:opacity-40 disabled:hover:bg-surface";
  return (
    <nav aria-label="Pages" className={cn("flex flex-wrap items-center justify-between gap-3 pt-3 text-sm text-muted", className)}>
      <div className="flex items-center gap-2">
        <span>Rows per page</span>
        <Select
          size="sm"
          className="w-20"
          aria-label="Rows per page"
          value={String(size)}
          onChange={(v) => onSize(Number(v))}
          options={PAGE_SIZES.map((n) => ({ value: String(n), label: String(n) }))}
          searchable={false}
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="tabular-nums">
          {from}-{to} of {total}
        </span>
        <button type="button" className={btn} aria-label="Previous page" disabled={page <= 0} onClick={() => onPage(page - 1)}>
          <ChevronLeft size={16} />
        </button>
        <button type="button" className={btn} aria-label="Next page" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>
          <ChevronRight size={16} />
        </button>
      </div>
    </nav>
  );
}
