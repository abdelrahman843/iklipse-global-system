import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { BellOff, Check, Phone, PhoneOff, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Emblem } from "@/components/Brand";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { appRing } from "@/lib/nativeApp";
import { answerCall, closeAlert, declineCall, endCall, fetchCallAudio, fetchMyCall, hushPhones, snoozeAlert, type WatchCall as Call } from "@/lib/watchApi";

// -----------------------------------------------------------------------------
// Ikli calling me (0068): when nobody acts on a WhatsApp watch alert, Ikli
// calls each person on it inside iklipse. This is the incoming call screen: it
// rings until I answer or decline; answering plays what Ikli says (Claude's
// words in the voice agent's voice), then Handled / Snooze / Hang up. Ikli's
// voice is fetched while it rings, so it speaks the moment it's answered. With
// the app closed, the same call reaches the phone as a ringing notification
// (or a real ringing call, with the Android app).
// -----------------------------------------------------------------------------

let ctx: AudioContext | null = null;

/** A silent sound: played inside the Answer tap, it lets the page play Ikli's voice a moment later (phones allow sound only from a tap). */
const SILENT = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

/**
 * A call rings here for at most this long (the server counts it missed after
 * about 55 seconds), so a page that missed the news can't ring forever.
 */
const RING_LIMIT_MS = 60_000;

/** Closes Ikli's "calling you" notifications on this device. */
function closeCallNotifications() {
  navigator.serviceWorker?.ready
    .then((reg) => reg.getNotifications())
    .then((ns) => ns.filter((n) => n.tag?.startsWith("watch-call-")).forEach((n) => n.close()))
    .catch(() => {});
}

/**
 * The ring: a soft rising chime (three bell notes, quiet) every 3 seconds,
 * and a light buzz on phones. Only while the page is on screen: a hidden tab
 * or a closed app rings through the phone's notification instead. Everything
 * it started stops with it.
 */
function useRingtone(on: boolean) {
  useEffect(() => {
    if (!on) return;
    let stop = false;
    const sounding = new Set<OscillatorNode>();
    const ring = () => {
      if (stop || document.visibilityState !== "visible") return;
      try {
        ctx ??= new AudioContext();
        void ctx.resume();
        const t = ctx.currentTime;
        // C, E, G: each note a sine with a faint octave above it, like a small bell.
        for (const [i, f] of [523.25, 659.25, 783.99].entries()) {
          const at = t + i * 0.2;
          for (const [mult, peak] of [
            [1, 0.05],
            [2, 0.008],
          ] as const) {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.type = "sine";
            o.frequency.value = f * mult;
            g.gain.setValueAtTime(0.0001, at);
            g.gain.exponentialRampToValueAtTime(peak, at + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, at + 1.1);
            o.connect(g).connect(ctx.destination);
            o.onended = () => sounding.delete(o);
            sounding.add(o);
            o.start(at);
            o.stop(at + 1.15);
          }
        }
        navigator.vibrate?.([200, 120, 200]);
      } catch {
        /* no sound here: the screen still shows */
      }
    };
    ring();
    const id = window.setInterval(ring, 3000);
    const hidden = () => document.visibilityState !== "visible" && navigator.vibrate?.(0);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      stop = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", hidden);
      for (const o of sounding) {
        try {
          o.stop();
        } catch {
          /* already stopped */
        }
      }
      navigator.vibrate?.(0);
    };
  }, [on]);
}

export function WatchCall() {
  const qc = useQueryClient();
  const toast = useToast();
  // Looked at often while a call is on (answered on another device: this one stops).
  const call = useQuery({
    queryKey: ["watch-call"],
    queryFn: fetchMyCall,
    refetchInterval: (q) => (q.state.data ? 4_000 : 15_000),
    refetchOnWindowFocus: true,
  });
  // Calls I already answered or declined here (the server may still say ringing for a moment).
  const [done, setDone] = useState<Record<string, true>>({});
  const [live, setLive] = useState<{ call: Call; words: string | null; url: string | null; ended: boolean; at: number } | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  // Ikli's voice for the ringing call, ready before it's answered.
  const voice = useRef<{ id: string; url: string } | null>(null);
  // The browser wouldn't play Ikli's voice by itself (opened from the notification): one tap plays it.
  const [needsTap, setNeedsTap] = useState(false);
  const [, tick] = useState(0);
  const [params, setParams] = useSearchParams();

  const shown = call.data && !done[call.data.id] && !live ? call.data : null;
  // Rings for a minute from the start of the call; after that it shows as missed.
  const [overAt, setOverAt] = useState<string | null>(null);
  const missed = !!shown && (overAt === shown.id || Date.now() - Date.parse(shown.started_at) >= RING_LIMIT_MS);
  useEffect(() => {
    if (!shown) return;
    const left = RING_LIMIT_MS - (Date.now() - Date.parse(shown.started_at));
    if (left <= 0) return;
    const id = window.setTimeout(() => setOverAt(shown.id), left);
    return () => window.clearTimeout(id);
  }, [shown]);
  useRingtone(!!shown && !missed);
  // The Windows app: comes to the front while it rings.
  const ringing = !!shown && !missed;
  useEffect(() => {
    appRing(ringing);
    return () => appRing(false);
  }, [ringing]);

  useEffect(() => {
    const path = shown?.audio;
    const id = shown?.id;
    if (!path || !id || voice.current?.id === id) return;
    let gone = false;
    fetchCallAudio(path)
      .then((blob) => {
        if (gone || !blob) return;
        if (voice.current) URL.revokeObjectURL(voice.current.url);
        voice.current = { id, url: URL.createObjectURL(blob) };
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [shown?.id, shown?.audio]);

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

  /** Inside a tap: makes the page allowed to play sound. */
  const unlock = () => {
    const el = audio.current ?? new Audio();
    audio.current = el;
    el.src = SILENT;
    el.play().catch(() => {});
  };
  const play = () => {
    const el = audio.current;
    if (!el) return;
    el.play()
      .then(() => setNeedsTap(false))
      .catch(() => setNeedsTap(true));
  };

  const startVoice = (url: string) => {
    const el = audio.current ?? new Audio();
    audio.current = el;
    el.src = url;
    el.onended = () => setLive((l) => (l ? { ...l, ended: true } : l));
    play();
  };

  // "talking": Ikli already speaks (its voice was ready); this only tells the server.
  const answer = useMutation({
    mutationFn: ({ c, talking }: { c: Call; talking: boolean }) => answerCall(c.id, !talking),
    onMutate: ({ c }) => (setDone((d) => ({ ...d, [c.id]: true })), closeCallNotifications()),
    onSuccess: (r, { c, talking }) => {
      hushPhones(c.id);
      if (!talking) {
        const url = r.audio ? URL.createObjectURL(r.audio) : null;
        setLive({ call: c, words: r.words, url, ended: !url, at: Date.now() });
        if (url) startVoice(url);
      }
      after();
    },
    onError: (e: Error, { c, talking }) => {
      if (!talking) {
        setDone((d) => {
          const n = { ...d };
          delete n[c.id];
          return n;
        });
        toast.push({ kind: "error", title: "Couldn't answer", description: e.message });
      }
      after();
    },
  });
  /** Answer (inside the tap when there is one): Ikli speaks right away when its voice is ready. */
  const pickUp = (c: Call) => {
    const v = voice.current?.id === c.id ? voice.current : null;
    if (v) {
      voice.current = null; // the call owns it now (let go on hang up)
      setLive({ call: c, words: c.words, url: v.url, ended: false, at: Date.now() });
      startVoice(v.url);
    } else unlock();
    answer.mutate({ c, talking: !!v });
  };
  const decline = useMutation({
    mutationFn: (c: Call) => declineCall(c.id),
    onMutate: (c) => (setDone((d) => ({ ...d, [c.id]: true })), closeCallNotifications()),
    onSuccess: (_r, c) => hushPhones(c.id),
    onSettled: after,
  });
  // Answer on the phone's notification: the app opens on the call (?call=<id>&answer=1) and answers it.
  const auto = params.get("answer") === "1" ? params.get("call") : null;
  useEffect(() => {
    if (!auto || !shown || shown.id !== auto || answer.isPending) return;
    const next = new URLSearchParams(params);
    next.delete("answer");
    next.delete("call");
    setParams(next, { replace: true });
    pickUp(shown);
  }, [auto, shown, answer, params, setParams]);

  const hangUp = () => {
    audio.current?.pause();
    setNeedsTap(false);
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

  const c = live?.call ?? shown;
  if (!c) return null;
  const secs = live ? Math.floor((Date.now() - live.at) / 1000) : 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={live ? "Call with Ikli" : missed ? "Missed call from Ikli" : "Ikli is calling"}
      className="frame-dark print:hidden fixed inset-0 z-[80] flex flex-col items-center bg-frame text-ink animate-fade-in safe-pad"
    >
      <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-4 sm:gap-6 overflow-y-auto px-5 sm:px-6 py-4 text-center w-full max-w-md">
        <div className="relative grid h-24 w-24 sm:h-32 sm:w-32 shrink-0 place-items-center">
          {!live && !missed && <span className="absolute inset-0 rounded-full bg-accent/25 animate-ping" aria-hidden />}
          <span className={cn("absolute inset-2 rounded-full bg-accent/15", live && !live.ended && "animate-pulse")} aria-hidden />
          <span className="relative grid h-[4.5rem] w-[4.5rem] sm:h-24 sm:w-24 place-items-center rounded-full bg-accent-soft ring-1 ring-accent/30">
            <Emblem className="w-9 sm:w-12 text-accent" />
          </span>
        </div>
        <div>
          <div className="text-sm text-muted">{live ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : missed ? "Missed call" : "Calling you"}</div>
          <div className="mt-1 text-xl sm:text-2xl font-extrabold tracking-[-0.03em]">Ikli</div>
          <div className="mt-2 sm:mt-3 text-sm sm:text-base font-semibold break-words">{c.title}</div>
          {c.group && <div className="mt-1 text-sm text-muted">{c.group}</div>}
        </div>
        {live?.words && <p className="max-w-sm text-[13px] sm:text-sm leading-relaxed text-ink/80 break-words animate-fade-in">{live.words}</p>}
        {live && needsTap && (
          <Button variant="primary" size="lg" iconLeft={<Volume2 size={16} />} onClick={play}>
            Tap to hear Ikli
          </Button>
        )}
      </div>

      <div className="w-full max-w-md shrink-0 px-6 pb-8 sm:pb-10 pt-3">
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
              {missed ? "Close" : "Decline"}
            </button>
            <button
              type="button"
              onClick={() => pickUp(c)}
              disabled={answer.isPending}
              className="flex flex-col items-center gap-2 text-sm text-muted"
              aria-label="Answer"
            >
              <span className="grid h-16 w-16 place-items-center rounded-full bg-success text-white shadow-pop transition-transform duration-150 hover:scale-105 active:scale-95">
                <Phone size={26} />
              </span>
              {missed ? "Listen" : "Answer"}
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
