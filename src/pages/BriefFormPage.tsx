import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AlertCircle, ArrowLeft, ArrowRight, Check, Pencil, Send } from "lucide-react";
import { LogoLoader } from "@/components/ui/Spinner";
import {
  AutoTextarea,
  BriefInput,
  BriefMark,
  MoodboardField,
  PromiseFields,
  RepeatFields,
  VoiceScale,
  shrinkImage,
  type UploadingImage,
} from "@/components/brief/BriefControls";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { loadBriefFonts } from "@/lib/brief/fonts";
import {
  BRAND_WORKSHOP,
  answered,
  briefFormByKey,
  briefProgress,
  promiseSentence,
  sectionDone,
  type BriefAnswers,
  type BriefForm,
  type BriefImage,
  type BriefQuestion,
} from "@/lib/brief/forms";
import {
  openBrief,
  removeBriefImage,
  saveBrief,
  signVisitorImages,
  submitBrief,
  uploadBriefImage,
  type BriefOpen,
} from "@/lib/brief/api";

// -----------------------------------------------------------------------------
// A brief opened from its link (/b/<token>): no account. The first device to
// open it keeps it; answers save as they're typed (on the device and on the
// server), every question needs an answer, and sending closes the link.
// /brief-preview?form=<key> shows the same form to the team, nothing saved.
// -----------------------------------------------------------------------------

type Screen = "welcome" | number | "review" | "done";
type SaveState = "idle" | "saving" | "saved" | "error";

const CONTACT = { email: "info@iklipseworld.com", site: "iklipseworld.com" };
const draftKey = (token: string) => `iklipse.brief.draft.${token}`;

export default function BriefFormPage({ preview = false }: { preview?: boolean }) {
  const { token = "" } = useParams();
  const [params] = useSearchParams();
  const { ready, session, briefRole } = useAuth();
  const [state, setState] = useState<BriefOpen | { status: "loading" } | { status: "error"; message: string } | { status: "gate" }>(
    { status: "loading" },
  );
  const [attempt, setAttempt] = useState(0);
  const [goAnyway, setGoAnyway] = useState(false);

  useEffect(() => {
    loadBriefFonts();
    document.title = "Brand Workshop · iklipse";
    const meta = document.querySelector('meta[name="theme-color"]');
    const was = meta?.getAttribute("content");
    meta?.setAttribute("content", "#06080b");
    return () => {
      document.title = "iklipse system";
      if (was) meta?.setAttribute("content", was);
    };
  }, []);

  useEffect(() => {
    if (preview) {
      const form = briefFormByKey(params.get("form") ?? "") ?? BRAND_WORKSHOP;
      setState({ status: "open", form: form.key, label: params.get("for") || "Preview", note: null, questions: form, answers: {}, from: null });
      return;
    }
    if (!ready) return;
    // Someone from the team opening a client's link would use it up.
    if (session && briefRole && !goAnyway) return setState({ status: "gate" });
    let alive = true;
    setState({ status: "loading" });
    openBrief(token)
      .then((r) => alive && setState(r))
      .catch((e: Error) => alive && setState({ status: "error", message: e.message }));
    return () => {
      alive = false;
    };
  }, [preview, params, ready, session, briefRole, goAnyway, token, attempt]);

  return (
    <div className="brief min-h-dvh relative isolate">
      {state.status === "loading" && (
        <div className="fixed inset-0 grid place-items-center">
          <LogoLoader width={120} />
        </div>
      )}
      {state.status === "open" && (
        <BriefRunner
          token={preview ? null : token}
          form={state.questions}
          label={state.label}
          note={state.note}
          from={state.from}
          initial={state.answers}
        />
      )}
      {state.status === "gate" && <TeamGate onOpen={() => setGoAnyway(true)} />}
      {state.status === "submitted" && (
        <Notice title="Already sent." text={state.mine ? "Your answers reached the iklipse team. Thank you." : "This brief was already answered."} />
      )}
      {state.status === "used" && (
        <Notice
          title="Opened on another device."
          text="For your privacy, a brief opens on one device only, the first one that opened it. Go back to that device, or ask the person who sent you the link to unlock it for this one."
        />
      )}
      {state.status === "off" && <Notice title="This link is closed." text="Ask the person who sent it for a new one." />}
      {state.status === "invalid" && <Notice title="This link doesn't work." text="Check that you copied the whole link, or ask the person who sent it for a new one." />}
      {state.status === "error" && (
        <Notice title="Couldn't open the brief." text="Check your connection and try again.">
          <button type="button" className="brief-btn mt-8" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </Notice>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- frames --
function Header({ progress, right }: { progress?: number; right?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-30 pt-[env(safe-area-inset-top)] bg-[rgb(var(--c-column)/0.72)] backdrop-blur-md">
      <div className="mx-auto max-w-[1240px] h-16 px-5 sm:px-8 lg:px-12 flex items-center gap-4">
        <BriefMark />
        <div className="ml-auto flex items-center gap-4 text-[13px] text-subtle min-w-0">{right}</div>
      </div>
      {progress !== undefined && (
        <div className="h-[2px] bg-ink/10">
          <div className="h-full bg-accent transition-[width] duration-700 ease-out shadow-[0_0_12px_rgb(var(--c-accent)/0.8)]" style={{ width: `${progress}%` }} />
        </div>
      )}
    </header>
  );
}

function Notice({ title, text, children }: { title: string; text: string; children?: React.ReactNode }) {
  return (
    <>
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="brief-arc opacity-60" />
        <div className="brief-scrim" />
      </div>
      <Header />
      <main className="relative z-10 mx-auto max-w-[1240px] px-5 sm:px-8 lg:px-12 min-h-[calc(100dvh-4rem)] flex flex-col justify-center pb-24">
        <h1 className="brief-serif text-[56px] sm:text-[88px] lg:text-[112px] brief-rise">{title}</h1>
        <p className="mt-6 max-w-[46ch] text-[17px] sm:text-[19px] font-extralight text-ink/85 brief-rise" style={{ ["--i" as string]: 1 }}>
          {text}
        </p>
        <div className="brief-rise" style={{ ["--i" as string]: 2 }}>
          {children}
        </div>
        <Contact className="mt-14 brief-rise" />
      </main>
    </>
  );
}

function Contact({ className }: { className?: string }) {
  return (
    <div className={cn("text-[14px]", className)} style={{ ["--i" as string]: 3 }}>
      <div className="brief-caps text-[11px] text-accent">Contact</div>
      <a href={`mailto:${CONTACT.email}`} className="block brief-label text-[17px] text-ink hover:text-accent">
        {CONTACT.email}
      </a>
      <a href={`https://${CONTACT.site}`} target="_blank" rel="noreferrer" className="block brief-label text-[17px] text-ink hover:text-accent">
        {CONTACT.site}
      </a>
    </div>
  );
}

function TeamGate({ onOpen }: { onOpen: () => void }) {
  const nav = useNavigate();
  return (
    <Notice
      title="This link is for your client."
      text="You're signed in to iklipse. A brief link works on the first device that opens it, so opening it here uses it up for this device. To see the questions, open the preview instead."
    >
      <div className="mt-8 flex flex-wrap gap-3">
        <button type="button" className="brief-btn" onClick={() => nav("/brief-preview")}>
          Open the preview
        </button>
        <button type="button" className="brief-btn brief-btn-ghost" onClick={onOpen}>
          Open it here anyway
        </button>
      </div>
    </Notice>
  );
}

// ---------------------------------------------------------------- runner --
function BriefRunner({
  token,
  form,
  label,
  note,
  from,
  initial,
}: {
  token: string | null;
  form: BriefForm;
  label: string;
  note: string | null;
  from: string | null;
  initial: BriefAnswers;
}) {
  // The device's own copy wins: it's never older than what reached the server.
  const [answers, setAnswers] = useState<BriefAnswers>(() => {
    if (!token) return initial;
    try {
      const local = JSON.parse(localStorage.getItem(draftKey(token)) ?? "null") as { answers?: BriefAnswers } | null;
      if (local?.answers && Object.keys(local.answers).length) return { ...initial, ...local.answers };
    } catch {
      /* no local copy */
    }
    return initial;
  });
  const started = Object.keys(answers).length > 0;
  const [screen, setScreen] = useState<Screen>("welcome");
  const [dir, setDir] = useState<"next" | "prev">("next");
  const [showErrors, setShowErrors] = useState<Set<number>>(new Set());
  const [save, setSave] = useState<SaveState>("idle");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [shake, setShake] = useState(0);
  const progress = briefProgress(form, answers);
  const total = form.sections.length;

  // ------------------------------------------------------------ saving --
  const dirty = useRef(false);
  const timer = useRef<number>();
  const latest = useRef(answers);
  latest.current = answers;
  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    if (!token || !dirty.current) return;
    dirty.current = false;
    setSave("saving");
    try {
      await saveBrief(token, latest.current, briefProgress(form, latest.current));
      setSave((s) => (dirty.current ? s : "saved"));
    } catch {
      dirty.current = true;
      setSave("error");
      timer.current = window.setTimeout(() => void flush(), 6000);
    }
  }, [token, form]);

  // A value, or a function of the current one (uploads finishing one by one).
  const update = useCallback(
    (key: string, value: unknown) => {
      setAnswers((a) => {
        const v = typeof value === "function" ? (value as (prev: unknown) => unknown)(a[key]) : value;
        const next = { ...a, [key]: v };
        if (token) {
          try {
            localStorage.setItem(draftKey(token), JSON.stringify({ answers: next, at: Date.now() }));
          } catch {
            /* full or blocked: the server copy still saves */
          }
          dirty.current = true;
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => void flush(), 1200);
        }
        return next;
      });
    },
    [token, flush],
  );

  useEffect(() => {
    const hide = () => document.visibilityState === "hidden" && void flush();
    const leave = (e: BeforeUnloadEvent) => {
      if (dirty.current) {
        void flush();
        e.preventDefault();
      }
    };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("beforeunload", leave);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("beforeunload", leave);
      window.clearTimeout(timer.current);
    };
  }, [flush]);

  // --------------------------------------------------------- moodboard --
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState<UploadingImage[]>([]);
  const imagesKey = form.sections.flatMap((s) => s.questions).find((q) => q.type === "images")?.key;
  const images = (imagesKey && Array.isArray(answers[imagesKey]) ? answers[imagesKey] : []) as BriefImage[];
  useEffect(() => {
    if (!token) return;
    const missing = images.map((i) => i.path).filter((p) => !urls[p]);
    if (!missing.length) return;
    signVisitorImages(token, missing)
      .then((u) => setUrls((cur) => ({ ...cur, ...u })))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, images.length]);

  const addFiles = async (files: File[]) => {
    if (!imagesKey) return;
    for (const raw of files) {
      const id = Math.random().toString(36).slice(2);
      const preview = URL.createObjectURL(raw);
      setUploading((u) => [...u, { id, preview }]);
      try {
        let img: BriefImage;
        if (token) {
          const file = await shrinkImage(raw);
          const r = await uploadBriefImage(token, file);
          img = { path: r.path, name: raw.name.slice(0, 120) };
          setUrls((cur) => ({ ...cur, [r.path]: r.url || preview }));
        } else {
          img = { path: `preview/${id}`, name: raw.name };
          setUrls((cur) => ({ ...cur, [img.path]: preview }));
        }
        setUploading((u) => u.filter((x) => x.id !== id));
        update(imagesKey, (prev: unknown) => [...(Array.isArray(prev) ? (prev as BriefImage[]) : []), img]);
      } catch (e) {
        setUploading((u) => u.map((x) => (x.id === id ? { ...x, error: (e as Error).message } : x)));
        window.setTimeout(() => setUploading((u) => u.filter((x) => x.id !== id)), 5000);
      }
    }
  };
  const removeImage = (img: BriefImage) => {
    if (!imagesKey) return;
    update(imagesKey, (prev: unknown) => (Array.isArray(prev) ? (prev as BriefImage[]) : []).filter((i) => i.path !== img.path));
    if (token && !img.path.startsWith("preview/")) void removeBriefImage(token, img.path).catch(() => undefined);
  };

  // ---------------------------------------------------------- navigation --
  const go = (to: Screen, d: "next" | "prev" = "next") => {
    setDir(d);
    setScreen(to);
    setConfirming(false);
    setSendError(null);
    void flush();
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  };
  const missingIn = (i: number) => form.sections[i].questions.filter((q) => !answered(q, answers[q.key]));

  const next = (i: number) => {
    const missing = missingIn(i);
    if (missing.length) {
      setShowErrors((s) => new Set(s).add(i));
      setShake((n) => n + 1);
      document.getElementById(`q-${missing[0].key}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    go(i + 1 < total ? i + 1 : "review");
  };

  const send = async () => {
    const firstMissing = form.sections.findIndex((s) => !sectionDone(s, answers));
    if (firstMissing >= 0) {
      setShowErrors((s) => new Set(s).add(firstMissing));
      return go(firstMissing, "prev");
    }
    if (!token) return go("done");
    setSending(true);
    setSendError(null);
    try {
      window.clearTimeout(timer.current);
      await submitBrief(token, answers);
      dirty.current = false;
      try {
        localStorage.removeItem(draftKey(token));
      } catch {
        /* ignore */
      }
      go("done");
    } catch (e) {
      setSendError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  // ----------------------------------------------------------- render --
  const step = typeof screen === "number" ? screen : null;
  const saveLabel =
    !token ? "Preview · nothing is saved" : save === "saving" ? "Saving…" : save === "saved" ? "Saved" : save === "error" ? "Not saved yet, retrying" : null;

  if (screen === "done") return <Done label={label} preview={!token} />;

  return (
    <>
      <div className="fixed inset-0 overflow-hidden pointer-events-none -z-0">
        {screen === "welcome" ? (
          <>
            <div className="brief-arc" />
            <div className="brief-scrim" />
          </>
        ) : (
          <div className="brief-glow opacity-70" />
        )}
      </div>
      <Header
        progress={screen === "welcome" ? undefined : progress}
        right={
          <>
            {saveLabel && (
              <span className={cn("hidden sm:inline-flex items-center gap-1.5 truncate", save === "error" && "text-warn")}>
                {save === "saved" && <Check size={13} className="text-success" />}
                {save === "error" && <AlertCircle size={13} />}
                {saveLabel}
              </span>
            )}
            {step !== null && (
              <span className="brief-caps tabular-nums text-ink/80">
                {String(step + 1).padStart(2, "0")} <span className="text-subtle">/ {String(total).padStart(2, "0")}</span>
              </span>
            )}
            {screen === "review" && <span className="brief-caps text-ink/80">Review</span>}
          </>
        }
      />

      <main className="relative z-10 mx-auto max-w-[1240px] px-5 sm:px-8 lg:px-12">
        {screen === "welcome" && (
          <Welcome form={form} label={label} note={note} from={from} started={started} preview={!token} onStart={() => go(started ? firstOpen(form, answers) : 0)} />
        )}

        {step !== null && (
          <div className="lg:grid lg:grid-cols-[230px_minmax(0,1fr)] lg:gap-16 pt-8 sm:pt-12 pb-28">
            <Outline form={form} answers={answers} current={step} onPick={(i) => go(i, i < step ? "prev" : "next")} />
            <div key={step} className={dir === "next" ? "brief-in-next" : "brief-in-prev"}>
              <Section
                form={form}
                index={step}
                answers={answers}
                update={update}
                showErrors={showErrors.has(step)}
                moodboard={{ urls, uploading, onFiles: addFiles, onRemove: removeImage }}
              />
              <div className="mt-14 flex flex-wrap items-center gap-3">
                {step > 0 ? (
                  <button type="button" className="brief-btn brief-btn-ghost" onClick={() => go(step - 1, "prev")}>
                    <ArrowLeft size={16} /> Back
                  </button>
                ) : (
                  <button type="button" className="brief-btn brief-btn-ghost" onClick={() => go("welcome", "prev")}>
                    <ArrowLeft size={16} /> Start
                  </button>
                )}
                <button key={shake} type="button" className={cn("brief-btn", shake > 0 && "brief-shake")} onClick={() => next(step)}>
                  {step + 1 < total ? (
                    <>
                      <span>
                        Next<span className="hidden sm:inline">: {form.sections[step + 1].title}</span>
                      </span>
                      <ArrowRight size={16} />
                    </>
                  ) : (
                    <>
                      Review answers <ArrowRight size={16} />
                    </>
                  )}
                </button>
                {showErrors.has(step) && missingIn(step).length > 0 && (
                  <span className="basis-full sm:basis-auto text-[14px] text-danger flex items-center gap-1.5">
                    <AlertCircle size={15} />
                    {missingIn(step).length === 1 ? "One answer is missing above." : `${missingIn(step).length} answers are missing above.`}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {screen === "review" && (
          <Review
            form={form}
            answers={answers}
            onEdit={(i) => {
              setShowErrors((s) => new Set(s).add(i));
              go(i, "prev");
            }}
            onBack={() => go(total - 1, "prev")}
            confirming={confirming}
            setConfirming={setConfirming}
            onSend={send}
            sending={sending}
            error={sendError}
            preview={!token}
          />
        )}
      </main>
    </>
  );
}

function firstOpen(form: BriefForm, answers: BriefAnswers): Screen {
  const i = form.sections.findIndex((s) => !sectionDone(s, answers));
  return i < 0 ? "review" : i;
}

// --------------------------------------------------------------- welcome --
function Welcome({
  form,
  label,
  note,
  from,
  started,
  preview,
  onStart,
}: {
  form: BriefForm;
  label: string;
  note: string | null;
  from: string | null;
  started: boolean;
  preview: boolean;
  onStart: () => void;
}) {
  return (
    <section className="min-h-[calc(100dvh-4rem)] flex flex-col justify-center py-14 sm:py-20">
      <p className="brief-caps text-[13px] sm:text-[14px] text-ink/75 brief-rise">Prepared for {label}</p>
      <h1 className="brief-serif mt-3 text-[64px] sm:text-[112px] lg:text-[150px] brief-rise" style={{ ["--i" as string]: 1 }}>
        {form.title}
      </h1>
      {note && (
        <blockquote className="mt-8 max-w-[56ch] border-l-2 border-accent pl-4 brief-rise" style={{ ["--i" as string]: 2 }}>
          <p className="text-[17px] sm:text-[18px] text-ink/90 whitespace-pre-line" dir="auto">
            {note}
          </p>
          {from && <footer className="mt-2 brief-caps text-[12px] text-subtle">{from}, iklipse</footer>}
        </blockquote>
      )}

      <div className="mt-12 sm:mt-16 max-w-[880px] brief-rise" style={{ ["--i" as string]: 3 }}>
        <h2 className="brief-head text-[34px] sm:text-[48px] text-ink/95 normal-case tracking-[-0.045em]">Workshop outline</h2>
        <ol className="mt-6 space-y-2.5 sm:space-y-2">
          {form.sections.map((s, i) => (
            <li key={s.id} className="sm:flex sm:items-baseline brief-caps text-[13px] sm:text-[15px] text-ink/90">
              <span className="text-accent tabular-nums mr-3">{String(i + 1).padStart(2, "0")}</span>
              <span>{s.title}</span>
              <span className="brief-leader hidden sm:block mx-3" />
              <span className="block sm:inline pl-8 sm:pl-0 text-[12px] sm:text-[15px] text-subtle sm:text-ink/90">{s.about}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="mt-12 flex flex-wrap items-center gap-x-6 gap-y-4 brief-rise" style={{ ["--i" as string]: 4 }}>
        <button type="button" className="brief-btn" onClick={onStart}>
          {started ? "Continue where you left off" : "Start the workshop"} <ArrowRight size={16} />
        </button>
        <span className="text-[14px] text-subtle">
          {form.sections.length} sections · about {form.minutes} minutes · saves as you type
        </span>
      </div>
      <p className="mt-6 max-w-[60ch] text-[13px] text-subtle brief-rise" style={{ ["--i" as string]: 5 }}>
        {preview
          ? "This is a preview for the team. Nothing you type here is saved or sent."
          : "Every question needs an answer. This link works on this device only, and closes once you send your answers. You can stop and come back any time on this device."}
      </p>
    </section>
  );
}

// --------------------------------------------------------------- outline --
function Outline({ form, answers, current, onPick }: { form: BriefForm; answers: BriefAnswers; current: number; onPick: (i: number) => void }) {
  const active = useRef<HTMLButtonElement>(null);
  // Braces: newer browsers return a promise from scrollIntoView, which an effect must not return.
  useEffect(() => {
    active.current?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [current]);
  return (
    <nav aria-label="Sections" className="-mx-5 sm:-mx-8 lg:mx-0 mb-8 lg:mb-0 lg:sticky lg:top-24 lg:self-start">
      <ol className="flex lg:flex-col gap-1.5 overflow-x-auto no-scrollbar px-5 sm:px-8 lg:px-0">
        {form.sections.map((s, i) => {
          const done = sectionDone(s, answers);
          const here = i === current;
          return (
            <li key={s.id} className="shrink-0">
              <button
                ref={here ? active : undefined}
                type="button"
                onClick={() => onPick(i)}
                aria-current={here ? "step" : undefined}
                className={cn(
                  "group flex items-center gap-2.5 h-9 lg:h-auto lg:min-h-9 px-3 lg:px-0 rounded-full lg:rounded-none text-left transition-colors",
                  here ? "bg-ink/10 lg:bg-transparent text-ink" : "text-ink/55 hover:text-ink",
                )}
              >
                <span
                  className={cn(
                    "h-5 w-5 shrink-0 grid place-items-center rounded-full text-[10px] tabular-nums border transition-colors",
                    done ? "bg-accent border-accent text-white" : here ? "border-ink text-ink" : "border-ink/30",
                  )}
                >
                  {done ? <Check size={11} strokeWidth={3} /> : i + 1}
                </span>
                <span className={cn("brief-caps text-[12px] whitespace-nowrap lg:whitespace-normal lg:leading-tight", here && "lg:text-accent")}>{s.title}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// --------------------------------------------------------------- section --
function Section({
  form,
  index,
  answers,
  update,
  showErrors,
  moodboard,
}: {
  form: BriefForm;
  index: number;
  answers: BriefAnswers;
  update: (key: string, v: unknown) => void;
  showErrors: boolean;
  moodboard: { urls: Record<string, string>; uploading: UploadingImage[]; onFiles: (f: File[]) => void; onRemove: (i: BriefImage) => void };
}) {
  const s = form.sections[index];
  return (
    <article className="max-w-[760px]">
      <p className="brief-caps text-[12px] text-accent">
        {String(index + 1).padStart(2, "0")} · {s.about}
      </p>
      <h1 className="brief-head mt-3 text-[38px] sm:text-[56px] lg:text-[64px] break-words">{s.title}</h1>
      <p className="mt-5 text-[16px] sm:text-[18px] font-extralight text-ink/85 max-w-[62ch]">{s.intro}</p>

      {s.examples && (
        <div className="mt-8 grid sm:grid-cols-2 gap-3">
          {s.examples.map((e) => (
            <figure key={e.title} className="rounded-[4px] border border-ink/12 bg-ink/[0.03] px-5 py-4">
              <figcaption className="brief-caps text-[11px] text-subtle">{e.title}</figcaption>
              <blockquote className="mt-2 brief-serif text-[22px] leading-[1.15] text-ink/90">&ldquo;{e.quote}&rdquo;</blockquote>
            </figure>
          ))}
        </div>
      )}

      <div className="mt-12 space-y-12">
        {s.questions.map((q, qi) => (
          <Question key={q.key} n={`${index + 1}.${qi + 1}`} q={q} value={answers[q.key]} onChange={(v) => update(q.key, v)} showErrors={showErrors} moodboard={moodboard} />
        ))}
      </div>
    </article>
  );
}

function Question({
  n,
  q,
  value,
  onChange,
  showErrors,
  moodboard,
}: {
  n: string;
  q: BriefQuestion;
  value: unknown;
  onChange: (v: unknown) => void;
  showErrors: boolean;
  moodboard: { urls: Record<string, string>; uploading: UploadingImage[]; onFiles: (f: File[]) => void; onRemove: (i: BriefImage) => void };
}) {
  const missing = showErrors && !answered(q, value);
  const id = `a-${q.key}`;
  const text = typeof value === "string" ? value : "";
  return (
    <section id={`q-${q.key}`} className="scroll-mt-28">
      <div className="flex items-baseline gap-3">
        <span className="brief-caps text-[12px] text-subtle tabular-nums w-7 shrink-0">{n}</span>
        {q.type === "text" || q.type === "long" ? (
          <label htmlFor={id} className="brief-label text-[19px] sm:text-[22px] leading-snug">
            {q.label}
          </label>
        ) : (
          <h2 className="brief-label text-[19px] sm:text-[22px] leading-snug">{q.label}</h2>
        )}
      </div>
      {q.hint && <p className="mt-1.5 pl-10 text-[14px] sm:text-[15px] text-subtle">{q.hint}</p>}
      <div className="mt-4">
        {q.type === "text" && <BriefInput id={id} value={text} onChange={onChange} invalid={missing} autoComplete="organization" />}
        {q.type === "long" && <AutoTextarea id={id} value={text} onChange={onChange} invalid={missing} placeholder="Write as much as you like…" />}
        {q.type === "scale" && <VoiceScale q={q} value={value} onChange={onChange} showErrors={showErrors} />}
        {q.type === "fields" && <PromiseFields q={q} value={value} onChange={onChange} showErrors={showErrors} />}
        {q.type === "repeat" && <RepeatFields q={q} value={value} onChange={onChange} showErrors={showErrors} />}
        {q.type === "images" && (
          <MoodboardField q={q} images={Array.isArray(value) ? (value as BriefImage[]) : []} showErrors={showErrors} {...moodboard} />
        )}
      </div>
      {missing && (
        <p className="mt-2 text-[14px] text-danger flex items-center gap-1.5">
          <AlertCircle size={14} />
          {q.type === "images" ? `Add at least ${q.min === 1 ? "one image" : `${q.min} images`}.` : q.type === "scale" ? "Pick a point on every line." : "This needs an answer."}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- review --
function excerpt(q: BriefQuestion, v: unknown): string {
  if (!answered(q, v)) return "";
  switch (q.type) {
    case "text":
    case "long":
      return String(v).trim();
    case "scale":
      return "All lines answered";
    case "fields":
      return q.kind === "promise" ? promiseSentence(v) : "Answered";
    case "repeat":
      return (v as Record<string, string>[]).slice(0, q.count).map((x) => x.name).join(", ");
    case "images":
      return `${(v as unknown[]).length} image${(v as unknown[]).length === 1 ? "" : "s"}`;
  }
}

function Review({
  form,
  answers,
  onEdit,
  onBack,
  confirming,
  setConfirming,
  onSend,
  sending,
  error,
  preview,
}: {
  form: BriefForm;
  answers: BriefAnswers;
  onEdit: (i: number) => void;
  onBack: () => void;
  confirming: boolean;
  setConfirming: (v: boolean) => void;
  onSend: () => void;
  sending: boolean;
  error: string | null;
  preview: boolean;
}) {
  const missing = useMemo(() => form.sections.reduce((n, s) => n + s.questions.filter((q) => !answered(q, answers[q.key])).length, 0), [form, answers]);
  return (
    <div className="pt-10 sm:pt-16 pb-28 max-w-[880px] brief-in-next">
      <h1 className="brief-serif text-[56px] sm:text-[96px]">{missing ? "Nearly there." : "All done."}</h1>
      <p className="mt-5 text-[17px] sm:text-[18px] font-extralight text-ink/85 max-w-[58ch]">
        {missing
          ? `${missing === 1 ? "One question still needs" : `${missing} questions still need`} an answer. Everything else is saved.`
          : "Look over your answers. You can still change anything. Once you send them, this link closes."}
      </p>

      <ol className="mt-10 divide-y divide-ink/10 border-y border-ink/10">
        {form.sections.map((s, i) => {
          const left = s.questions.filter((q) => !answered(q, answers[q.key])).length;
          return (
            <li key={s.id} className="py-5 sm:py-6 grid sm:grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-3">
              <div className="min-w-0">
                <div className="flex items-baseline gap-3">
                  <span className="brief-caps text-[12px] text-accent tabular-nums">{String(i + 1).padStart(2, "0")}</span>
                  <h2 className="brief-caps text-[15px] sm:text-[16px] text-ink">{s.title}</h2>
                  {left > 0 ? (
                    <span className="text-[13px] text-danger whitespace-nowrap">{left} missing</span>
                  ) : (
                    <Check size={15} className="text-success shrink-0 self-center" />
                  )}
                </div>
                <dl className="mt-3 space-y-2 sm:pl-[2.4rem]">
                  {s.questions.map((q) => {
                    const t = excerpt(q, answers[q.key]);
                    return (
                      <div key={q.key} className="text-[14px] min-w-0">
                        <dt className="text-subtle">{q.label}</dt>
                        <dd className={cn("line-clamp-2 break-words", t ? "text-ink/90" : "text-danger")} dir="auto">
                          {t || "Not answered yet"}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              </div>
              <div>
                <button type="button" className="brief-btn brief-btn-ghost h-10 px-4 text-[14px]" onClick={() => onEdit(i)}>
                  <Pencil size={14} /> Edit
                </button>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="mt-10">
        {confirming && !missing ? (
          <div className="rounded-[4px] border border-accent/50 bg-accent/[0.08] p-5 sm:p-6 brief-in-next">
            <p className="brief-label text-[18px]">Send your answers now?</p>
            <p className="mt-1 text-[15px] text-ink/80">You won't be able to change them after this, and the link will close.</p>
            <div className="mt-5 flex flex-wrap gap-3">
              <button type="button" className="brief-btn" onClick={onSend} disabled={sending}>
                {sending ? <span className="h-4 w-4 rounded-full border-2 border-white border-r-transparent animate-spin" /> : <Send size={16} />}
                {preview ? "Finish the preview" : "Yes, send them"}
              </button>
              <button type="button" className="brief-btn brief-btn-ghost" onClick={() => setConfirming(false)} disabled={sending}>
                Keep editing
              </button>
            </div>
            {error && (
              <p className="mt-4 text-[14px] text-danger flex items-start gap-1.5">
                <AlertCircle size={15} className="mt-0.5 shrink-0" />
                {error}
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="brief-btn brief-btn-ghost" onClick={onBack}>
              <ArrowLeft size={16} /> Back
            </button>
            <button type="button" className="brief-btn" onClick={() => (missing ? onSend() : setConfirming(true))}>
              {missing ? (
                <>
                  Answer what's missing <ArrowRight size={16} />
                </>
              ) : (
                <>
                  <Send size={16} /> Send answers
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ done --
function Done({ label, preview }: { label: string; preview: boolean }) {
  return createPortal(
    <div className="brief fixed inset-0 z-50 overflow-y-auto">
      <div className="brief-sunset" />
      <div className="relative z-10 min-h-full flex flex-col">
        <div className="mx-auto w-full max-w-[1240px] h-16 px-5 sm:px-8 lg:px-12 flex items-center pt-[env(safe-area-inset-top)]">
          <BriefMark />
        </div>
        <div className="flex-1 mx-auto w-full max-w-[1240px] px-5 sm:px-8 lg:px-12 flex flex-col justify-center items-center text-center pb-16">
          <h1 className="brief-serif text-[54px] sm:text-[96px] lg:text-[128px] brief-rise" style={{ ["--i" as string]: 4 }}>
            May you brand in peace
          </h1>
          <p className="mt-6 max-w-[44ch] text-[17px] sm:text-[19px] font-extralight text-ink/90 brief-rise" style={{ ["--i" as string]: 6 }}>
            {preview
              ? "That's the end of the preview. Nothing was sent."
              : `Thank you${label && label !== "Preview" ? `, ${label}` : ""}. Your answers are with the iklipse team, and this link is now closed.`}
          </p>
          <Contact className="mt-14 brief-rise" />
        </div>
      </div>
    </div>,
    document.body,
  );
}
