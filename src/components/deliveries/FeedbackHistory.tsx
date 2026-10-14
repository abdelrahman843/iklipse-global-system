import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, ChevronRight, Download, ExternalLink, MessageSquare, Send } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { CommentRow, KindIcon, Thumb, day, fileSize, hostOf, roundSummary, useTeamUrls } from "./parts";
import {
  addTeamComment,
  setResolved,
  teamDownloadUrl,
  type Delivery,
  type DeliveryComment,
  type DeliveryRound,
  type ItemKind,
  type SnapshotItem,
} from "@/lib/deliveriesApi";

// -----------------------------------------------------------------------------
// Every feedback round of a delivery, newest first. The current one is open:
// the client's note, then the comments grouped by file, each with its resolved
// tick and the team's replies. Older rounds fold away and also say what the
// client had then. Used on the delivery page and (compact) on the project page.
// -----------------------------------------------------------------------------

interface Preview {
  id: string;
  kind: ItemKind;
  name: string;
  mime_type: string | null;
  size: number | null;
  storage_path: string | null;
  external_url: string | null;
}

export function FeedbackHistory({ delivery, onChanged, compact }: { delivery: Delivery; onChanged: () => void; compact?: boolean }) {
  // Open at first: the newest round with something in it (or the current one).
  const [openRounds, setOpenRounds] = useState<Set<number>>(() => {
    const said = delivery.rounds.find((r) => r.submitted_at || r.history?.length || delivery.comments.some((c) => c.round === r.number));
    return new Set([said?.number ?? delivery.round]);
  });
  const [preview, setPreview] = useState<Preview | null>(null);

  // Every file the delivery ever had (removed ones too), for names and thumbnails.
  const byId = useMemo(() => {
    const m = new Map<string, Preview>();
    for (const r of delivery.rounds) for (const i of r.items ?? []) m.set(i.id, { ...i });
    for (const i of delivery.items) m.set(i.id, i);
    return m;
  }, [delivery.items, delivery.rounds]);
  const urls = useTeamUrls(useMemo(() => [...byId.values()].filter((i) => i.kind === "image" || i.kind === "video").map((i) => i.storage_path), [byId]));

  const byRound = useMemo(() => {
    const m = new Map<number, DeliveryComment[]>();
    for (const c of delivery.comments) m.set(c.round, [...(m.get(c.round) ?? []), c]);
    return m;
  }, [delivery.comments]);

  const toggle = (n: number) =>
    setOpenRounds((s) => {
      const next = new Set(s);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  const anything = delivery.rounds.some((r) => r.submitted_at || r.history?.length) || delivery.comments.length > 0;
  if (!anything) {
    return <p className={cn("text-sm text-subtle", compact ? "py-2" : "py-6")}>No feedback yet. The client's comments show up here as soon as they write them.</p>;
  }

  return (
    <div className="divide-y divide-line border-b border-line">
      {delivery.rounds.map((r) => {
        const current = r.number === delivery.round;
        const open = openRounds.has(r.number);
        const comments = byRound.get(r.number) ?? [];
        const fromClient = comments.filter((c) => c.guest).length;
        // A round still open with nothing in it: nothing to show yet.
        if (current && !r.submitted_at && !r.history?.length && !comments.length && delivery.rounds.length > 1) {
          return (
            <div key={r.id} className="py-3 text-sm text-muted">
              <span className="font-semibold text-ink">Round {r.number}</span> · Waiting for the client
            </div>
          );
        }
        return (
          <section key={r.id} className="min-w-0">
            <button type="button" onClick={() => toggle(r.number)} aria-expanded={open} className="w-full -mx-2 px-2 flex items-center gap-2 py-3 text-left rounded-md group hover:bg-inset transition-colors">
              {open ? <ChevronDown size={16} className="shrink-0 text-muted" /> : <ChevronRight size={16} className="shrink-0 text-muted" />}
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className={cn("font-semibold text-ink group-hover:text-accent", compact ? "text-sm" : "text-base")}>Round {r.number}</span>
                  <span className={cn("text-muted", compact ? "text-xs" : "text-sm", r.outcome === "approved" && "text-success font-medium")}>
                    {r.outcome === "approved" && <CheckCircle2 size={12} className="inline -mt-0.5 mr-1" />}
                    {roundSummary(r)}
                  </span>
                  {!!r.history?.length && <span className="text-xs text-subtle">Reopened{r.history.length > 1 ? ` ${r.history.length} times` : ""}</span>}
                  {current && <span className="rounded-full bg-accent-soft px-2 py-px text-xs font-medium text-accent">Current</span>}
                </span>
              </span>
              {fromClient > 0 && (
                <span className="shrink-0 inline-flex items-center gap-1 text-xs text-muted tabular-nums">
                  <MessageSquare size={12} /> {fromClient}
                </span>
              )}
            </button>
            {open && (
              <RoundBody
                delivery={delivery}
                round={r}
                comments={comments}
                byId={byId}
                urls={urls}
                current={current}
                compact={!!compact}
                onPreview={setPreview}
                onChanged={onChanged}
              />
            )}
          </section>
        );
      })}
      {preview && <PreviewModal item={preview} url={preview.storage_path ? urls[preview.storage_path] : undefined} onClose={() => setPreview(null)} />}
    </div>
  );
}

function RoundBody({
  delivery,
  round,
  comments,
  byId,
  urls,
  current,
  compact,
  onPreview,
  onChanged,
}: {
  delivery: Delivery;
  round: DeliveryRound;
  comments: DeliveryComment[];
  byId: Map<string, Preview>;
  urls: Record<string, string>;
  current: boolean;
  compact: boolean;
  onPreview: (p: Preview) => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const resolve = useMutation({
    mutationFn: ({ id, v }: { id: string; v: boolean }) => setResolved(id, v),
    onSuccess: onChanged,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't update the comment", description: e.message }),
  });

  // Comments grouped by file, in the order the files were in; general ones last.
  const groups = useMemo(() => {
    const m = new Map<string, DeliveryComment[]>();
    for (const c of comments) m.set(c.item_id ?? "", [...(m.get(c.item_id ?? "") ?? []), c]);
    const order = (round.items ?? delivery.items).map((i) => i.id);
    return [...m.entries()].sort(([a], [b]) => {
      const ia = a ? order.indexOf(a) : Infinity;
      const ib = b ? order.indexOf(b) : Infinity;
      return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
    });
  }, [comments, round.items, delivery.items]);

  const sent = round.items ?? null;

  return (
    <div className={cn("pb-5 space-y-5", compact ? "pl-6" : "pl-6 sm:pl-7")}>
      {/* What the client sent before the team reopened the round: kept, oldest first. */}
      {(round.history ?? []).map((h, n) => (
        <div key={`${h.submitted_at}-${n}`} className="border-l-2 border-rule pl-3">
          <div className="text-xs font-medium text-muted">
            {h.submitted_name || "The client"} {h.outcome === "approved" ? "approved it" : "sent feedback"} on {day(h.submitted_at)}
            {" · "}reopened{h.reopened_by ? ` by ${h.reopened_by}` : ""} on {day(h.reopened_at)}
          </div>
          {h.client_note && <p className="mt-0.5 text-base text-ink/80 whitespace-pre-wrap break-words leading-relaxed">{h.client_note}</p>}
        </div>
      ))}

      {round.client_note && (
        <blockquote className="border-l-2 border-accent pl-3">
          <div className="text-xs font-medium text-muted">{round.submitted_name || "The client"} wrote</div>
          <p className="mt-0.5 text-base text-ink whitespace-pre-wrap break-words leading-relaxed">{round.client_note}</p>
        </blockquote>
      )}

      {!groups.length ? (
        <p className="text-sm text-subtle">{current && !round.submitted_at ? "No comments yet in this round." : "No comments in this round."}</p>
      ) : (
        <div className="space-y-5">
          {groups.map(([itemId, list]) => (
            <ItemThread
              key={itemId || "general"}
              delivery={delivery}
              item={itemId ? byId.get(itemId) ?? null : null}
              list={list}
              url={itemId ? (byId.get(itemId)?.storage_path ? urls[byId.get(itemId)!.storage_path!] : undefined) : undefined}
              canReply={current && !compact}
              onResolve={(id, v) => resolve.mutate({ id, v })}
              resolving={resolve.isPending}
              onPreview={onPreview}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}

      {/* What the client had in this round (kept when they sent feedback or the round closed). */}
      {sent && sent.length > 0 && (!current || round.submitted_at) && (
        <div>
          <div className="text-sm font-semibold text-ink pb-1.5 border-b border-rule">What was sent · {sent.length}</div>
          <ul className="divide-y divide-line">
            {sent.map((i: SnapshotItem) => (
              <li key={i.id}>
                <button type="button" onClick={() => onPreview(i)} className="w-full flex items-center gap-3 py-2 text-left hover:bg-inset -mx-2 px-2 rounded-md">
                  <KindIcon kind={i.kind} mime={i.mime_type} size={15} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{i.name}</span>
                  {i.added_round === round.number && round.number > 1 && <span className="shrink-0 text-xs text-accent">New</span>}
                  <span className="shrink-0 text-xs text-subtle">{i.kind === "link" ? hostOf(i.external_url) : fileSize(i.size)}</span>
                </button>
              </li>
            ))}
          </ul>
          {round.closed_at && (
            <div className="mt-1.5 text-xs text-subtle">
              Round closed {day(round.closed_at)}
              {round.closed_by_name ? ` by ${round.closed_by_name}` : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ItemThread({
  delivery,
  item,
  list,
  url,
  canReply,
  onResolve,
  resolving,
  onPreview,
  onChanged,
}: {
  delivery: Delivery;
  item: Preview | null;
  list: DeliveryComment[];
  url: string | undefined;
  canReply: boolean;
  onResolve: (id: string, v: boolean) => void;
  resolving: boolean;
  onPreview: (p: Preview) => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [replying, setReplying] = useState(false);
  const [body, setBody] = useState("");
  const post = useMutation({
    mutationFn: () => addTeamComment(delivery.id, item?.id ?? null, body),
    onSuccess: () => {
      setBody("");
      setReplying(false);
      onChanged();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't post the reply", description: e.message }),
  });
  const sorted = item?.kind === "video" ? [...list].sort((a, b) => (a.at_seconds ?? Infinity) - (b.at_seconds ?? Infinity) || a.created_at.localeCompare(b.created_at)) : list;

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2.5 pb-1 border-b border-line">
        {item ? (
          <button type="button" onClick={() => onPreview(item)} className="flex min-w-0 items-center gap-2.5 text-left hover:text-accent" title="Preview">
            <Thumb item={item} url={url} className="h-8 w-12 shrink-0" iconSize={14} />
            <span className="truncate text-sm font-semibold text-ink">{item.name}</span>
          </button>
        ) : (
          <span className="text-sm font-semibold text-ink">General</span>
        )}
        <span className="text-xs text-subtle tabular-nums">{list.length}</span>
        {canReply && !replying && (
          <button type="button" onClick={() => setReplying(true)} className="ml-auto shrink-0 text-xs font-medium text-accent hover:underline">
            Reply
          </button>
        )}
      </div>
      <div className="divide-y divide-line">
        {sorted.map((c) => (
          <CommentRow key={c.id} c={c} onResolve={(v) => onResolve(c.id, v)} busy={resolving} />
        ))}
      </div>
      {replying && (
        <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-end">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={2}
            maxLength={4000}
            autoFocus
            placeholder="Reply as the team…"
            aria-label="Reply"
            className="block w-full min-w-0 flex-1 resize-none rounded-md border border-border bg-surface px-3 py-2 text-lg sm:text-base text-ink placeholder:text-subtle outline-none focus:border-accent"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && body.trim()) post.mutate();
              if (e.key === "Escape") setReplying(false);
            }}
          />
          <div className="flex shrink-0 justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setReplying(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" iconLeft={<Send size={14} />} disabled={!body.trim()} loading={post.isPending} onClick={() => post.mutate()}>
              Reply
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** One file of a round on its own: the picture or video, or a way to open it. */
function PreviewModal({ item, url, onClose }: { item: Preview; url: string | undefined; onClose: () => void }) {
  const toast = useToast();
  const download = useMutation({
    mutationFn: () => teamDownloadUrl(item.storage_path!, item.name),
    onSuccess: (href) => (window.location.href = href),
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't get the file", description: e.message }),
  });
  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={<span className="block truncate">{item.name}</span>}
      footer={
        item.kind === "link" ? (
          <Button variant="primary" iconLeft={<ExternalLink size={14} />} onClick={() => window.open(item.external_url ?? undefined, "_blank", "noopener")}>
            Open link
          </Button>
        ) : item.storage_path ? (
          <Button iconLeft={<Download size={14} />} loading={download.isPending} onClick={() => download.mutate()}>
            Download
          </Button>
        ) : undefined
      }
    >
      {item.kind === "image" && url ? (
        <img src={url} alt={item.name} className="mx-auto max-h-[70vh] w-auto max-w-full rounded-md object-contain" />
      ) : item.kind === "video" && url ? (
        <video src={url} controls playsInline preload="metadata" className="mx-auto max-h-[70vh] w-full rounded-md bg-black" />
      ) : (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <span className="grid h-14 w-14 place-items-center rounded-full bg-inset text-muted">
            <KindIcon kind={item.kind} mime={item.mime_type} size={22} />
          </span>
          <div className="text-sm text-muted">{item.kind === "link" ? item.external_url : fileSize(item.size) || "File"}</div>
        </div>
      )}
    </Modal>
  );
}
