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
  Star,
  Trash2,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Controls";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input, Label, Textarea } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { SearchField } from "@/components/ui/SearchField";
import { Select } from "@/components/ui/Select";
import { PageSpinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/cn";
import { fetchConnections } from "@/lib/connectionsApi";
import { NOT_ON_DEVICE, useIsOnline } from "@/lib/offline/net";
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
// a time or all together. Conversations newest first; open one to read it,
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

export default function MailPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const online = useIsOnline();
  const conns = useQuery({ queryKey: ["connections"], queryFn: fetchConnections });
  const accounts = useMemo(() => conns.data?.gmail ?? [], [conns.data]);
  const [account, setAccount] = useState("all");
  const [folder, setFolder] = useState<MailFolder>("inbox");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<Open | null>(null);
  const [compose, setCompose] = useState<Partial<Outgoing> | null>(null);

  // An account that was disconnected meanwhile.
  useEffect(() => {
    if (account !== "all" && conns.data && !accounts.some((a) => a.id === account)) setAccount("all");
  }, [account, accounts, conns.data]);

  const summary = useQuery({ queryKey: ["mail-summary"], queryFn: mailSummary, enabled: accounts.length > 0, refetchInterval: 60_000 });
  const unread = new Map((summary.data ?? []).map((s) => [s.id, s.unread]));

  const listKey = ["mail", account, folder, search] as const;
  const list = useInfiniteQuery({
    queryKey: listKey,
    queryFn: ({ pageParam }) =>
      listMail({ accounts: account === "all" ? undefined : [account], folder, q: search || undefined, pages: pageParam }),
    initialPageParam: undefined as Record<string, string | null> | undefined,
    getNextPageParam: (last) => (Object.values(last.next).some(Boolean) ? last.next : undefined),
    enabled: accounts.length > 0,
    refetchOnWindowFocus: true,
    refetchInterval: 90_000,
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
    if (t.unread) {
      patchThread(t.account, t.id, (x) => ({ ...x, unread: false }));
      label.mutate({ account: t.account, id: t.id, add: [], remove: ["UNREAD"] });
    }
  };

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

  const accountOptions = [
    { value: "all", label: `All accounts${accounts.length > 1 ? ` (${accounts.length})` : ""}` },
    ...accounts.map((a) => ({ value: a.id, label: unread.get(a.id) ? `${a.email} (${unread.get(a.id)})` : a.email })),
  ];
  const openT = open ? threads.find((t) => t.account === open.account && t.id === open.id) : undefined;

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Top bar */}
      <div className={cn("shrink-0 border-b border-border bg-surface px-3 sm:px-4 py-2.5 flex flex-col gap-2", open && "max-lg:hidden")}>
        <div className="flex items-center gap-2">
          <h1 className="text-lg sm:text-xl font-semibold text-ink tracking-tight mr-auto">Mail</h1>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Refresh"
            title="Refresh"
            onClick={() => {
              void list.refetch();
              void summary.refetch();
            }}
            className="max-sm:h-10 max-sm:w-10"
          >
            <RefreshCw size={14} className={cn(list.isFetching && "animate-spin")} />
          </Button>
          <Button
            variant="primary"
            size="sm"
            iconLeft={<PenSquare size={14} />}
            className="max-sm:h-10"
            onClick={() => setCompose({ account: account !== "all" ? account : accounts[0]!.id })}
          >
            Compose
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={account} onChange={setAccount} options={accountOptions} aria-label="Account" className="w-full sm:w-64" />
          <div className="overflow-x-auto max-w-full">
            <Segmented value={folder} options={FOLDERS} onChange={(v) => setFolder(v)} />
          </div>
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
                {accounts.find((a) => a.id === id)?.email}: {msg}
              </span>
              <Link to="/connections" className="text-accent font-medium shrink-0 hover:underline">
                Fix
              </Link>
            </div>
          ))}
          {list.isLoading ? (
            <div className="py-14">
              <PageSpinner />
            </div>
          ) : !list.data && !online ? (
            <EmptyState {...NOT_ON_DEVICE} />
          ) : list.error && !threads.length ? (
            <EmptyState title="Couldn't load mail" description={(list.error as Error).message} />
          ) : !threads.length ? (
            <EmptyState title={search ? "Nothing matches" : "No conversations here"} />
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
                        "w-full text-left px-3 sm:px-4 py-2.5 flex gap-2.5 transition-colors",
                        active ? "bg-accent-soft" : "hover:bg-inset",
                      )}
                    >
                      <span className={cn("mt-1.5 h-2 w-2 rounded-full shrink-0", t.unread ? "bg-accent" : "bg-transparent")} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className={cn("truncate text-sm", t.unread ? "font-semibold text-ink" : "text-muted")}>
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
                        {account === "all" && accounts.length > 1 && (
                          <span className="mt-1 inline-block max-w-full truncate rounded border border-line bg-inset px-1.5 text-[10px] text-subtle">
                            {t.accountEmail}
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
          {open ? (
            <ThreadView
              key={`${open.account}:${open.id}`}
              open={open}
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

      {compose && <Composer init={compose} accounts={accounts} onClose={() => setCompose(null)} />}
    </div>
  );
}

// ------------------------------------------------------------------ thread --

function ThreadView({
  open,
  summary,
  onClose,
  onReply,
  onLabel,
  onTrashed,
}: {
  open: Open;
  summary?: MailThread;
  onClose: () => void;
  onReply: (o: Partial<Outgoing>) => void;
  onLabel: (add: string[], remove: string[]) => void;
  onTrashed: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const online = useIsOnline();
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
    <div className="max-w-3xl mx-auto p-3 sm:p-5">
      <div className="flex items-start gap-2 mb-4">
        <Button variant="ghost" size="sm" aria-label="Back to the list" className="lg:hidden max-sm:h-10 max-sm:w-10 shrink-0" onClick={onClose}>
          <ArrowLeft size={16} />
        </Button>
        <h2 className="flex-1 min-w-0 text-lg sm:text-xl font-semibold text-ink break-words">{subject}</h2>
      </div>
      <div className="flex flex-wrap gap-1.5 mb-4">
        {inInbox && (
          <Button variant="secondary" size="sm" iconLeft={<Archive size={14} />} onClick={() => onLabel([], ["INBOX"])} className="max-sm:h-10">
            Archive
          </Button>
        )}
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
      </div>

      {q.isLoading ? (
        <PageSpinner />
      ) : !t ? (
        !online ? (
          <EmptyState {...NOT_ON_DEVICE} />
        ) : (
          <EmptyState title="Couldn't open this conversation" description={(q.error as Error | null)?.message} />
        )
      ) : (
        <div className="space-y-3">
          {t.messages.map((m) => {
            const isOpen = expanded.has(m.id);
            return (
              <article key={m.id} className="rounded-lg border border-border bg-surface shadow-card overflow-hidden">
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
                      <span className="font-semibold text-sm text-ink truncate">{displayName(m.from)}</span>
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
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="secondary" iconLeft={<CornerUpLeft size={14} />} onClick={() => reply(false)} className="max-sm:h-10">
              Reply
            </Button>
            <Button variant="secondary" iconLeft={<ReplyAll size={14} />} onClick={() => reply(true)} className="max-sm:h-10">
              Reply all
            </Button>
            <Button variant="secondary" iconLeft={<Forward size={14} />} onClick={forward} className="max-sm:h-10">
              Forward
            </Button>
          </div>
        </div>
      )}
    </div>
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

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!to.trim()) {
      toast.push({ kind: "error", title: "Add who it's to" });
      return;
    }
    send.mutate();
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

