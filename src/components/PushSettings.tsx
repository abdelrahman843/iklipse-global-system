import { useState } from "react";
import { BellRing, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Toggle } from "@/components/ui/Controls";
import { useToast } from "@/components/ui/Toast";
import { supabase } from "@/lib/supabase";
import { disablePush, enablePush, usePush } from "@/lib/push";

// -----------------------------------------------------------------------------
// Push notifications on this device: the settings dialog (account menu) and a
// small "turn them on" strip at the top of the notifications panel.
// -----------------------------------------------------------------------------

export function PushSettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Notifications on this device" size="sm">
      {open && <PushSettingsBody />}
    </Modal>
  );
}

function PushSettingsBody() {
  const push = usePush();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      await push.refresh();
      if (done) toast.push({ kind: "success", title: done });
    } catch (e) {
      toast.push({ kind: "error", title: "Couldn't change notifications", description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (push.loading) return <p className="text-sm text-subtle py-4">Checking this device…</p>;

  if (push.support === "dev") return <Note>Push notifications work in the published app only.</Note>;
  if (push.support === "install-first")
    return (
      <Note>
        On iPhone and iPad, notifications work in the installed app. Add iklipse to your home screen (Share, then Add to Home Screen), open
        it from the icon, and turn notifications on from there.
      </Note>
    );
  if (push.support === "unsupported") return <Note>This browser can't receive push notifications. Try Chrome, Edge, Firefox or Safari.</Note>;
  if (push.permission === "denied")
    return (
      <Note>
        Notifications are blocked for iklipse in this browser. Open the site settings (the icon next to the address, or the app's settings
        on your phone), allow Notifications, then come back here.
      </Note>
    );

  if (!push.device)
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <span className="h-10 w-10 shrink-0 grid place-items-center rounded-full bg-accent-soft text-accent">
            <BellRing size={18} />
          </span>
          <p className="text-sm text-muted">
            Get mentions, comments, cards you're added to and due dates here as phone or computer notifications, even when iklipse is closed.
          </p>
        </div>
        <Button variant="primary" className="w-full" loading={busy} onClick={() => run(enablePush, "Notifications are on for this device")}>
          Turn on notifications
        </Button>
      </div>
    );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Notifications are on for this device. Choose what comes here:</p>
      <div className="space-y-3">
        <Toggle
          checked={push.device.trello}
          onChange={(v) => run(() => push.setProduct("trello", v))}
          label="Trello"
          hint="Mentions, comments, cards you're on, due dates"
          disabled={busy}
        />
        <Toggle
          checked={push.device.miro}
          onChange={(v) => run(() => push.setProduct("miro", v))}
          label="Miro"
          hint="Mentions, replies, client comments"
          disabled={busy}
        />
      </div>
      <div className="flex flex-wrap gap-2 pt-1">
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const { error } = await supabase.rpc("push_test");
              if (error) throw new Error(error.message);
            }, "Test sent. It should arrive in a few seconds.")
          }
        >
          Send a test
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(disablePush, "Notifications are off for this device")}>
          Turn off on this device
        </Button>
      </div>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted leading-relaxed">{children}</p>;
}

const STRIP_KEY = "push-strip-dismissed";

/** Top of the notifications panel: offer push once, until turned on or dismissed. */
export function PushStrip() {
  const push = usePush();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(STRIP_KEY) === "1";
    } catch {
      return false;
    }
  });
  if (hidden || push.loading || push.device || push.permission === "denied") return null;
  if (push.support !== "ok") return null;

  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem(STRIP_KEY, "1");
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="mx-3 mt-3 flex items-center gap-2.5 rounded-lg bg-accent-soft/60 border border-accent/20 px-3 py-2 animate-slide-down">
      <BellRing size={16} className="text-accent shrink-0" />
      <span className="flex-1 min-w-0 text-xs text-ink">Get these on this device, even when iklipse is closed.</span>
      <Button
        size="sm"
        variant="primary"
        className="h-7 shrink-0"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await enablePush();
            await push.refresh();
            toast.push({ kind: "success", title: "Notifications are on for this device" });
          } catch (e) {
            toast.push({ kind: "error", title: "Couldn't turn on notifications", description: (e as Error).message });
          } finally {
            setBusy(false);
          }
        }}
      >
        Turn on
      </Button>
      <button type="button" onClick={dismiss} aria-label="Not now" className="h-7 w-7 -mr-1 shrink-0 grid place-items-center rounded-md text-subtle hover:text-ink">
        <X size={14} />
      </button>
    </div>
  );
}
