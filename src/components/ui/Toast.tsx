import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
import { cn } from "@/lib/cn";

type Kind = "success" | "error" | "info";
interface Toast {
  id: number;
  kind: Kind;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}
interface Ctx {
  push: (t: Omit<Toast, "id">) => number;
  dismiss: (id: number) => void;
}
const ToastCtx = createContext<Ctx | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setItems((v) => v.filter((t) => t.id !== id)), []);
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
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-[min(90vw,360px)]">
        {items.map((t) => (
          <div
            key={t.id}
            className={cn(
              "flex items-start gap-3 p-3 rounded-lg bg-white border shadow-pop text-sm",
              t.kind === "success" && "border-success/30",
              t.kind === "error" && "border-danger/30",
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
                  className="mt-1.5 text-accent hover:underline text-sm font-medium"
                >
                  {t.actionLabel}
                </button>
              )}
            </div>
            <button
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
              className="rounded p-0.5 text-subtle hover:bg-surface hover:text-ink"
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
