import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { AlertTriangle, CloudUpload, RotateCcw, Trash2, WifiOff } from "lucide-react";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/format";
import { useIsOnline } from "@/lib/offline/net";
import { discardFailed, onOutboxEvent, retryFailed, useOutboxStatus } from "@/lib/offline/outbox";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useAuth } from "@/lib/auth";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Where offline mode talks to the person. A slim strip (phones: on top of the
 * tab bar; desktop: bottom-right) while offline, while changes made offline are
 * going up, or when the server refused some. Toasts for "all synced" and for
 * each refused change. The strip is a live region, so screen readers hear it.
 */
export function SyncStatus() {
  const online = useIsOnline();
  const { user } = useAuth();
  const { waiting, failed, sending } = useOutboxStatus();
  const toast = useToast();
  const [reviewing, setReviewing] = useState(false);
  // The sign-in page has no tab bar, so the strip sits on the bottom edge there.
  const noTabBar = useLocation().pathname === "/login";
  // A change on its way for a moment is normal; only say "syncing" if it lasts.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!online || !waiting) {
      setSlow(false);
      return;
    }
    const t = setTimeout(() => setSlow(true), 1500);
    return () => clearTimeout(t);
  }, [online, waiting]);

  useEffect(
    () =>
      onOutboxEvent((e) => {
        if (e.type === "synced") {
          toast.push({ kind: "success", title: "All changes synced", description: `${plural(e.count, "change")} made offline reached the server.` });
        } else {
          toast.push({
            kind: "error",
            title: `Couldn't save: ${e.change.label}`,
            description: e.change.error,
            actionLabel: "Review",
            onAction: () => setReviewing(true),
          });
        }
      }),
    [toast],
  );

  const show: "offline" | "syncing" | "failed" | null = !online
    ? "offline"
    : failed.length
      ? "failed"
      : slow && waiting
        ? "syncing"
        : null;

  return (
    <>
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "fixed z-[90] inset-x-0 md:inset-x-auto md:right-4 md:bottom-4 md:max-w-md pointer-events-none print:hidden",
          noTabBar ? "bottom-[env(safe-area-inset-bottom)]" : "bottom-[calc(3.5rem+env(safe-area-inset-bottom))]",
        )}
      >
        {show && (
          <div
            className={cn(
              "pointer-events-auto border-t bg-surface overflow-hidden md:rounded-md md:border md:shadow-pop animate-slide-up",
              show === "failed" ? "border-danger" : show === "offline" ? "border-warn" : "border-border",
            )}
          >
            <div
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 text-xs sm:text-sm text-ink",
                show === "failed" ? "bg-danger/10" : show === "offline" ? "bg-warn/15" : "bg-inset",
              )}
            >
              {show === "offline" && (
                <>
                  <WifiOff size={14} className="shrink-0 text-warn" aria-hidden />
                  <span className="min-w-0">
                    {user ? (
                      <>
                        You're offline. Keep working: changes are saved on this device
                        {waiting ? ` (${plural(waiting, "change")} waiting)` : ""} and sync when you're back online.
                      </>
                    ) : (
                      "You're offline. Signing in needs an internet connection."
                    )}
                  </span>
                </>
              )}
              {show === "syncing" && (
                <>
                  <CloudUpload size={14} className={cn("shrink-0 text-accent", sending && "animate-pulse")} aria-hidden />
                  <span className="min-w-0">Syncing {plural(waiting, "change")} made offline...</span>
                </>
              )}
              {show === "failed" && (
                <>
                  <AlertTriangle size={14} className="shrink-0 text-danger" aria-hidden />
                  <span className="min-w-0 flex-1">
                    {plural(failed.length, "change")} couldn't be saved{waiting ? `, ${waiting} still syncing` : ""}.
                  </span>
                  <button
                    type="button"
                    onClick={() => setReviewing(true)}
                    className="shrink-0 font-medium text-accent hover:underline underline-offset-2"
                  >
                    Review
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
      <FailedChanges open={reviewing} onClose={() => setReviewing(false)} />
    </>
  );
}

function FailedChanges({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { failed } = useOutboxStatus();
  const confirm = useConfirm();
  useEffect(() => {
    if (open && !failed.length) onClose();
  }, [open, failed.length, onClose]);

  const discardAll = async () => {
    const ok = await confirm({
      title: `Discard ${plural(failed.length, "change")}?`,
      message: "They stay off the server and are removed from this device. This can't be undone.",
      confirmLabel: "Discard",
      danger: true,
    });
    if (ok) await discardFailed();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Changes that couldn't be saved"
      size="md"
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={discardAll} iconLeft={<Trash2 size={14} />}>
            Discard all
          </Button>
          <Button variant="primary" onClick={() => void retryFailed()} iconLeft={<RotateCcw size={14} />}>
            Try all again
          </Button>
        </div>
      }
    >
      <p className="text-sm text-muted mb-3">
        These were made on this device, but the server said no (for example, the card was deleted or your access
        changed). Try again, or discard them.
      </p>
      <ul className="divide-y divide-line rounded-md border border-border">
        {failed.map((f) => (
          <li key={f.seq} className="flex items-start gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-ink break-words">
                {f.label}
                {f.detail ? <span className="font-normal text-muted">: {f.detail}</span> : null}
              </div>
              <div className="text-xs text-danger break-words mt-0.5">{f.error}</div>
              <div className="text-xs text-subtle mt-0.5">Made {relativeTime(new Date(f.at).toISOString())}</div>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button size="sm" variant="ghost" aria-label="Try again" title="Try again" onClick={() => void retryFailed(f.seq)}>
                <RotateCcw size={14} />
              </Button>
              <Button size="sm" variant="ghost" aria-label="Discard" title="Discard" onClick={() => void discardFailed(f.seq)}>
                <Trash2 size={14} />
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
