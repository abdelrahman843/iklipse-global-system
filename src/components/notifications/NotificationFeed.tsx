import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, Check, ChevronDown, CircleDot, X } from "lucide-react";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import { useToast } from "@/components/ui/Toast";
import { dismissNotifications, markRead, markUnread, type NotificationRow } from "@/lib/pm/notificationsApi";
import { KIND_ICON, kindTone, notificationHref, notificationText } from "@/components/notifications/kinds";
import { bundle, bundleSubject, byDay, contextOf, isResolved, needsYou, priorityOf, sourceMeta, type Bundle, type Filter } from "@/components/notifications/smart";

// -----------------------------------------------------------------------------
// The notification list used by the bell and the Notifications page:
//   1. "Needs your attention": late deliveries, mentions, things assigned to
//      you, files to download (unread, most urgent first).
//   2. The rest by day, with everything about the same card / project /
//      meeting bundled into one row that opens to show each update.
// Each row says where it's from (Projects, Trello, Miro…), never guesses.
// -----------------------------------------------------------------------------

const CHIP = {
  accent: "bg-accent-soft text-accent",
  success: "bg-success/10 text-success",
  warn: "bg-warn/10 text-warn",
  danger: "bg-danger/10 text-danger",
  neutral: "bg-inset text-muted",
} as const;
const RANK = { urgent: 0, high: 1, normal: 2, low: 3 } as const;

export function NotificationFeed({
  rows,
  filter,
  onNavigate,
  attentionMax = 3,
  onSeeNeeds,
  empty,
  pin = true,
}: {
  rows: NotificationRow[];
  filter: Filter;
  onNavigate?: () => void;
  /** How many "needs you" rows to pin on top of All. */
  attentionMax?: number;
  onSeeNeeds?: () => void;
  empty?: string;
  /** Pin "needs your attention" on top (off while searching). */
  pin?: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const bump = () => {
    void qc.invalidateQueries({ queryKey: ["notif-unread"] });
    void qc.invalidateQueries({ queryKey: ["notifications"] });
  };
  const act = useMutation({
    mutationFn: ({ ids, what }: { ids: string[]; what: "read" | "unread" | "dismiss" }) =>
      what === "read" ? markRead(ids) : what === "unread" ? markUnread(ids) : dismissNotifications(ids),
    onSuccess: bump,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't update it", description: e.message }),
  });
  const actions: RowActions = {
    open: (ids) => {
      if (ids.length) void markRead(ids).then(bump);
      onNavigate?.();
    },
    read: (ids, v) => act.mutate({ ids, what: v ? "read" : "unread" }),
    dismiss: (ids) => act.mutate({ ids, what: "dismiss" }),
  };

  if (!rows.length) {
    return (
      <div className="px-4 py-12 text-center">
        <div className="mx-auto h-11 w-11 rounded-full bg-inset grid place-items-center text-subtle">
          <BellOff size={20} />
        </div>
        <div className="mt-2 text-base font-medium text-ink">You're all caught up</div>
        <div className="text-sm text-subtle">{empty ?? "Nothing here yet."}</div>
      </div>
    );
  }

  // Pinned on top of All: what needs you, most urgent first.
  const needs = filter === "all" && pin ? rows.filter(needsYou).sort((a, b) => RANK[priorityOf(a)] - RANK[priorityOf(b)]) : [];
  const pinned = needs.slice(0, attentionMax);
  const pinnedIds = new Set(pinned.map((n) => n.id));
  const days = byDay(bundle(rows.filter((n) => !pinnedIds.has(n.id))));
  // One stagger down the whole feed, across the day groups.
  let i = 0;

  return (
    <div>
      {pinned.length > 0 && (
        <section className="pt-3">
          <FeedHeading
            tone="warn"
            count={needs.length}
            action={
              needs.length > pinned.length && onSeeNeeds ? (
                <button type="button" onClick={onSeeNeeds} className="text-xs font-medium text-accent hover:underline">
                  See all
                </button>
              ) : null
            }
          >
            Needs your attention
          </FeedHeading>
          <div className="divide-y divide-line">
            {pinned.map((n) => (
              <BundleRow key={n.id} i={i++} b={{ key: n.id, items: [n], unread: 1, priority: priorityOf(n) }} actions={actions} />
            ))}
          </div>
        </section>
      )}
      {days.map(([day, bundles]) => (
        <section key={day} className="pt-3">
          <FeedHeading>{day}</FeedHeading>
          <div className="divide-y divide-line">
            {bundles.map((b) => (
              <BundleRow key={b.key} i={i++} b={b} actions={actions} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** A day / group heading: clear text with a line under it. */
function FeedHeading({ children, count, tone, action }: { children: React.ReactNode; count?: number; tone?: "warn"; action?: React.ReactNode }) {
  return (
    <div className="mx-4 flex items-center gap-2 pb-1.5 border-b border-rule">
      <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-ink">
        {tone === "warn" && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden />}
        <span className="truncate">{children}</span>
        {count != null && <span className="font-normal text-subtle tabular-nums">{count}</span>}
      </h3>
      {action && <div className="ml-auto shrink-0">{action}</div>}
    </div>
  );
}

type RowActions = {
  open: (unreadIds: string[]) => void;
  read: (ids: string[], v: boolean) => void;
  dismiss: (ids: string[]) => void;
};

function BundleRow({ b, i, actions }: { b: Bundle; i: number; actions: RowActions }) {
  const [open, setOpen] = useState(false);
  const n = b.items[0]!;
  const more = b.items.length - 1;
  const ids = b.items.map((x) => x.id);
  const unreadIds = b.items.filter((x) => !x.read_at).map((x) => x.id);
  const subject = bundleSubject(b);
  const hiddenNew = b.items.slice(1).filter((x) => !x.read_at).length;
  return (
    <div style={{ "--i": Math.min(i, 12) } as React.CSSProperties} className={cn("rise group relative", b.priority === "urgent" && b.unread > 0 && "before:absolute before:left-0 before:top-2 before:bottom-2 before:w-0.5 before:rounded-full before:bg-danger")}>
      <Item n={n} onOpen={() => actions.open(more ? unreadIds : n.read_at ? [] : [n.id])} unread={b.unread > 0} />
      {more > 0 && (
        <div className="pl-[60px] pr-4 -mt-1 pb-2">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-ink"
          >
            <ChevronDown size={13} className={cn("transition-transform", open && "rotate-180")} />
            {more} more {more === 1 ? "update" : "updates"}
            {subject ? ` on ${subject}` : ""}
            {hiddenNew > 0 && <span className="ml-1 text-accent">· {hiddenNew} new</span>}
          </button>
          {open && (
            <ul className="mt-1.5 border-l-2 border-line pl-3 space-y-1">
              {b.items.slice(1).map((x) => (
                <li key={x.id}>
                  <Link
                    to={notificationHref(x, "/notifications")}
                    onClick={() => actions.open(x.read_at ? [] : [x.id])}
                    className="flex items-baseline gap-2 py-0.5 text-sm hover:text-accent"
                  >
                    <span className={cn("min-w-0 flex-1 truncate", x.read_at ? "text-muted" : "text-ink font-medium")}>{notificationText(x).head}</span>
                    <span className="shrink-0 text-xs text-subtle">{relativeTime(x.created_at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {/* Quick actions on hover (always reachable by keyboard). */}
      <div className="absolute right-2 top-2 hidden sm:flex items-center gap-0.5 rounded-md bg-surface/95 shadow-card border border-line p-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <IconAction label={b.unread ? "Mark as read" : "Mark as unread"} onClick={() => actions.read(b.unread ? unreadIds : [n.id], !!b.unread)}>
          {b.unread ? <Check size={14} /> : <CircleDot size={14} />}
        </IconAction>
        <IconAction label={more ? "Remove these" : "Remove"} onClick={() => actions.dismiss(ids)}>
          <X size={14} />
        </IconAction>
      </div>
    </div>
  );
}

function Item({ n, onOpen, unread }: { n: NotificationRow; onOpen: () => void; unread: boolean }) {
  const { head, detail } = notificationText(n);
  const Icon = KIND_ICON[n.kind] ?? Bell;
  const resolved = isResolved(n);
  const src = sourceMeta(n.source);
  const context = contextOf(n);
  return (
    <Link
      to={notificationHref(n, "/notifications")}
      onClick={onOpen}
      className="flex gap-3 px-4 py-2.5 hover:bg-inset/60 transition-colors duration-100"
    >
      <span className={cn("mt-0.5 h-9 w-9 shrink-0 rounded-lg grid place-items-center", resolved ? CHIP.neutral : CHIP[kindTone(n.kind)])}>
        <Icon size={16} />
      </span>
      <div className="flex-1 min-w-0">
        <div className={cn("text-base leading-snug break-words line-clamp-2", unread ? "text-ink font-medium" : "text-muted", resolved && "line-through decoration-line")}>
          {head}
        </div>
        {detail && <div className="mt-1 text-sm text-muted leading-snug line-clamp-2 break-words">{detail}</div>}
        <div className="mt-1 flex items-center gap-1.5 text-xs text-subtle min-w-0">
          <src.icon size={12} className="shrink-0" />
          <span className="shrink-0">{src.label}</span>
          {context && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{context}</span>
            </>
          )}
          <span aria-hidden>·</span>
          <span className="shrink-0">{relativeTime(n.created_at)}</span>
          {resolved && <span className="shrink-0 rounded px-1 bg-success/10 text-success font-medium">Resolved</span>}
        </div>
      </div>
      {unread && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />}
    </Link>
  );
}

function IconAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="h-7 w-7 grid place-items-center rounded text-muted hover:text-ink hover:bg-inset">
      {children}
    </button>
  );
}
