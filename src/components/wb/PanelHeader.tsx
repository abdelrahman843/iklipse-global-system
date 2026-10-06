import type { ReactNode } from "react";
import { X } from "lucide-react";

/** Title row of the whiteboard's right-side panels. */
export function PanelHeader({ title, icon, onClose, children }: { title: string; icon?: ReactNode; onClose: () => void; children?: ReactNode }) {
  return (
    <div className="shrink-0 h-12 flex items-center gap-2 pl-3 pr-1.5 border-b border-line">
      {icon && <span className="shrink-0 text-muted">{icon}</span>}
      <h2 className="flex-1 min-w-0 truncate text-base font-semibold text-ink">{title}</h2>
      {children}
      <button
        type="button"
        onClick={onClose}
        title="Close"
        aria-label="Close"
        className="h-9 w-9 shrink-0 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink transition-colors"
      >
        <X size={17} />
      </button>
    </div>
  );
}
