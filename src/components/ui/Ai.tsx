import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Violet→pink, the same in both themes, so AI entry points read as "AI". */
export const AI_GRADIENT = "bg-gradient-to-r from-[#7c3aed] to-[#db2777]";

export function AiButton({
  children,
  onClick,
  className,
  disabled,
  size = "sm",
}: {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium text-white shadow-card whitespace-nowrap",
        "hover:brightness-110 active:scale-[0.97] transition disabled:opacity-60 disabled:cursor-not-allowed",
        size === "sm" ? "h-8 px-2.5 text-sm" : "h-9 px-3 text-base",
        AI_GRADIENT,
        className,
      )}
    >
      <Sparkles size={15} />
      {children}
    </button>
  );
}

export function AiThinking({ label = "Thinking…", onCancel }: { label?: string; onCancel?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      <span className={cn("grid place-items-center h-10 w-10 rounded-full text-white animate-pulse", AI_GRADIENT)}>
        <Sparkles size={18} />
      </span>
      <span className="text-sm text-muted">{label}</span>
      {onCancel && (
        <button type="button" onClick={onCancel} className="text-xs text-muted hover:text-ink underline">
          Cancel
        </button>
      )}
    </div>
  );
}

export function AiNote({ children }: { children?: ReactNode }) {
  return (
    <p className="text-[11px] text-subtle leading-snug">
      {children ?? "AI can make mistakes. Review before using."}
    </p>
  );
}
