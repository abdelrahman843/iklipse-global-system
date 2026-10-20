import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellOff, BellRing, Check, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { closeAlert, fetchRinging, snoozeAlert, type RingingAlert } from "@/lib/watchApi";
import { WatchCall } from "@/components/WatchCall";

// -----------------------------------------------------------------------------
// The alarm: watch alerts ringing for me (0067; WhatsApp groups, Slack channels and email)
// stay on screen, on every page, until I mark them handled or snooze them.
// Each new ring beeps (and buzzes a phone). Closing the card only hides it
// until the next ring. Ikli's calls (WatchCall) show over everything, on
// every page.
// -----------------------------------------------------------------------------

let audio: AudioContext | null = null;

/** Three short beeps, when the browser lets the page make sound. */
function beep() {
  try {
    audio ??= new AudioContext();
    void audio.resume();
    const t = audio.currentTime;
    for (let i = 0; i < 3; i++) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = "sine";
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, t + i * 0.28);
      g.gain.exponentialRampToValueAtTime(0.25, t + i * 0.28 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.28 + 0.2);
      o.connect(g).connect(audio.destination);
      o.start(t + i * 0.28);
      o.stop(t + i * 0.28 + 0.22);
    }
    navigator.vibrate?.([200, 100, 200, 100, 400]);
  } catch {
    /* no sound here */
  }
}

export function WatchAlarm() {
  const qc = useQueryClient();
  const toast = useToast();
  const location = useLocation();
  const ringing = useQuery({ queryKey: ["watch-ringing"], queryFn: fetchRinging, refetchInterval: 60_000, refetchOnWindowFocus: true });
  // alert id -> the ring it was hidden at
  const [hidden, setHidden] = useState<Record<string, number>>({});
  const heard = useRef<Record<string, number>>({});

  const list = (ringing.data ?? []).filter((a) => hidden[a.id] !== a.alerts_sent);

  // A watch push reached this device (the service worker says so): look now, not in 15 seconds.
  useEffect(() => {
    const sw = navigator.serviceWorker;
    if (!sw) return;
    const onMessage = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type !== "iklipse-watch") return;
      void qc.invalidateQueries({ queryKey: ["watch-call"] });
      void qc.invalidateQueries({ queryKey: ["watch-ringing"] });
    };
    sw.addEventListener("message", onMessage);
    return () => sw.removeEventListener("message", onMessage);
  }, [qc]);

  // A new ring (or a new alert): beep.
  useEffect(() => {
    let fresh = false;
    for (const a of ringing.data ?? []) {
      if ((heard.current[a.id] ?? 0) < a.alerts_sent) fresh = true;
      heard.current[a.id] = a.alerts_sent;
    }
    if (fresh && document.visibilityState === "visible") beep();
  }, [ringing.data]);

  const after = () => {
    void qc.invalidateQueries({ queryKey: ["watch-ringing"] });
    void qc.invalidateQueries({ queryKey: ["watch-alerts"] });
    void qc.invalidateQueries({ queryKey: ["watch-overview"] });
  };
  const handled = useMutation({
    mutationFn: (id: string) => closeAlert(id),
    onSuccess: () => (after(), toast.push({ kind: "success", title: "Marked as handled" })),
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't mark it", description: e.message }),
  });
  const snooze = useMutation({
    mutationFn: (id: string) => snoozeAlert(id, 15),
    onSuccess: () => (after(), toast.push({ kind: "success", title: "Quiet for 15 minutes" })),
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't snooze it", description: e.message }),
  });

  // The Alerts page shows them itself.
  if (!list.length || location.pathname.startsWith("/alerts")) return <WatchCall />;
  const a: RingingAlert = list[0];
  const more = list.length - 1;

  return (
    <>
    <WatchCall />
    <div
      role="alertdialog"
      aria-label="Alert"
      className={cn(
        "print:hidden fixed z-[60] inset-x-3 top-[calc(0.75rem+env(safe-area-inset-top))] md:inset-x-auto md:top-auto md:right-5 md:bottom-5 md:w-[380px]",
        "rounded-xl border border-danger/30 bg-surface shadow-pop animate-fade-in",
      )}
    >
      <div className="flex items-start gap-3 p-3.5">
        <span className="relative mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-danger/10 text-danger">
          <span className="absolute inset-0 rounded-full bg-danger/20 animate-ping" aria-hidden />
          <BellRing size={17} className="relative" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-ink break-words">{a.title}</div>
          {a.detail && <div className="mt-0.5 text-sm text-muted break-words line-clamp-2">{a.detail}</div>}
          <div className="mt-1 text-xs text-subtle">
            {a.source === "email" ? (a.group ? `Email: ${a.group}` : "Email") : a.source === "slack" ? (a.group ?? "Slack channel") : (a.group ?? "WhatsApp group")} · alert {a.alerts_sent}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setHidden((h) => ({ ...h, [a.id]: a.alerts_sent }))}
          className="-mr-1 -mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-md text-subtle hover:bg-inset hover:text-ink"
          aria-label="Hide until it rings again"
          title="Hide until it rings again"
        >
          <X size={16} />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-3.5 py-2.5">
        <Button size="sm" variant="primary" iconLeft={<Check size={14} />} loading={handled.isPending} onClick={() => handled.mutate(a.id)}>
          Handled
        </Button>
        <Button size="sm" iconLeft={<BellOff size={14} />} loading={snooze.isPending} onClick={() => snooze.mutate(a.id)}>
          15 min
        </Button>
        <Link to={`/alerts?a=${a.id}`} className="ml-auto text-sm text-accent hover:underline">
          {more > 0 ? `Open (+${more} more)` : "Open"}
        </Link>
      </div>
    </div>
    </>
  );
}
