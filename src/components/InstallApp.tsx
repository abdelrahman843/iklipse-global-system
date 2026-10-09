import { useEffect, useState } from "react";
import { MonitorDown, Share, SquarePlus, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { promptInstall, useInstallMode } from "@/lib/pwa";
import { cn } from "@/lib/cn";

// -----------------------------------------------------------------------------
// Install the app: a button in the app bar / rail, and on phones a one-time
// card above the tab bar. Android / Chrome / Edge get the browser's install
// dialog; iPhone / iPad get the Share > Add to Home Screen steps.
// -----------------------------------------------------------------------------

const ICON = `${import.meta.env.BASE_URL}icons/icon-192.png`;
const BANNER_KEY = "install-banner-dismissed";
const BANNER_AGAIN_MS = 14 * 24 * 60 * 60 * 1000;

function useInstall() {
  const mode = useInstallMode();
  const toast = useToast();
  const [iosHelp, setIosHelp] = useState(false);
  const install = async () => {
    if (mode === "ios") return setIosHelp(true);
    if (await promptInstall()) toast.push({ kind: "success", title: "Iklipse is installed", description: "Open it from your home screen or app list." });
  };
  return { mode, install, iosHelp, closeIosHelp: () => setIosHelp(false) };
}

export function InstallAppButton({ className }: { className?: string }) {
  const { mode, install, iosHelp, closeIosHelp } = useInstall();
  if (!mode && !iosHelp) return null;
  return (
    <>
      {mode && (
        <button
          type="button"
          onClick={install}
          aria-label="Install the app"
          title="Install the app"
          className={cn("grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink animate-fade-in", className)}
        >
          <MonitorDown size={16} />
        </button>
      )}
      <IosSteps open={iosHelp} onClose={closeIosHelp} />
    </>
  );
}

/** Phones: a card above the tab bar offering to install, until dismissed. */
export function InstallBanner() {
  const { mode, install, iosHelp, closeIosHelp } = useInstall();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!mode) return setShow(false);
    let dismissedAt = 0;
    try {
      dismissedAt = Number(localStorage.getItem(BANNER_KEY) ?? 0);
    } catch {
      /* storage blocked: still offer */
    }
    if (Date.now() - dismissedAt < BANNER_AGAIN_MS) return;
    // Give the page a moment before asking.
    const t = window.setTimeout(() => setShow(true), 3500);
    return () => window.clearTimeout(t);
  }, [mode]);

  const dismiss = () => {
    setShow(false);
    try {
      localStorage.setItem(BANNER_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
  };

  return (
    <>
      {show && mode && (
        <div
          role="dialog"
          aria-label="Install Iklipse"
          className="md:hidden fixed z-[60] left-3 right-3 bottom-[calc(4.25rem+env(safe-area-inset-bottom))] flex items-center gap-3 p-3 rounded-lg bg-surface border border-border shadow-raise animate-slide-up"
        >
          <img src={ICON} alt="" className="h-11 w-11 rounded-lg shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-ink">Install Iklipse</div>
            <div className="text-xs text-muted">Open it from your home screen, like an app.</div>
          </div>
          <Button
            variant="primary"
            size="sm"
            className="shrink-0 h-9"
            onClick={() => {
              dismiss();
              void install();
            }}
          >
            Install
          </Button>
          <button type="button" onClick={dismiss} aria-label="Not now" className="h-9 w-9 -mr-1 shrink-0 grid place-items-center rounded-md text-subtle hover:bg-inset hover:text-ink">
            <X size={16} />
          </button>
        </div>
      )}
      <IosSteps open={iosHelp} onClose={closeIosHelp} />
    </>
  );
}

function IosSteps({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Install Iklipse on your iPhone" size="sm" footer={<Button variant="primary" onClick={onClose}>Got it</Button>}>
      <div className="flex items-center gap-3 mb-4">
        <img src={ICON} alt="" className="h-12 w-12 rounded-xl shrink-0" />
        <p className="text-sm text-muted">Add Iklipse to your home screen and it opens full screen, straight into the system.</p>
      </div>
      <ol className="space-y-3 text-sm text-ink">
        <Step n={1}>
          Open this page in <b>Safari</b>, then tap <Share size={15} className="inline -mt-0.5 text-accent" aria-label="Share" /> <b>Share</b> at the bottom of the screen.
        </Step>
        <Step n={2}>
          Scroll down and tap <SquarePlus size={15} className="inline -mt-0.5 text-accent" aria-hidden /> <b>Add to Home Screen</b>.
        </Step>
        <Step n={3}>
          Tap <b>Add</b>. The Iklipse icon appears on your home screen.
        </Step>
      </ol>
    </Modal>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="h-6 w-6 shrink-0 grid place-items-center rounded-full bg-accent-soft text-accent text-xs font-semibold">{n}</span>
      <span className="pt-0.5 leading-relaxed">{children}</span>
    </li>
  );
}

