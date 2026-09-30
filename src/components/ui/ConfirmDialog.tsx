import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";

// -----------------------------------------------------------------------------
// ConfirmDialog — themed replacement for window.confirm(). `useConfirm()` returns
// an async `confirm({...})` that resolves true on the action button and false on
// Cancel / Esc / backdrop. One dialog is mounted at the app root; a new request
// while one is open cancels the previous one.
// -----------------------------------------------------------------------------

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;
const ConfirmCtx = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const settle = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpts(null);
  }, []);

  const confirm = useCallback<ConfirmFn>((next) => {
    resolver.current?.(false);
    setOpts(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Modal
        open={!!opts}
        onClose={() => settle(false)}
        size="sm"
        title={opts?.title}
        footer={
          <>
            {/* Destructive asks land on Cancel so a stray Enter does no harm. */}
            <Button variant="secondary" onClick={() => settle(false)} autoFocus={!!opts?.danger}>
              {opts?.cancelLabel ?? "Cancel"}
            </Button>
            <Button variant={opts?.danger ? "danger" : "primary"} onClick={() => settle(true)} autoFocus={!opts?.danger}>
              {opts?.confirmLabel ?? (opts?.danger ? "Delete" : "Confirm")}
            </Button>
          </>
        }
      >
        {opts?.message && <div className="text-sm text-muted leading-relaxed [overflow-wrap:anywhere]">{opts.message}</div>}
      </Modal>
    </ConfirmCtx.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmCtx);
  if (!ctx) throw new Error("useConfirm must be used within ConfirmProvider");
  return ctx;
}
