import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellOff, Check, Phone, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Emblem } from "@/components/Brand";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { answerCall, closeAlert, declineCall, endCall, fetchMyCall, snoozeAlert, type WatchCall as Call } from "@/lib/watchApi";

// -----------------------------------------------------------------------------
// Ikli calling me (0068): when nobody acts on a WhatsApp watch alert, Ikli
// calls each person on it inside iklipse. This is the incoming call screen: it
// rings until I answer or decline; answering plays what Ikli says (Claude's
// words in the voice agent's voice), then Handled / Snooze / Hang up. With the
// app closed, the same call reaches the phone as a ringing notification.
// -----------------------------------------------------------------------------

let ctx: AudioContext | null = null;

/** The ring: two soft pulses every 2.4 seconds, and a buzz on phones. */
function useRingtone(on: boolean) {
  useEffect(() => {
    if (!on) return;
    let stop = false;
    const ring = () => {
      if (stop) return;
      try {
        ctx ??= new AudioContext();
        void ctx.resume();
        const t = ctx.currentTime;
        for (const at of [0, 0.4]) {
          for (const f of [440, 480]) {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.frequency.value = f;
            g.gain.setValueAtTime(0.0001, t + at);
            g.gain.exponentialRampToValueAtTime(0.12, t + at + 0.03);
            g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.32);
            o.connect(g).connect(ctx.destination);
            o.start(t + at);
            o.stop(t + at + 0.34);
          }
        }
        navigator.vibrate?.([400, 200, 400]);
      } catch {
        /* no sound here: the screen still shows */
      }
    };
    ring();
    const id = window.setInterval(ring, 2400);
    return () => {
      stop = true;
      window.clearInterval(id);
      navigator.vibrate?.(0);
    };
  }, [on]);
}

export function WatchCall() {
  const qc = useQueryClient();
  const toast = useToast();
  const call = useQuery({ queryKey: ["watch-call"], queryFn: fetchMyCall, refetchInterval: 15_000, refetchOnWindowFocus: true });
  // Calls I already answered or declined here (the server may still say ringing for a moment).
  const [done, setDone] = useState<Record<string, true>>({});
  const [live, setLive] = useState<{ call: Call; words: string | null; url: string | null; ended: boolean; at: number } | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [, tick] = useState(0);

  const ringing = call.data && !done[call.data.id] && !live ? call.data : null;
  useRingtone(!!ringing);

  // The call timer.
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [live]);

  // Stop the voice when the screen goes.
  useEffect(() => {
    return () => {
      audio.current?.pause();
      if (live?.url) URL.revokeObjectURL(live.url);
    };
  }, [live?.url]);

  const after = () => {
    void qc.invalidateQueries({ queryKey: ["watch-call"] });
    void qc.invalidateQueries({ queryKey: ["watch-ringing"] });
    void qc.invalidateQueries({ queryKey: ["watch-alerts"] });
    void qc.invalidateQueries({ queryKey: ["watch-overview"] });
  };

  const answer = useMutation({
    mutationFn: (c: Call) => answerCall(c.id),
    onMutate: (c) => setDone((d) => ({ ...d, [c.id]: true })),
    onSuccess: (r, c) => {
      const url = r.audio ? URL.createObjectURL(r.audio) : null;
      setLive({ call: c, words: r.words, url, ended: !url, at: Date.now() });
      if (url) {
        const el = new Audio(url);
        audio.current = el;
        el.onended = () => setLive((l) => (l ? { ...l, ended: true } : l));
        el.play().catch(() => setLive((l) => (l ? { ...l, ended: true } : l)));
      }
      after();
    },
    onError: (e: Error, c) => {
      setDone((d) => {
        const n = { ...d };
        delete n[c.id];
        return n;
      });
      toast.push({ kind: "error", title: "Couldn't answer", description: e.message });
      after();
    },
  });
  const decline = useMutation({
    mutationFn: (c: Call) => declineCall(c.id),
    onMutate: (c) => setDone((d) => ({ ...d, [c.id]: true })),
    onSettled: after,
  });
  const hangUp = () => {
    audio.current?.pause();
    if (live) void endCall(live.call.id);
    setLive(null);
    after();
  };
  const handled = useMutation({
    mutationFn: (alertId: string) => closeAlert(alertId),
    onSuccess: () => (hangUp(), toast.push({ kind: "success", title: "Marked as handled", description: "It stops ringing for everyone." })),
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't mark it", description: e.message }),
  });
  const snooze = useMutation({
    mutationFn: (alertId: string) => snoozeAlert(alertId, 15),
    onSuccess: () => (hangUp(), toast.push({ kind: "success", title: "Quiet for 15 minutes" })),
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't snooze it", description: e.message }),
  });

  const c = live?.call ?? ringing;
  if (!c) return null;
  const secs = live ? Math.floor((Date.now() - live.at) / 1000) : 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={live ? "Call with Ikli" : "Ikli is calling"}
      className="frame-dark print:hidden fixed inset-0 z-[80] flex flex-col items-center bg-frame/95 backdrop-blur-xl text-ink animate-fade-in safe-pad"
    >
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center w-full max-w-md">
        <div className="relative grid h-32 w-32 place-items-center">
          {!live && <span className="absolute inset-0 rounded-full bg-accent/25 animate-ping" aria-hidden />}
          <span className={cn("absolute inset-2 rounded-full bg-accent/15", live && !live.ended && "animate-pulse")} aria-hidden />
          <span className="relative grid h-24 w-24 place-items-center rounded-full bg-accent-soft ring-1 ring-accent/30">
            <Emblem className="w-12 text-accent" />
          </span>
        </div>
        <div>
          <div className="text-sm text-muted">{live ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : "Calling you"}</div>
          <div className="mt-1 text-2xl font-extrabold tracking-[-0.03em]">Ikli</div>
          <div className="mt-3 font-semibold break-words">{c.title}</div>
          {c.group && <div className="mt-1 text-sm text-muted">{c.group}</div>}
        </div>
        {live?.words && <p className="max-w-sm text-base leading-relaxed text-ink/90 break-words animate-fade-in">{live.words}</p>}
      </div>

      <div className="w-full max-w-md px-6 pb-10 pt-4">
        {!live ? (
          <div className="flex items-center justify-around">
            <button
              type="button"
              onClick={() => decline.mutate(c)}
              className="flex flex-col items-center gap-2 text-sm text-muted"
              aria-label="Decline"
            >
              <span className="grid h-16 w-16 place-items-center rounded-full bg-danger text-white shadow-pop transition-transform duration-150 hover:scale-105 active:scale-95">
                <PhoneOff size={26} />
              </span>
              Decline
            </button>
            <button
              type="button"
              onClick={() => answer.mutate(c)}
              disabled={answer.isPending}
              className="flex flex-col items-center gap-2 text-sm text-muted"
              aria-label="Answer"
            >
              <span className="grid h-16 w-16 place-items-center rounded-full bg-success text-white shadow-pop transition-transform duration-150 hover:scale-105 active:scale-95 animate-bounce">
                <Phone size={26} />
              </span>
              Answer
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {c.alert_id && (
              <div className="grid grid-cols-2 gap-2">
                <Button variant="primary" size="lg" iconLeft={<Check size={16} />} loading={handled.isPending} onClick={() => handled.mutate(c.alert_id!)}>
                  Handled
                </Button>
                <Button size="lg" iconLeft={<BellOff size={16} />} loading={snooze.isPending} onClick={() => snooze.mutate(c.alert_id!)}>
                  15 min
                </Button>
              </div>
            )}
            <Button variant="danger" size="lg" iconLeft={<PhoneOff size={16} />} onClick={hangUp}>
              Hang up
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
