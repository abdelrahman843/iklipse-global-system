import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { format } from "date-fns";
import { CheckCircle2, Clock, Link2Off } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { PageSpinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { ItemGrid } from "@/components/deliveries/viewer/ItemGrid";
import { MediaViewer } from "@/components/deliveries/viewer/MediaViewer";
import { ProtectionProvider, hiddenBlur, useProtection } from "@/components/deliveries/viewer/Protection";
import { SubmitBar } from "@/components/deliveries/viewer/SubmitBar";
import {
  IdentifyFirst,
  openDelivery,
  saveWho,
  savedWho,
  submitDelivery,
  visitorComment,
  visitorDownload,
  visitorMedia,
  visitorRemoveComment,
  type DeliveryState,
  type ItemKind,
  type MediaLinks,
  type OpenedDelivery,
} from "@/lib/deliveriesApi";
import { cn } from "@/lib/cn";

// -----------------------------------------------------------------------------
// A delivery opened from a client link (/d/<token>): no account and no way
// into the app (no links, no logo link, no back button). The client says who
// they are once per device, looks through the files, comments on images and
// videos (videos at a second), then sends feedback or approves.
// -----------------------------------------------------------------------------

type Phase =
  | { s: "loading" }
  | { s: "identify"; error?: string }
  | { s: "error"; message: string }
  | { s: "ready"; data: OpenedDelivery };

/** Errors that end the visit (shown full page) rather than fixable form errors. */
const FATAL = /not valid|turned off|expired|most devices|most people/i;
const MEDIA_EVERY = 12 * 60_000;
const RETRY_GAP = 30_000;

export default function DeliveryViewPage() {
  const { token = "" } = useParams();
  const [phase, setPhase] = useState<Phase>({ s: "loading" });

  const load = useCallback(
    async (who?: { name: string; email: string }) => {
      try {
        const data = await openDelivery(token, who);
        if (who) saveWho(who.name, who.email);
        setPhase({ s: "ready", data });
      } catch (e) {
        if (e instanceof IdentifyFirst) return setPhase({ s: "identify" });
        const message = (e as Error).message || "This link is not valid";
        if (who && !FATAL.test(message)) return setPhase({ s: "identify", error: message });
        setPhase({ s: "error", message });
      }
    },
    [token],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    document.title = phase.s === "ready" ? `${phase.data.folder.title} · iklipse` : "iklipse";
  }, [phase]);

  if (phase.s === "loading") return <PageSpinner />;
  if (phase.s === "error") return <Notice message={phase.message} />;
  if (phase.s === "identify") return <Identify error={phase.error} onSubmit={(who) => load(who)} />;
  return (
    <ProtectionProvider email={phase.data.viewer.email}>
      <Delivery token={token} data={phase.data} reload={() => load()} />
    </ProtectionProvider>
  );
}

// ---------------------------------------------------------------- wordmark --
function Wordmark() {
  // Plain text on purpose: never a link into the app.
  return <span className="display text-[18px] text-ink select-none">iklipse</span>;
}

function Notice({ message }: { message: string }) {
  return (
    <div className="min-h-dvh bg-bg flex flex-col">
      <div className="px-4 sm:px-6 h-16 flex items-center">
        <Wordmark />
      </div>
      <div className="flex-1 grid place-items-center px-4 pb-16">
        <div className="max-w-sm text-center animate-scale-in">
          <Link2Off size={28} className="mx-auto text-subtle" />
          <h1 className="mt-4 text-xl font-semibold text-ink">{message}</h1>
          <p className="mt-2 text-base text-muted">If you still need these files, ask the iklipse team to send you a new link.</p>
        </div>
      </div>
    </div>
  );
}

function Identify({ error, onSubmit }: { error?: string; onSubmit: (who: { name: string; email: string }) => Promise<void> }) {
  const [who, setWho] = useState(savedWho);
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<string | null>(null);
  const shown = local ?? error;

  return (
    <div className="min-h-dvh bg-bg flex flex-col">
      <div className="px-4 sm:px-6 h-16 flex items-center">
        <Wordmark />
      </div>
      <div className="flex-1 grid place-items-center px-4 pb-16">
        <form
          className="w-full max-w-sm animate-scale-in"
          onSubmit={async (e) => {
            e.preventDefault();
            const name = who.name.trim();
            const email = who.email.trim();
            if (!name) return setLocal("Write your name");
            if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return setLocal("Check your email address");
            setLocal(null);
            setBusy(true);
            await onSubmit({ name, email });
            setBusy(false);
          }}
        >
          <h1 className="text-xl font-semibold text-ink">Open delivery</h1>
          <p className="mt-1 text-base text-muted">Tell us who you are, so the team knows who the comments are from.</p>
          <div className="mt-6 space-y-4">
            <div>
              <label htmlFor="dv-name" className="block text-sm font-medium text-ink mb-1">
                Name
              </label>
              <Input
                id="dv-name"
                autoComplete="name"
                autoFocus
                maxLength={60}
                value={who.name}
                onChange={(e) => setWho((w) => ({ ...w, name: e.target.value }))}
              />
            </div>
            <div>
              <label htmlFor="dv-email" className="block text-sm font-medium text-ink mb-1">
                Email
              </label>
              <Input
                id="dv-email"
                type="email"
                autoComplete="email"
                inputMode="email"
                maxLength={120}
                value={who.email}
                onChange={(e) => setWho((w) => ({ ...w, email: e.target.value }))}
              />
            </div>
          </div>
          {shown && <p className="mt-3 text-sm text-danger">{shown}</p>}
          <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-6 w-full">
            Open delivery
          </Button>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- delivery --
const STATE_TEXT: Record<DeliveryState, string> = {
  open: "Waiting for your feedback",
  submitted: "Feedback sent",
  approved: "Approved",
};

type Filter = "all" | ItemKind;
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "image", label: "Images" },
  { id: "video", label: "Videos" },
  { id: "file", label: "Files" },
  { id: "link", label: "Links" },
];

function Delivery({ token, data, reload }: { token: string; data: OpenedDelivery; reload: () => Promise<void> }) {
  const toast = useToast();
  const { hidden } = useProtection();
  const [comments, setComments] = useState(data.comments);
  const [{ urls, drive }, setLinks] = useState<MediaLinks>({ urls: {}, drive: {} });
  const [filter, setFilter] = useState<Filter>("all");
  const [viewing, setViewing] = useState<string | null>(null);
  const asked = useRef<Record<string, number>>({});
  const retryTimer = useRef<number>();
  // Latest reload without making the media effects re-run on every render.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const { folder, round, link } = data;
  const open = folder.state === "open";

  useEffect(() => setComments(data.comments), [data.comments]);

  // ------------------------------------------------------------ media urls --
  // Images and videos are previewed (from storage or straight from Google
  // Drive); other files only download, via visitorDownload, when allowed.
  const allowDownload = link.allow_download;
  const mediaIds = useMemo(
    () => data.items.filter((i) => i.kind === "image" || i.kind === "video" || (i.kind === "file" && allowDownload)).map((i) => i.id),
    [data.items, allowDownload],
  );

  const fetchUrls = useCallback(
    async (ids: string[], retry = true) => {
      if (!ids.length) return;
      const now = Date.now();
      for (const id of ids) asked.current[id] = now;
      try {
        const fresh = await visitorMedia(token, ids);
        // Drive links never change, and the player keeps the link it started
        // with until it fails, so a renewal doesn't restart a playing video.
        setLinks((m) => ({ urls: { ...m.urls, ...fresh.urls }, drive: { ...m.drive, ...fresh.drive } }));
      } catch (e) {
        // This device has to say who it is again: show the form.
        if (e instanceof IdentifyFirst) return void reloadRef.current();
        // One more try in a moment (a network blip); after that, the next renewal.
        if (retry) {
          window.clearTimeout(retryTimer.current);
          retryTimer.current = window.setTimeout(() => void fetchUrls(ids, false), RETRY_GAP);
        }
      }
    },
    [token],
  );

  useEffect(() => {
    void fetchUrls(mediaIds);
    // Signed links last 15 minutes: renew them before they run out.
    const t = window.setInterval(() => void fetchUrls(mediaIds), MEDIA_EVERY);
    return () => {
      window.clearInterval(t);
      window.clearTimeout(retryTimer.current);
    };
  }, [fetchUrls, mediaIds]);

  // A picture or video failed (most likely its link ran out): ask again, at
  // most every 30 seconds per item so a broken file can't loop.
  const onMediaError = useCallback(
    (id: string) => {
      if (Date.now() - (asked.current[id] ?? 0) < RETRY_GAP) return;
      void fetchUrls([id]);
    },
    [fetchUrls],
  );

  // ------------------------------------------------------------ the folder --
  const kinds = useMemo(() => new Set(data.items.map((i) => i.kind)), [data.items]);
  const shown = useMemo(() => (filter === "all" ? data.items : data.items.filter((i) => i.kind === filter)), [data.items, filter]);
  // What the viewer steps through: pictures and videos.
  const media = useMemo(() => shown.filter((i) => i.kind === "image" || i.kind === "video"), [shown]);
  const counts = useMemo(() => {
    if (!open) return null;
    const c: Record<string, number> = {};
    for (const k of comments) if (k.item_id) c[k.item_id] = (c[k.item_id] ?? 0) + 1;
    return c;
  }, [comments, open]);
  const myCount = comments.filter((c) => c.mine).length;
  // The server accepts feedback when anyone on the link commented this round.
  const guestCount = comments.filter((c) => c.guest).length;
  const viewIndex = viewing ? media.findIndex((i) => i.id === viewing) : -1;

  const download = async (id: string) => {
    try {
      window.location.href = await visitorDownload(token, id);
    } catch (e) {
      if (e instanceof IdentifyFirst) return void reload();
      toast.push({ kind: "error", title: (e as Error).message || "Couldn't get the file" });
    }
  };

  const submit = async (kind: "feedback" | "approved", note: string) => {
    try {
      await submitDelivery(token, kind, note);
      toast.push({ kind: "success", title: kind === "approved" ? "Approved. Thank you!" : "Feedback sent. Thank you!" });
      await reload();
    } catch (e) {
      if (e instanceof IdentifyFirst) {
        await reload();
        throw e;
      }
      const msg = (e as Error).message || "Couldn't send it";
      toast.push({ kind: "error", title: msg });
      if (/already sent/i.test(msg)) await reload();
      throw e;
    }
  };

  const doneOn = round.submitted_at ? format(new Date(round.submitted_at), "MMM d, yyyy") : null;

  return (
    <div className="dv-protect min-h-dvh bg-bg">
      <div className={cn("transition-[filter]", hiddenBlur(hidden), open && "pb-24")}>
        {/* Header */}
        <header className="px-4 sm:px-6">
          <div className="h-16 flex items-center justify-between gap-3 border-b border-line">
            <Wordmark />
            <span className="min-w-0 truncate text-sm text-muted">
              Viewing as <span className="font-medium text-ink">{data.viewer.name}</span>
            </span>
          </div>

          <div className="pt-8 pb-6">
            {folder.client && <div className="text-sm font-medium uppercase tracking-eyebrow text-muted">{folder.client}</div>}
            <h1 className="mt-1 text-2xl font-semibold tracking-display text-ink [overflow-wrap:anywhere]">{folder.title}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-base">
              <span className="text-muted">Round {folder.round}</span>
              <span className="h-1 w-1 rounded-full bg-subtle" aria-hidden />
              <StateBadge state={folder.state} />
              {link.expires_at && (
                <>
                  <span className="h-1 w-1 rounded-full bg-subtle" aria-hidden />
                  <span className="text-muted">Link open until {format(new Date(link.expires_at), "MMM d, yyyy")}</span>
                </>
              )}
            </div>
            {folder.note && (
              <p className="mt-4 max-w-2xl text-base text-ink whitespace-pre-wrap [overflow-wrap:anywhere]">{folder.note}</p>
            )}
          </div>

          {folder.state === "submitted" && (
            <Banner tone="calm" icon={<Clock size={18} />}>
              Feedback sent{doneOn ? ` on ${doneOn}` : ""}. We'll share the next round on this same link.
            </Banner>
          )}
          {folder.state === "approved" && (
            <Banner tone="success" icon={<CheckCircle2 size={18} />}>
              Approved{doneOn ? ` on ${doneOn}` : ""}. Thank you, the team has been told.
            </Banner>
          )}
        </header>

        {/* Files */}
        <main className="px-4 sm:px-6 pt-2 pb-12">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
            <h2 className="text-base font-semibold text-ink">
              Files <span className="font-normal text-muted">{data.items.length}</span>
            </h2>
            {kinds.size > 1 && (
              <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Show">
                {FILTERS.filter((f) => f.id === "all" || kinds.has(f.id as ItemKind)).map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    role="tab"
                    aria-selected={filter === f.id}
                    onClick={() => setFilter(f.id)}
                    className={cn(
                      "h-8 rounded-full px-3 text-sm font-medium transition-colors",
                      filter === f.id ? "bg-ink text-bg" : "bg-inset text-muted hover:text-ink",
                    )}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="pt-6">
            {shown.length ? (
              <ItemGrid
                items={shown}
                urls={urls}
                drive={drive}
                counts={counts}
                canDownload={link.allow_download}
                onOpen={(it) => setViewing(it.id)}
                onDownload={(id) => void download(id)}
                onMediaError={onMediaError}
              />
            ) : (
              <p className="py-16 text-center text-base text-muted">Nothing here yet.</p>
            )}
          </div>
        </main>
      </div>

      {open && !viewing && <SubmitBar myComments={myCount} guestComments={guestCount} onSubmit={submit} />}

      {viewIndex >= 0 && (
        <MediaViewer
          items={media}
          index={viewIndex}
          onIndex={(i) => setViewing(media[i]?.id ?? null)}
          onClose={() => setViewing(null)}
          urls={urls}
          drive={drive}
          onMediaError={onMediaError}
          comments={comments}
          open={open}
          canDownload={link.allow_download}
          onDownload={(id) => void download(id)}
          onAdd={async (item, body, at) => {
            try {
              const c = await visitorComment(token, item, body, at);
              setComments((list) => [...list, c]);
            } catch (e) {
              if (e instanceof IdentifyFirst) void reload();
              throw e;
            }
          }}
          onRemove={async (id) => {
            try {
              await visitorRemoveComment(token, id);
              setComments((list) => list.filter((c) => c.id !== id));
            } catch (e) {
              if (e instanceof IdentifyFirst) void reload();
              throw e;
            }
          }}
        />
      )}
    </div>
  );
}

function StateBadge({ state }: { state: DeliveryState }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 h-6 text-sm font-medium",
        state === "open" && "bg-accent-soft text-accent",
        state === "submitted" && "bg-inset text-ink",
        state === "approved" && "bg-success/15 text-success",
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          state === "open" ? "bg-accent" : state === "approved" ? "bg-success" : "bg-muted",
        )}
      />
      {STATE_TEXT[state]}
    </span>
  );
}

function Banner({ tone, icon, children }: { tone: "calm" | "success"; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "mb-6 flex items-start gap-3 rounded-lg px-4 py-3 text-base",
        tone === "success" ? "bg-success/10 text-ink" : "bg-inset text-ink",
      )}
      role="status"
    >
      <span className={cn("mt-px shrink-0", tone === "success" ? "text-success" : "text-muted")}>{icon}</span>
      <span>{children}</span>
    </div>
  );
}

