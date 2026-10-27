import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ChevronRight, Download, ExternalLink, Reply, Send } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { CommentRow, KindIcon, Thumb, day, fileSize, hostOf, useTeamUrls } from "./parts";
import { DriveFrame } from "./viewer/DriveFrame";
import {
  addTeamComment,
  fileKey,
  previewable,
  setResolved,
  teamDownloadUrl,
  type Delivery,
  type DeliveryComment,
  type DeliveryRound,
  type DrivePreview,
  type ItemKind,
  type SnapshotItem,
} from "@/lib/deliveriesApi";

// -----------------------------------------------------------------------------
// Every feedback round of a delivery, newest first. A round's line says where
// it stands (a coloured status) and who answered when. Open, it reads like a
// conversation: the client's note, then one thread per file (its picture, the
// comments under a thread line, resolved ticks and the team's replies), with
// the files the client had in that round beside it. Used on the delivery page
// (compact: one column, for narrow places).
// -----------------------------------------------------------------------------

interface Preview {
  id: string;
  kind: ItemKind;
  name: string;
  mime_type: string | null;
  size: number | null;
  storage_path: string | null;
  external_url: string | null;
  drive_file_id?: string | null;
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
  const { urls, drive } = useTeamUrls(useMemo(() => [...byId.values()].filter(previewable).map((i) => fileKey(i)), [byId]));

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
        const unresolved = comments.filter((c) => c.guest && !c.resolved_at).length;
        // A round still open with nothing in it: nothing to show yet.
        if (current && !r.submitted_at && !r.history?.length && !comments.length && delivery.rounds.length > 1) {
          return (
            <div key={r.id} className={cn("flex flex-wrap items-center gap-2 pl-6", compact ? "py-3" : "py-4")}>
              <span className={cn("font-semibold text-ink", compact ? "text-sm" : "text-lg")}>Round {r.number}</span>
              <RoundStatus r={r} />
              <CurrentTag />
            </div>
          );
        }
        const meta = [
          r.submitted_at ? `${r.submitted_name || "The client"} · ${day(r.submitted_at)}` : r.closed_at ? `Closed ${day(r.closed_at)}` : null,
          fromClient ? `${fromClient} ${fromClient === 1 ? "comment" : "comments"}${unresolved && unresolved < fromClient ? `, ${unresolved} open` : ""}` : null,
          r.history?.length ? `Reopened${r.history.length > 1 ? ` ${r.history.length} times` : ""}` : null,
        ].filter(Boolean);
        return (
          <section key={r.id} className="min-w-0">
            <button
              type="button"
              onClick={() => toggle(r.number)}
              aria-expanded={open}
              className={cn("w-full -mx-2 px-2 flex items-start gap-2 text-left rounded-md group hover:bg-hover transition-colors", compact ? "py-3" : "py-4")}
            >
              <ChevronRight size={16} className={cn("mt-1 shrink-0 text-muted transition-transform duration-200", open && "rotate-90")} />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className={cn("font-semibold text-ink group-hover:text-accent transition-colors", compact ? "text-sm" : "text-lg")}>Round {r.number}</span>
                  <RoundStatus r={r} />
                  {current && <CurrentTag />}
                </span>
                {meta.length > 0 && <span className={cn("mt-0.5 block text-muted", compact ? "text-xs" : "text-sm")}>{meta.join(" · ")}</span>}
              </span>
            </button>
            {open && (
              <RoundBody
                delivery={delivery}
                round={r}
                comments={comments}
                byId={byId}
                urls={urls}
                drive={drive}
                current={current}
                compact={!!compact}
                onPreview={setPreview}
                onChanged={onChanged}
              />
            )}
          </section>
        );
      })}
      {preview && (
        <PreviewModal item={preview} url={urls[fileKey(preview) ?? ""] ?? undefined} drive={drive[fileKey(preview) ?? ""]} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}

/** Where a round stands, in a word and a colour. */
function RoundStatus({ r }: { r: DeliveryRound }) {
  const [label, tone] =
    r.outcome === "approved"
      ? ["Approved", "bg-success/10 text-success"]
      : r.outcome === "feedback"
        ? ["Feedback in", "bg-warn/10 text-warn"]
        : r.closed_at
          ? ["Closed", "bg-inset text-muted"]
          : ["Waiting for the client", "bg-inset text-muted"];
  return <span className={cn("rounded-full px-2 py-px text-xs font-medium", tone)}>{label}</span>;
}

const CurrentTag = () => <span className="rounded-full border border-accent/40 px-2 py-px text-xs font-medium text-accent">Current</span>;

function RoundBody({
  delivery,
  round,
  comments,
  byId,
  urls,
  drive,
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
  drive: Record<string, DrivePreview>;
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
  const showSent = !!sent && sent.length > 0 && (!current || !!round.submitted_at);

  return (
    <div
      className={cn(
        "pb-6 pl-6",
        !compact && showSent ? "grid gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_16rem] items-start" : "space-y-6",
        !compact && "sm:pl-7",
      )}
    >
      <div className="min-w-0 space-y-6">
      {/* What the client sent before the team reopened the round: kept, oldest first. */}
      {(round.history ?? []).map((h, n) => (
        <ClientNote
          key={`${h.submitted_at}-${n}`}
          name={h.submitted_name}
          note={h.client_note}
          faded
          when={`${h.outcome === "approved" ? "Approved" : "Sent feedback"} ${day(h.submitted_at)} · reopened${h.reopened_by ? ` by ${h.reopened_by}` : ""} ${day(h.reopened_at)}`}
        />
      ))}

      {round.client_note && <ClientNote name={round.submitted_name} note={round.client_note} when={round.submitted_at ? day(round.submitted_at) : null} />}

      {!groups.length ? (
        <p className="text-sm text-subtle">{current && !round.submitted_at ? "No comments yet in this round." : "No comments in this round."}</p>
      ) : (
        <div className="space-y-6">
          {groups.map(([itemId, list]) => {
            const it = itemId ? byId.get(itemId) ?? null : null;
            const key = it ? fileKey(it) ?? "" : "";
            return (
              <ItemThread
                key={itemId || "general"}
                delivery={delivery}
                item={it}
                list={list}
                url={it ? urls[key] : undefined}
                drive={it ? drive[key] : undefined}
                canReply={current && !compact}
                onResolve={(id, v) => resolve.mutate({ id, v })}
                resolving={resolve.isPending}
                onPreview={onPreview}
                onChanged={onChanged}
              />
            );
          })}
        </div>
      )}

      </div>

      {/* What the client had in this round (kept when they sent feedback or the round closed). */}
      {showSent && (
        <aside className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-eyebrow text-subtle">Files in this round · {sent!.length}</div>
          <ul className="mt-2">
            {sent!.map((i: SnapshotItem) => (
              <li key={i.id}>
                <button type="button" onClick={() => onPreview(i)} className="w-full flex items-center gap-2.5 py-1.5 text-left hover:bg-hover -mx-2 px-2 rounded-md transition-colors">
                  <KindIcon kind={i.kind} mime={i.mime_type} size={15} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{i.name}</span>
                  {i.added_round === round.number && round.number > 1 && <span className="shrink-0 text-xs font-medium text-accent">New</span>}
                  <span className="shrink-0 text-xs text-subtle tabular-nums">{i.kind === "link" ? hostOf(i.external_url) : fileSize(i.size)}</span>
                </button>
              </li>
            ))}
          </ul>
          {round.closed_at && (
            <div className="mt-2 text-xs text-subtle">
              Round closed {day(round.closed_at)}
              {round.closed_by_name ? ` by ${round.closed_by_name}` : ""}
            </div>
          )}
        </aside>
      )}
    </div>
  );
}

/** The client's message with their feedback (faded: an earlier one, before the round was reopened). */
function ClientNote({ name, note, when, faded }: { name: string | null | undefined; note: string | null | undefined; when: string | null; faded?: boolean }) {
  const who = name || "The client";
  return (
    <div className={cn("rounded-lg bg-inset/60 px-4 py-3", faded && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
        <Avatar name={who} size={22} />
        <span className="font-medium text-ink">{who}</span>
        <span className="text-xs text-accent">Client</span>
        {when && <span className="text-xs text-subtle">{when}</span>}
      </div>
      {note ? (
        <p className="mt-1.5 text-base text-ink whitespace-pre-wrap break-words leading-relaxed">{note}</p>
      ) : (
        <p className="mt-1.5 text-sm text-subtle">No message.</p>
      )}
    </div>
  );
}

function ItemThread({
  delivery,
  item,
  list,
  url,
  drive,
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
  drive: DrivePreview | undefined;
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
  const open = list.filter((c) => !c.resolved_at).length;

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-3">
        {item ? (
          <button type="button" onClick={() => onPreview(item)} className="group flex min-w-0 items-center gap-3 text-left" title="Preview">
            <Thumb item={item} url={url} drive={drive} className="h-10 w-16 shrink-0 rounded-md" iconSize={16} />
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-ink group-hover:text-accent transition-colors">{item.name}</span>
              <span className="block text-xs text-muted">
                {list.length} {list.length === 1 ? "comment" : "comments"}
                {open > 0 && open < list.length ? `, ${open} open` : open === 0 ? ", all resolved" : ""}
              </span>
            </span>
          </button>
        ) : (
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-ink">About the whole delivery</span>
            <span className="block text-xs text-muted">
              {list.length} {list.length === 1 ? "comment" : "comments"}
            </span>
          </span>
        )}
        {canReply && !replying && (
          <Button size="sm" variant="ghost" iconLeft={<Reply size={14} />} className="ml-auto shrink-0" onClick={() => setReplying(true)}>
            Reply
          </Button>
        )}
      </div>
      {/* The thread: a line down from the picture, the comments along it. */}
      <div className={cn("mt-1 border-l border-line pl-5", item ? "ml-8" : "ml-2")}>
        {sorted.map((c) => (
          <CommentRow key={c.id} c={c} onResolve={(v) => onResolve(c.id, v)} busy={resolving} />
        ))}
      {replying && (
        <div className="mt-1 pb-2 flex flex-col gap-2 sm:flex-row sm:items-end">
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
    </div>
  );
}

/** One file of a round on its own: the picture or video, or a way to open it. */
function PreviewModal({ item, url, drive, onClose }: { item: Preview; url: string | undefined; drive: DrivePreview | undefined; onClose: () => void }) {
  const toast = useToast();
  const download = useMutation({
    mutationFn: () => teamDownloadUrl(fileKey(item)!, item.name),
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
        ) : fileKey(item) ? (
          <Button iconLeft={<Download size={14} />} loading={download.isPending} onClick={() => download.mutate()}>
            Download
          </Button>
        ) : undefined
      }
    >
      {drive?.embed && item.kind === "file" ? (
        // A document kept in Drive: Google's own preview.
        <DriveFrame key={item.id} src={drive.embed} title={item.name} className="relative h-[70vh] w-full rounded-md" />
      ) : item.kind === "image" && (drive || url) ? (
        <img
          src={drive?.image ?? url}
          alt={item.name}
          referrerPolicy={drive ? "no-referrer" : undefined}
          className="mx-auto max-h-[70vh] w-auto max-w-full rounded-md object-contain"
        />
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
