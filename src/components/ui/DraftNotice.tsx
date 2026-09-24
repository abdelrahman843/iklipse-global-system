import { PencilLine } from "lucide-react";
import { cn } from "@/lib/cn";

// Solid amber so a pending draft stands out on any surface — including
// colored lists — in both themes.
const SOLID = "bg-warn text-[#1c1305] shadow-card ring-1 ring-black/10";

function Pulse() {
  return (
    <span className="relative flex h-2 w-2 shrink-0">
      <span className="absolute inline-flex h-full w-full rounded-full bg-[#1c1305]/60 animate-ping" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-[#1c1305]" />
    </span>
  );
}

/** "Draft · text…" pill for collapsed composers that hold a draft. */
export function DraftTag({ text, className }: { text?: string; className?: string }) {
  const preview = text?.replace(/\s+/g, " ").trim();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 min-w-0 rounded-full px-2 py-0.5 text-[11px] font-semibold animate-slide-down",
        SOLID,
        className,
      )}
      title={preview ? `Unsaved draft: ${preview}` : "Unsaved draft"}
    >
      <Pulse />
      <span className="uppercase tracking-wide">Draft</span>
      {preview && <span className="truncate max-w-[11rem] font-medium opacity-80">· {preview}</span>}
    </span>
  );
}

/** "You have unsaved edits" strip shown where a draft is waiting (Trello-style). */
export function DraftNotice({
  onView,
  onDiscard,
  label = "You have unsaved edits on this field.",
  className,
}: {
  onView: () => void;
  onDiscard: () => void;
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "mt-1.5 mb-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-md border-l-4 border-warn bg-warn/15 px-3 py-2 text-sm text-ink animate-slide-down",
        className,
      )}
    >
      <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide", SOLID)}>
        <PencilLine size={12} /> Draft
      </span>
      <span className="flex-1 min-w-0 font-medium">{label}</span>
      <button
        type="button"
        onClick={onView}
        className="h-7 px-2.5 rounded-md bg-warn text-[#1c1305] text-xs font-semibold hover:brightness-110 transition"
      >
        View edits
      </button>
      <button
        type="button"
        onClick={onDiscard}
        className="h-7 px-2.5 rounded-md text-xs font-medium text-muted hover:text-danger hover:bg-danger/10 transition-colors"
      >
        Discard
      </button>
    </div>
  );
}
