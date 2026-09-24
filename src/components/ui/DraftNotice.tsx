import { PencilLine } from "lucide-react";
import { cn } from "@/lib/cn";

/** Small "Draft · text…" pill for collapsed composers that hold a draft. */
export function DraftTag({ text, className }: { text?: string; className?: string }) {
  const preview = text?.replace(/\s+/g, " ").trim();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 min-w-0 rounded-full bg-warn/15 text-warn px-1.5 py-px text-[11px] font-medium",
        className,
      )}
      title={preview}
    >
      <PencilLine size={11} className="shrink-0" />
      <span className="truncate max-w-[12rem]">{preview ? `Draft · ${preview}` : "Draft"}</span>
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
      className={cn(
        "mt-1.5 mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-warn/30 bg-warn/10 px-2.5 py-1.5 text-xs text-ink animate-slide-down",
        className,
      )}
    >
      <PencilLine size={13} className="text-warn shrink-0" />
      <span className="flex-1 min-w-0">{label}</span>
      <button type="button" onClick={onView} className="font-medium text-accent hover:underline">
        View edits
      </button>
      <span className="text-subtle">·</span>
      <button type="button" onClick={onDiscard} className="font-medium text-muted hover:text-danger hover:underline">
        Discard
      </button>
    </div>
  );
}
