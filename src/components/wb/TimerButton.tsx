import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, Square, Timer } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { fetchState, saveState, type WbState as TimerRow } from "@/lib/wb/api";
import { useWb } from "@/lib/wb/store";

// -----------------------------------------------------------------------------
// Shared countdown in the top bar (Miro's timer). wb_state holds it: running =
// timer_ends_at, paused = timer_left_ms, timer_total_ms = its full length.
// Every tab ticks from those values, so everyone sees the same time; only
// editors control it. When it runs out each open tab chimes and says so.
// -----------------------------------------------------------------------------

const PRESETS = [1, 3, 5, 10, 15];
const MINUTE = 60_000;
/** wb_state's check constraint: 24 hours. */
const MAX_MS = 24 * 60 * MINUTE;

type Phase = "idle" | "running" | "paused";

function phaseOf(st: TimerRow | null | undefined, now: number): { phase: Phase; left: number } {
  if (st?.timer_ends_at) {
    const left = Date.parse(st.timer_ends_at) - now;
    return left > 0 ? { phase: "running", left } : { phase: "idle", left: 0 };
  }
  if (st?.timer_left_ms != null && st.timer_left_ms > 0) return { phase: "paused", left: st.timer_left_ms };
  return { phase: "idle", left: 0 };
}

/** mm:ss, or h:mm:ss past an hour. Rounds up so 0:00 means done. */
function fmt(ms: number) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

let audio: AudioContext | null = null;
function audioCtx(): AudioContext | null {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    audio ??= new Ctx();
    if (audio.state === "suspended") void audio.resume().catch(() => undefined);
    return audio;
  } catch {
    return null;
  }
}

/** Three soft rising notes. */
function chime() {
  const ctx = audioCtx();
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime + 0.03;
    [880, 1175, 1568].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      const t = t0 + i * 0.18;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.95);
    });
  } catch {
    /* no audio */
  }
}

/** Shared countdown: top-bar button, popover to set / start / pause / stop, live display. */
export function TimerButton({ boardId }: { boardId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const canEdit = useWb((s) => s.canEdit);
  const key = ["wb-state", boardId] as const;
  const st = useQuery({ queryKey: key, queryFn: () => fetchState(boardId), enabled: !!boardId, staleTime: 60_000 }).data;
  const [now, setNow] = useState(() => Date.now());
  const { phase, left } = phaseOf(st, now);
  const running = phase === "running";
  const endsAt = st?.timer_ends_at ? Date.parse(st.timer_ends_at) : null;
  const total = st?.timer_total_ms ?? null;
  const [pick, setPick] = useState(5);
  const [custom, setCustom] = useState("5");

  // Fresh clock whenever the row changes, then tick while it runs.
  useEffect(() => setNow(Date.now()), [st]);
  useEffect(() => {
    if (!running) return;
    const iv = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(iv);
  }, [running]);

  // Time's up: only for a run this tab saw (not one that ended before it opened).
  const armed = useRef<number | null>(null);
  useEffect(() => {
    if (endsAt && endsAt > now) armed.current = endsAt;
    else if (endsAt && armed.current === endsAt) {
      armed.current = null;
      chime();
      const length = total ? (total % MINUTE ? fmt(total) : `${total / MINUTE} min`) : null;
      toast.push({ kind: "info", title: "Time's up", description: length ? `The ${length} timer has ended.` : undefined });
    } else if (!endsAt) armed.current = null;
  }, [endsAt, now, total, toast]);

  // Default the picker to the last length used.
  useEffect(() => {
    if (!total) return;
    const m = Math.max(1, Math.round(total / MINUTE));
    setPick(m);
    setCustom(String(m));
  }, [total]);

  const save = async (patch: Partial<Pick<TimerRow, "timer_ends_at" | "timer_left_ms" | "timer_total_ms">>) => {
    const before = qc.getQueryData<TimerRow | null>(key);
    const base: TimerRow = before ?? {
      board_id: boardId,
      timer_ends_at: null,
      timer_left_ms: null,
      timer_total_ms: null,
      timer_by: null,
      updated_at: new Date().toISOString(),
    };
    qc.setQueryData<TimerRow | null>(key, { ...base, ...patch });
    setNow(Date.now());
    try {
      await saveState(boardId, patch);
    } catch (e) {
      qc.setQueryData(key, before);
      toast.push({ kind: "error", title: "Couldn't update the timer", description: (e as Error).message });
    } finally {
      void qc.invalidateQueries({ queryKey: key });
    }
  };

  const minutes = Math.min(MAX_MS / MINUTE, Math.max(1, Math.round(Number(custom)) || pick));
  const start = (ms: number) => {
    audioCtx(); // unlock sound while we have a click
    void save({ timer_ends_at: new Date(Date.now() + ms).toISOString(), timer_left_ms: null, timer_total_ms: ms });
  };
  const pause = () => void save({ timer_ends_at: null, timer_left_ms: Math.max(1000, Math.round(left)) });
  const resume = () => void save({ timer_ends_at: new Date(Date.now() + left).toISOString(), timer_left_ms: null });
  const addMinute = () => {
    const nextTotal = Math.min(MAX_MS, (total ?? left) + MINUTE);
    if (running && endsAt) void save({ timer_ends_at: new Date(Math.min(endsAt + MINUTE, Date.now() + MAX_MS)).toISOString(), timer_total_ms: nextTotal });
    else if (phase === "paused") void save({ timer_left_ms: Math.min(MAX_MS, left + MINUTE), timer_total_ms: nextTotal });
  };
  const stop = () => void save({ timer_ends_at: null, timer_left_ms: null, timer_total_ms: null });

  const active = phase !== "idle";
  const urgent = running && left < 10_000;
  const progress = active && total ? Math.min(1, Math.max(0, left / total)) : 0;

  return (
    <Menu
      align="right"
      trigger={
        <button
          type="button"
          onClick={() => audioCtx()}
          className={cn(
            "relative h-9 shrink-0 rounded-md transition-colors",
            active
              ? cn("min-w-9 px-2.5 inline-flex items-center gap-1.5 bg-accent-soft text-sm font-semibold tabular-nums", urgent ? "text-danger" : "text-accent")
              : "w-9 grid place-items-center text-muted hover:bg-inset hover:text-ink aria-expanded:bg-accent-soft aria-expanded:text-accent",
          )}
          title={active ? (phase === "paused" ? "Timer paused" : "Timer") : "Timer"}
          aria-label={active ? `Timer, ${fmt(left)} left${phase === "paused" ? ", paused" : ""}` : "Timer"}
        >
          {active ? (
            <>
              {phase === "paused" ? <Pause size={14} /> : <Timer size={15} />}
              <span>{fmt(left)}</span>
            </>
          ) : (
            <Timer size={17} />
          )}
        </button>
      }
    >
      {(close) => (
        <div className="w-[280px] max-w-full p-3" data-wb-ui>
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-ink">Timer</span>
            {active && <span className="text-xs text-subtle">{phase === "paused" ? "Paused" : "Running"}</span>}
          </div>

          {active ? (
            <>
              <div className={cn("py-3 text-center text-3xl font-semibold tabular-nums", urgent ? "text-danger" : "text-ink")}>{fmt(left)}</div>
              <div className="h-1.5 rounded-full bg-inset overflow-hidden" aria-hidden>
                <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${progress * 100}%` }} />
              </div>
              {canEdit ? (
                <div className="mt-3 flex gap-1.5">
                  <Button
                    variant="primary"
                    className="flex-1"
                    iconLeft={running ? <Pause size={15} /> : <Play size={15} />}
                    onClick={running ? pause : resume}
                  >
                    {running ? "Pause" : "Resume"}
                  </Button>
                  <Button disabled={(total ?? 0) >= MAX_MS} onClick={addMinute}>
                    +1 min
                  </Button>
                  <button
                    type="button"
                    className="h-9 w-9 shrink-0 grid place-items-center rounded-md border border-border bg-surface text-ink hover:bg-inset transition-colors"
                    onClick={() => {
                      stop();
                      close();
                    }}
                    title="Stop"
                    aria-label="Stop timer"
                  >
                    <Square size={14} />
                  </button>
                </div>
              ) : (
                <p className="mt-3 text-xs text-subtle">Only editors can control the timer.</p>
              )}
            </>
          ) : canEdit ? (
            <>
              <div className="mt-2.5 grid grid-cols-5 gap-1">
                {PRESETS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      setPick(m);
                      setCustom(String(m));
                    }}
                    className={cn(
                      "h-9 rounded-md text-sm tabular-nums transition-colors",
                      minutes === m ? "bg-accent-soft text-accent font-semibold" : "bg-inset text-ink hover:bg-border/70",
                    )}
                    aria-pressed={minutes === m}
                  >
                    {m}m
                  </button>
                ))}
              </div>
              <label className="mt-2.5 flex items-center gap-2 text-sm text-muted">
                Minutes
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={MAX_MS / MINUTE}
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      start(minutes * MINUTE);
                      close();
                    }
                  }}
                  className="h-9 w-20 min-w-0 bg-surface border border-border rounded-md px-2.5 text-lg sm:text-base text-ink tabular-nums focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:outline-none"
                />
              </label>
              <Button
                variant="primary"
                className="mt-3 w-full"
                iconLeft={<Play size={15} />}
                onClick={() => {
                  start(minutes * MINUTE);
                  close();
                }}
              >
                Start {minutes} min
              </Button>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted">No timer running. Editors can start one for everyone.</p>
          )}
        </div>
      )}
    </Menu>
  );
}
