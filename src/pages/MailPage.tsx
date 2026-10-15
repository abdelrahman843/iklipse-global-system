import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { format, isToday, isThisYear } from "date-fns";
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  CornerUpLeft,
  Forward,
  Inbox,
  MailOpen,
  Paperclip,
  PenSquare,
  RefreshCw,
  ReplyAll,
  Share2,
  Star,
  Trash2,
  Users,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Controls";
import { EmptyState } from "@/components/ui/EmptyState";
import { Hint, Input, Label, Textarea } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { SearchField } from "@/components/ui/SearchField";
import { Select } from "@/components/ui/Select";
import { PageSpinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { fetchConnections } from "@/lib/connectionsApi";
import { OWNER_CAPS, capsOf, capsText, fetchSharedWithMe, shareThread, type Caps } from "@/lib/mailShareApi";
import { useWbPeople } from "@/lib/wb/people";
import {
  addressOf,
  displayName,
  downloadAttachment,
  getThread,
  listMail,
  mailSummary,
  modifyThreads,
  sendMail,
  trashThreads,
  type MailFolder,
  type MailMessage,
  type MailPage as MailPageData,
  type MailThread,
  type Outgoing,
} from "@/lib/mailApi";

// -----------------------------------------------------------------------------
// Mail: the Gmail accounts this person connected (Connected accounts), one at
// a time or all together. The Shared page's Mail tab: the same view over the
// accounts (or single emails) others shared with them, limited to what each
// owner allows.
// Conversations newest first; open one to read it,
// reply, forward, archive, star or delete. Emails' own HTML is shown in a
// sandboxed frame (no scripts, links open in a new tab).
// -----------------------------------------------------------------------------

const FOLDERS: { value: MailFolder; label: string }[] = [
  { value: "inbox", label: "Inbox" },
  { value: "starred", label: "Starred" },
  { value: "sent", label: "Sent" },
  { value: "all", label: "All mail" },
];

const when = (ms: number) => {
  const d = new Date(ms);
  return isToday(d) ? format(d, "p") : isThisYear(d) ? format(d, "MMM d") : format(d, "MMM d, yyyy");
};

/** Gmail snippets come HTML-escaped ("&#39;"). */
const plain = (s: string) => new DOMParser().parseFromString(s, "text/html").documentElement.textContent ?? s;

type ListData = InfiniteData<MailPageData, Record<string, string | null> | undefined>;
type Open = { account: string; id: string };

export interface MailBox {
  /** The Gmail account's id. */
  id: string;
  email: string;
  /** In the account picker and on list lines. */
  label: string;
  caps: Caps;
  /** Shared: whose account it is and what I may do, for the reading pane. */
  sharedBy?: string;
  capsText?: string;
}

/** My own Gmail accounts (Connected accounts). */
export default function MailPage() {
  const conns = useQuery({ queryKey: ["connections"], queryFn: fetchConnections });
  const accounts = useMemo(() => conns.data?.gmail ?? [], [conns.data]);
  const summary = useQuery({ queryKey: ["mail-summary"], queryFn: mailSummary, enabled: accounts.length > 0, refetchInterval: 60_000 });
  const unread = useMemo(() => new Map((summary.data ?? []).map((s) => [s.id, s.unread])), [summary.data]);
  const boxes = useMemo<MailBox[]>(
    () => accounts.map((a) => ({ id: a.id, email: a.email, label: unread.get(a.id) ? `${a.email} (${unread.get(a.id)})` : a.email, caps: OWNER_CAPS })),
    [accounts, unread],
  );
  if (conns.isLoading) return <PageSpinner />;
  if (!accounts.length)
    return (
      <div className="p-6">
        <EmptyState
          icon={<Inbox size={28} />}
          title="No Gmail connected yet"
          description="Connect one or more Gmail accounts and their mail shows up here."
          action={
            <Link to="/connections">
              <Button variant="primary">Connect Gmail</Button>
            </Link>
          }
        />
      </div>
    );
  return <MailView boxes={boxes} title="Mail" onRefresh={() => void summary.refetch()} />;
}

/** Gmail accounts, and single emails, other people shared with me (0053), for the Shared page. */
export function SharedMailView() {
  const shared = useQuery({ queryKey: ["mail-shared-with-me"], queryFn: fetchSharedWithMe, refetchOnWindowFocus: true, refetchInterval: 60_000 });
  const boxes = useMemo<MailBox[]>(
    () =>
      (shared.data ?? []).map((s) => ({
        id: s.account_id,
        email: s.email,
        label: `${s.email} · ${s.owner_name}`,
        caps: capsOf(s.access, s.can_reply),
        sharedBy: s.owner_name,
        capsText: capsText(s.access, s.can_reply),
      })),
    [shared.data],
  );
  if (shared.isLoading) return <PageSpinner />;
  if (!boxes.length)
    return (
      <EmptyState
        icon={<Users size={28} />}
        title="No mail shared with you yet"
        description="When someone shares a Gmail account or an email with you, it shows up here."
      />
    );
  return <MailView boxes={boxes} shared onRefresh={() => void shared.refetch()} />;
}

function MailView({ boxes, shared = false, title, onRefresh }: { boxes: MailBox[]; shared?: boolean; title?: string; onRefresh: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [account, setAccount] = useState("all");
  const [folder, setFolder] = useState<MailFolder>("inbox");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<Open | null>(null);
  const [compose, setCompose] = useState<Partial<Outgoing> | null>(null);
  const byId = useMemo(() => new Map(boxes.map((b) => [b.id, b])), [boxes]);

  // An account that was disconnected (or stopped being shared) meanwhile.
  useEffect(() => {
    if (account !== "all" && !byId.has(account)) setAccount("all");
  }, [account, byId]);

  const picked = account === "all" ? boxes : boxes.filter((b) => b.id === account);
  // Folders only mean something for mailboxes read whole.
  const showFolders = picked.some((b) => b.caps.readAll);
  const senders = boxes.filter((b) => b.caps.send === "any");
  // A folder picked earlier mustn't stay applied once the picker is gone.
  useEffect(() => {
    if (!showFolders && folder !== "inbox") setFolder("inbox");
  }, [showFolders, folder]);

  const listKey = ["mail", shared ? "shared" : "own", account, folder, search] as const;
  const list = useInfiniteQuery({
    queryKey: listKey,
    queryFn: ({ pageParam }) =>
      listMail({ accounts: account === "all" ? undefined : [account], folder, q: search || undefined, pages: pageParam, ...(shared ? { shared: true } : {}) }),
    initialPageParam: undefined as Record<string, string | null> | undefined,
    getNextPageParam: (last) => (Object.values(last.next).some(Boolean) ? last.next : undefined),
    enabled: boxes.length > 0,
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });

  const threads = useMemo(() => {
    const seen = new Set<string>();
    const out: MailThread[] = [];
    for (const p of list.data?.pages ?? []) {
      for (const t of p.threads) {
        const k = `${t.account}:${t.id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(t);
      }
    }
    return out.sort((a, b) => b.date - a.date);
  }, [list.data]);
  const errors = list.data?.pages.at(-1)?.errors ?? {};

  /** Change one conversation in every cached list. */
  const patchThread = (acc: string, id: string, fn: (t: MailThread) => MailThread | null) =>
    qc.setQueriesData<ListData>({ queryKey: ["mail"] }, (d) =>
      d
        ? {
            ...d,
            pages: d.pages.map((p) => ({
              ...p,
              threads: p.threads.flatMap((t) => (t.account === acc && t.id === id ? (fn(t) ?? []) : [t])),
            })),
          }
        : d,
    );

  const label = useMutation({
    mutationFn: (v: { account: string; id: string; add: string[]; remove: string[] }) => modifyThreads(v.account, [v.id], v.add, v.remove),
    onError: (e: Error) => {
      toast.push({ kind: "error", title: "Couldn't update the conversation", description: e.message });
      void qc.invalidateQueries({ queryKey: ["mail"] });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["mail-summary"] }),
  });

  const openThread = (t: MailThread) => {
    setOpen({ account: t.account, id: t.id });
    // Only someone who may change the mailbox marks it read; others just look.
    if (t.unread && byId.get(t.account)?.caps.manage) {
      patchThread(t.account, t.id, (x) => ({ ...x, unread: false }));
      label.mutate({ account: t.account, id: t.id, add: [], remove: ["UNREAD"] });
    }
  };

  const accountOptions = [
    { value: "all", label: `${shared ? "All shared with me" : "All accounts"}${boxes.length > 1 ? ` (${boxes.length})` : ""}` },
    ...boxes.map((b) => ({ value: b.id, label: b.label })),
  ];
  const openT = open ? threads.find((t) => t.account === open.account && t.id === open.id) : undefined;
  const openBox = open ? byId.get(open.account) : undefined;

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Top bar */}
      <div className={cn("shrink-0 border-b border-border bg-surface px-3 sm:px-4 py-2.5 flex flex-col gap-2", open && "max-lg:hidden")}>
        <div className="flex items-center gap-2">
          {title ? <h1 className="text-lg sm:text-xl font-semibold text-ink tracking-tight mr-auto">{title}</h1> : <span className="mr-auto" />}
          <Button
            variant="ghost"
            size="sm"
            aria-label="Refresh"
            title="Refresh"
            onClick={() => {
              void list.refetch();
              onRefresh();
            }}
            className="max-sm:h-10 max-sm:w-10"
          >
            <RefreshCw size={14} className={cn(list.isFetching && "animate-spin")} />
          </Button>
          {senders.length > 0 && (
            <Button
              variant="primary"
              size="sm"
              iconLeft={<PenSquare size={14} />}
              className="max-sm:h-10"
              onClick={() => setCompose({ account: senders.some((b) => b.id === account) ? account : senders[0]!.id })}
            >
              Compose
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={account} onChange={setAccount} options={accountOptions} aria-label="Account" className="w-full sm:w-72" />
          {showFolders && (
            <div className="overflow-x-auto max-w-full">
              <Segmented value={folder} options={FOLDERS} onChange={(v) => setFolder(v)} />
            </div>
          )}
          <form
            className="flex-1 min-w-[12rem]"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(q.trim());
            }}
          >
            <SearchField value={q} onChange={(v) => (setQ(v), v === "" && setSearch(""))} placeholder="Search mail" aria-label="Search mail" />
          </form>
        </div>
      </div>

      <div className="flex-1 min-h-0 grid lg:grid-cols-[minmax(320px,420px)_minmax(0,1fr)]">
        {/* Conversation list */}
        <div className={cn("min-h-0 overflow-y-auto border-r border-border bg-surface", open && "max-lg:hidden")}>
          {Object.entries(errors).map(([id, msg]) => (
            <div key={id} className="px-3 py-2 text-xs text-ink bg-warn/10 border-b border-warn/25 flex items-start gap-2">
              <AlertTriangle size={13} className="text-warn shrink-0 mt-0.5" />
              <span className="min-w-0 flex-1">
                {byId.get(id)?.email}: {msg}
              </span>
              {!shared && (
                <Link to="/connections" className="text-accent font-medium shrink-0 hover:underline">
                  Fix
                </Link>
              )}
            </div>
          ))}
          {list.isLoading ? (
            <div className="py-14">
              <PageSpinner />
            </div>
          ) : list.error && !threads.length ? (
            <EmptyState title="Couldn't load mail" description={(list.error as Error).message} />
          ) : !threads.length ? (
            <EmptyState
              title={search ? "Nothing matches" : "No conversations here"}
              description={
                shared && !search && picked.every((b) => !b.caps.readAll)
                  ? "Only the emails shared with you show here."
                  : undefined
              }
            />
          ) : (
            <ul className="divide-y divide-line">
              {threads.map((t) => {
                const active = open?.account === t.account && open.id === t.id;
                return (
                  <li key={`${t.account}:${t.id}`}>
                    <button
                      type="button"
                      onClick={() => openThread(t)}
                      aria-current={active || undefined}
                      className={cn(
                        "w-full text-left px-3 sm:px-4 py-3 flex gap-2.5 transition-colors",
                        active ? "bg-accent-soft" : "hover:bg-inset/60",
                      )}
                    >
                      <span className={cn("mt-1.5 h-2 w-2 rounded-full shrink-0", t.unread ? "bg-accent" : "bg-transparent")} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className={cn("truncate text-base", t.unread ? "font-semibold text-ink" : "text-muted")}>
                            {t.people.map(displayName).join(", ") || "(unknown)"}
                          </span>
                          {t.count > 1 && <span className="text-xs text-subtle shrink-0">{t.count}</span>}
                          <span className="ml-auto text-xs text-subtle shrink-0 whitespace-nowrap">{when(t.date)}</span>
                        </span>
                        <span className={cn("block truncate text-sm", t.unread ? "text-ink font-medium" : "text-muted")}>
                          {t.starred && <Star size={11} className="inline -mt-0.5 mr-1 text-warn fill-current" aria-label="Starred" />}
                          {t.subject || "(no subject)"}
                        </span>
                        <span className="block truncate text-xs text-subtle">{plain(t.snippet)}</span>
                        {account === "all" && boxes.length > 1 && (
                          <span className="mt-1 inline-block max-w-full truncate rounded border border-line bg-inset px-1.5 text-[10px] text-subtle">
                            {byId.get(t.account)?.label ?? t.accountEmail}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {list.hasNextPage && (
            <div className="p-3 flex justify-center">
              <Button variant="secondary" size="sm" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                Load more
              </Button>
            </div>
          )}
        </div>

        {/* Reading pane */}
        <div className={cn("min-h-0 overflow-y-auto bg-bg", !open && "max-lg:hidden")}>
          {open && openBox ? (
            <ThreadView
              key={`${open.account}:${open.id}`}
              open={open}
              box={openBox}
              shared={shared}
              summary={openT}
              onClose={() => setOpen(null)}
              onReply={setCompose}
              onLabel={(add, remove) => {
                patchThread(open.account, open.id, (t) => {
                  const next = {
                    ...t,
                    unread: add.includes("UNREAD") ? true : remove.includes("UNREAD") ? false : t.unread,
                    starred: add.includes("STARRED") ? true : remove.includes("STARRED") ? false : t.starred,
                    inInbox: add.includes("INBOX") ? true : remove.includes("INBOX") ? false : t.inInbox,
                  };
                  // Archived out of the inbox view.
                  return folder === "inbox" && !next.inInbox ? null : next;
                });
                label.mutate({ account: open.account, id: open.id, add, remove });
                if (remove.includes("INBOX") || add.includes("UNREAD")) setOpen(null);
              }}
              onTrashed={() => {
                patchThread(open.account, open.id, () => null);
                setOpen(null);
              }}
            />
          ) : (
            <div className="h-full grid place-items-center p-6">
              <EmptyState icon={<MailOpen size={26} />} title="Pick a conversation" description="It opens here." />
            </div>
          )}
        </div>
      </div>

      {compose && (
        <Composer
          init={compose}
          // New mail from the accounts I may send from; a reply-only account just for its reply.
          accounts={compose.account && !senders.some((b) => b.id === compose.account) ? boxes.filter((b) => b.id === compose.account) : senders}
          onClose={() => setCompose(null)}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ thread --

function ThreadView({
  open,
  box,
  shared,
  summary,
  onClose,
  onReply,
  onLabel,
  onTrashed,
}: {
  open: Open;
  box: MailBox;
  shared: boolean;
  summary?: MailThread;
  onClose: () => void;
  onReply: (o: Partial<Outgoing>) => void;
  onLabel: (add: string[], remove: string[]) => void;
  onTrashed: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [sharing, setSharing] = useState(false);
  const { caps } = box;
  const q = useQuery({ queryKey: ["mail-thread", open.account, open.id], queryFn: () => getThread(open.account, open.id) });
  const t = q.data;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!t) return;
    // The newest and the unread ones open; older ones fold to a line.
    setExpanded(new Set(t.messages.filter((m, i) => i === t.messages.length - 1 || m.unread).map((m) => m.id)));
  }, [t]);

  const trash = useMutation({
    mutationFn: () => trashThreads(open.account, [open.id]),
    onSuccess: () => {
      toast.push({ kind: "success", title: "Moved to trash" });
      onTrashed();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't delete", description: e.message }),
  });

  const last = t?.messages.at(-1);
  const subject = t?.messages[0]?.subject || summary?.subject || "(no subject)";
  const starred = t ? t.messages.some((m) => m.labels.includes("STARRED")) : !!summary?.starred;
  const inInbox = t ? t.messages.some((m) => m.labels.includes("INBOX")) : !!summary?.inInbox;

  const reply = (all: boolean) => {
    if (!t || !last) return;
    const mine = addressOf(t.accountEmail).toLowerCase();
    const fromMe = addressOf(last.from).toLowerCase() === mine;
    const to = fromMe ? last.to : last.from;
    const others = all
      ? [...last.to.split(","), ...last.cc.split(",")]
          .map((s) => s.trim())
          .filter((s) => s && addressOf(s).toLowerCase() !== mine && addressOf(s).toLowerCase() !== addressOf(to).toLowerCase())
      : [];
    onReply({
      account: t.account,
      to,
      cc: others.join(", "),
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      text: `\n\n${quote(last)}`,
      threadId: t.id,
      inReplyTo: last.messageId,
      references: last.references,
    });
  };

  const forward = () => {
    if (!t || !last) return;
    onReply({
      account: t.account,
      to: "",
      subject: /^fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`,
      text: `\n\n---------- Forwarded message ----------\nFrom: ${last.from}\nDate: ${format(new Date(last.date), "PPpp")}\nSubject: ${last.subject}\nTo: ${last.to}\n\n${bodyText(last)}`,
    });
  };

  return (
    <div className="p-3 sm:p-5">
      <div className="flex items-start gap-2 mb-4 pb-3 border-b border-rule">
        <Button variant="ghost" size="sm" aria-label="Back to the list" className="lg:hidden max-sm:h-10 max-sm:w-10 shrink-0" onClick={onClose}>
          <ArrowLeft size={16} />
        </Button>
        <h2 className="flex-1 min-w-0 text-lg sm:text-xl font-semibold text-ink break-words">{subject}</h2>
      </div>
      {shared && box.sharedBy && (
        <div className="mb-4 rounded-md border border-line bg-inset px-3 py-2 text-xs text-muted flex flex-wrap items-center gap-x-2 gap-y-1">
          <Users size={13} className="text-subtle shrink-0" />
          <span>
            <span className="text-ink font-medium">{box.email}</span>, shared by {box.sharedBy}
          </span>
          {box.capsText && <Badge tone="neutral">{box.capsText}</Badge>}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {!shared && (
          <Button variant="secondary" size="sm" iconLeft={<Share2 size={14} />} onClick={() => setSharing(true)} className="max-sm:h-10">
            Share
          </Button>
        )}
        {caps.manage && inInbox && (
          <Button variant="secondary" size="sm" iconLeft={<Archive size={14} />} onClick={() => onLabel([], ["INBOX"])} className="max-sm:h-10">
            Archive
          </Button>
        )}
        {caps.manage && (
          <>
            <Button variant="secondary" size="sm" iconLeft={<MailOpen size={14} />} onClick={() => onLabel(["UNREAD"], [])} className="max-sm:h-10">
              Mark unread
            </Button>
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<Star size={14} className={cn(starred && "text-warn fill-current")} />}
              onClick={() => onLabel(starred ? [] : ["STARRED"], starred ? ["STARRED"] : [])}
              className="max-sm:h-10"
            >
              {starred ? "Starred" : "Star"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              iconLeft={<Trash2 size={14} />}
              loading={trash.isPending}
              className="max-sm:h-10"
              onClick={async () => {
                const ok = await confirm({ title: "Delete this conversation?", message: "It goes to the account's Trash in Gmail.", confirmLabel: "Delete", danger: true });
                if (ok) trash.mutate();
              }}
            >
              Delete
            </Button>
          </>
        )}
      </div>
      {sharing && t && <ShareEmailModal account={t.account} thread={t.id} subject={subject} onClose={() => setSharing(false)} />}

      {q.isLoading ? (
        <PageSpinner />
      ) : !t ? (
        <EmptyState title="Couldn't open this conversation" description={(q.error as Error | null)?.message} />
      ) : (
        <div className="divide-y divide-line border-y border-line">
          {t.messages.map((m) => {
            const isOpen = expanded.has(m.id);
            return (
              <article key={m.id}>
                <button
                  type="button"
                  className="w-full text-left px-3 sm:px-4 py-3 flex items-start gap-3 hover:bg-inset/60 transition-colors"
                  onClick={() =>
                    setExpanded((s) => {
                      const n = new Set(s);
                      if (n.has(m.id)) n.delete(m.id);
                      else n.add(m.id);
                      return n;
                    })
                  }
                  aria-expanded={isOpen}
                >
                  <Avatar name={displayName(m.from)} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="font-semibold text-base text-ink truncate">{displayName(m.from)}</span>
                      <span className="ml-auto text-xs text-subtle shrink-0 whitespace-nowrap">{when(m.date)}</span>
                    </span>
                    {isOpen ? (
                      <span className="block text-xs text-subtle break-words">
                        {addressOf(m.from)} to {m.to}
                        {m.cc ? `, cc ${m.cc}` : ""}
                      </span>
                    ) : (
                      <span className="block text-xs text-subtle truncate">{plain(m.snippet)}</span>
                    )}
                  </span>
                </button>
                {isOpen && (
                  <div className="px-3 sm:px-4 pb-4">
                    {m.html ? (
                      <MailHtml html={m.html} />
                    ) : (
                      <div className="text-sm text-ink whitespace-pre-wrap break-words leading-relaxed" dir="auto">
                        {m.text ?? plain(m.snippet)}
                      </div>
                    )}
                    {m.attachments.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {m.attachments.map((a) => (
                          <button
                            key={a.id}
                            type="button"
                            onClick={() =>
                              downloadAttachment(t.account, m.id, a).catch((e: Error) =>
                                toast.push({ kind: "error", title: "Couldn't download", description: e.message }),
                              )
                            }
                            className="inline-flex items-center gap-1.5 max-w-full rounded-md border border-border bg-inset px-2.5 h-8 text-xs text-ink hover:border-accent transition-colors"
                          >
                            <Paperclip size={12} className="shrink-0" />
                            <span className="truncate">{a.name}</span>
                            <span className="text-subtle shrink-0">{Math.max(1, Math.round(a.size / 1024))} KB</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </article>
            );
          })}
          {caps.send !== "none" && (
            <div className="flex flex-wrap gap-2 pt-3">
              <Button variant="secondary" iconLeft={<CornerUpLeft size={14} />} onClick={() => reply(false)} className="max-sm:h-10">
                Reply
              </Button>
              <Button variant="secondary" iconLeft={<ReplyAll size={14} />} onClick={() => reply(true)} className="max-sm:h-10">
                Reply all
              </Button>
              {caps.send === "any" && (
                <Button variant="secondary" iconLeft={<Forward size={14} />} onClick={forward} className="max-sm:h-10">
                  Forward
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Share one conversation of my account with someone (the Shared page on their side). */
function ShareEmailModal({ account, thread, subject, onClose }: { account: string; thread: string; subject: string; onClose: () => void }) {
  const { user } = useAuth();
  const people = useWbPeople();
  const qc = useQueryClient();
  const toast = useToast();
  const [who, setWho] = useState("");
  const list = (people.data?.list ?? []).filter((p) => p.is_active && p.id !== user?.id);
  const name = list.find((p) => p.id === who)?.display_name ?? "They";
  const share = useMutation({
    mutationFn: () => shareThread({ account, grantee: who, thread, subject }),
    onSuccess: (r) => {
      toast.push(
        r === "added"
          ? { kind: "success", title: `Shared with ${name}`, description: "It's on their Shared page." }
          : { kind: "success", title: `${name} can already read it` },
      );
      void qc.invalidateQueries({ queryKey: ["mail-shares"] });
      onClose();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't share", description: e.message }),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Share this email"
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" iconLeft={<Share2 size={14} />} disabled={!who} loading={share.isPending} onClick={() => share.mutate()}>
            Share
          </Button>
        </div>
      }
    >
      <p className="text-sm text-muted mb-4">
        They see this conversation, and new replies in it, on their Shared page. Nothing else from this account.
      </p>
      <Label>With</Label>
      <Select
        value={who}
        onChange={setWho}
        placeholder={people.isLoading ? "Loading…" : "Pick someone"}
        options={list.map((p) => ({ value: p.id, label: p.display_name, icon: <Avatar src={p.avatar_url} name={p.display_name} size={18} /> }))}
        searchable
        className="w-full"
      />
      <Hint>To let them reply, or to share more, use Connected accounts, Sharing.</Hint>
    </Modal>
  );
}

/** The text of a message, for quoting (HTML reduced to its text). */
function bodyText(m: MailMessage): string {
  if (m.text) return m.text.trim();
  if (m.html) return (new DOMParser().parseFromString(m.html, "text/html").body.innerText || "").trim();
  return plain(m.snippet);
}

function quote(m: MailMessage): string {
  const lines = bodyText(m).split("\n").map((l) => `> ${l}`);
  return `On ${format(new Date(m.date), "PPpp")}, ${m.from} wrote:\n${lines.join("\n")}`;
}

/**
 * An email's HTML in a sandboxed frame: no scripts or forms, links open in a
 * new tab. Same-origin (without scripts) only so the frame can fit its height.
 * Light colours, as emails are written for a white page.
 */
function MailHtml({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [h, setH] = useState(160);
  const doc = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><meta name="referrer" content="no-referrer"><style>` +
      `html,body{margin:0;padding:0;background:rgb(255 255 255);color:rgb(11 18 32);font:14px/1.5 Inter,system-ui,sans-serif;overflow-wrap:anywhere}` +
      `body{padding:12px}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}` +
      `</style></head><body>${html}</body></html>`,
    [html],
  );
  useEffect(() => {
    const f = ref.current;
    if (!f) return;
    let ro: ResizeObserver | null = null;
    const fit = () => {
      const d = f.contentDocument;
      if (d?.documentElement) setH(Math.min(20000, Math.max(60, d.documentElement.scrollHeight)));
    };
    const onLoad = () => {
      fit();
      const body = f.contentDocument?.body;
      if (body && "ResizeObserver" in window) {
        ro = new ResizeObserver(fit);
        ro.observe(body);
      }
    };
    f.addEventListener("load", onLoad);
    return () => {
      f.removeEventListener("load", onLoad);
      ro?.disconnect();
    };
  }, [doc]);
  return (
    <iframe
      ref={ref}
      title="Email"
      srcDoc={doc}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      className="w-full rounded-md border border-line"
      style={{ height: h }}
    />
  );
}

// ---------------------------------------------------------------- composer --

function Composer({
  init,
  accounts,
  onClose,
}: {
  init: Partial<Outgoing>;
  accounts: { id: string; email: string }[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [from, setFrom] = useState(init.account ?? accounts[0]?.id ?? "");
  const [to, setTo] = useState(init.to ?? "");
  const [cc, setCc] = useState(init.cc ?? "");
  const [showCc, setShowCc] = useState(!!init.cc);
  const [subject, setSubject] = useState(init.subject ?? "");
  const [text, setText] = useState(init.text ?? "");
  const textRef = useRef<HTMLTextAreaElement>(null);
  const replying = !!init.threadId;
  // A reply or forward starts typing above the quoted text.
  useEffect(() => {
    if ((init.to || init.subject) && textRef.current) {
      textRef.current.focus();
      textRef.current.setSelectionRange(0, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useMutation({
    mutationFn: () =>
      sendMail({
        account: from,
        to: to.trim(),
        cc: cc.trim() || undefined,
        subject: subject.trim(),
        text,
        // A reply stays in its conversation only from the same account.
        ...(replying && from === init.account ? { threadId: init.threadId, inReplyTo: init.inReplyTo, references: init.references } : {}),
      }),
    onSuccess: () => {
      toast.push({ kind: "success", title: "Sent" });
      void qc.invalidateQueries({ queryKey: ["mail"] });
      void qc.invalidateQueries({ queryKey: ["mail-thread"] });
      onClose();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't send", description: e.message }),
  });

  const close = async () => {
    const typed = text.trim() !== (init.text ?? "").trim() || (to.trim() && to !== init.to);
    if (typed && !(await confirm({ title: "Discard this message?", confirmLabel: "Discard", danger: true }))) return;
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!to.trim()) {
      toast.push({ kind: "error", title: "Add who it's to" });
      return;
    }
    if (send.isPending) return;
    // Enter in a field submits too: an email can't be taken back once it's sent.
    const ok = await confirm({ title: "Send this email?", message: `It goes to ${to.trim()}.`, confirmLabel: "Send" });
    if (ok) send.mutate();
  };

  return (
    <Modal
      open
      onClose={close}
      title={replying ? "Reply" : init.subject?.startsWith("Fwd") ? "Forward" : "New message"}
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="mail-compose" loading={send.isPending}>
            Send
          </Button>
        </div>
      }
    >
      <form id="mail-compose" onSubmit={submit} className="space-y-3">
        {accounts.length > 1 && (
          <div>
            <Label>From</Label>
            <Select value={from} onChange={setFrom} options={accounts.map((a) => ({ value: a.id, label: a.email }))} aria-label="From" className="w-full" />
          </div>
        )}
        <div>
          <div className="flex items-center justify-between">
            <Label htmlFor="mail-to">To</Label>
            {!showCc && (
              <button type="button" className="text-xs text-accent hover:underline" onClick={() => setShowCc(true)}>
                Add Cc
              </button>
            )}
          </div>
          <Input id="mail-to" type="text" inputMode="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com, ..." autoFocus={!init.to} />
        </div>
        {showCc && (
          <div>
            <Label htmlFor="mail-cc">Cc</Label>
            <Input id="mail-cc" type="text" inputMode="email" value={cc} onChange={(e) => setCc(e.target.value)} />
          </div>
        )}
        <div>
          <Label htmlFor="mail-subject">Subject</Label>
          <Input id="mail-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="mail-text">Message</Label>
          <Textarea id="mail-text" ref={textRef} value={text} onChange={(e) => setText(e.target.value)} rows={12} dir="auto" className="min-h-[12rem]" />
        </div>
      </form>
    </Modal>
  );
}

