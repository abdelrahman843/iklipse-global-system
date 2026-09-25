import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
import { cn } from "@/lib/cn";

// -----------------------------------------------------------------------------
// Toast — bottom-right stack. Every toast animates in on mount (slide-in from
// the right + fade) and animates out before it unmounts (150ms). We manage
// the exit by flipping `leaving` on the item and delaying the actual splice
// until the animation has settled. Kept in a single component so the render
// budget stays flat regardless of stack depth.
// -----------------------------------------------------------------------------

type Kind = "success" | "error" | "info";
interface Toast {
  id: number;
  kind: Kind;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  leaving?: boolean;
}
interface Ctx {
  push: (t: Omit<Toast, "id" | "leaving">) => number;
  dismiss: (id: number) => void;
}
const ToastCtx = createContext<Ctx | null>(null);

const EXIT_MS = 160;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    // Two-phase: mark leaving so the exit animation runs, then unmount.
    setItems((v) => v.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    setTimeout(() => {
      setItems((v) => v.filter((t) => t.id !== id));
    }, EXIT_MS);
  }, []);

  const push = useCallback<Ctx["push"]>(
    (t) => {
      const id = Date.now() + Math.random();
      setItems((v) => [...v, { ...t, id }]);
      const dur = t.kind === "error" ? 6500 : 4000;
      setTimeout(() => dismiss(id), dur);
      return id;
    },
    [dismiss],
  );

  const value = useMemo(() => ({ push, dismiss }), [push, dismiss]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-[min(90vw,360px)] pointer-events-none">
        {items.map((t) => (
          <div
            key={t.id}
            className={cn(
              "pointer-events-auto flex items-start gap-3 p-3 rounded-lg bg-surface border shadow-pop text-sm",
              "will-change-transform",
              t.leaving ? "animate-toast-out" : "animate-toast-in",
              t.kind === "success" && "border-success/25",
              t.kind === "error" && "border-danger/25",
              t.kind === "info" && "border-border",
            )}
            role="status"
          >
            <span className="mt-0.5">
              {t.kind === "success" && <CheckCircle2 size={18} className="text-success" />}
              {t.kind === "error" && <AlertCircle size={18} className="text-danger" />}
              {t.kind === "info" && <Info size={18} className="text-accent" />}
            </span>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-ink">{t.title}</div>
              {t.description && <div className="text-muted text-sm mt-0.5">{t.description}</div>}
              {t.actionLabel && t.onAction && (
                <button
                  onClick={() => {
                    t.onAction!();
                    dismiss(t.id);
                  }}
                  className="mt-1.5 text-accent hover:underline text-sm font-medium transition-colors"
                >
                  {t.actionLabel}
                </button>
              )}
            </div>
            <button
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
              className="h-7 w-7 shrink-0 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
