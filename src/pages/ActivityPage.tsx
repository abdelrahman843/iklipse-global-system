import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, ChevronDown, History } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSpinner } from "@/components/ui/Spinner";
import { PageTitle } from "@/components/ui/PageTitle";
import { SearchField } from "@/components/ui/SearchField";
import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/format";
import { supabase } from "@/lib/supabase";
import { AREAS, PAGE, fetchAudit, type AuditRow } from "@/lib/auditApi";

// -----------------------------------------------------------------------------
// Activity log (admins): everything people made, changed or deleted, newest
// first, by day. Narrow it by part of iklipse, by person or by words; open a
// line for what changed (before and after) and a link to the thing.
// -----------------------------------------------------------------------------

const AREA_LABEL = Object.fromEntries(AREAS.map((a) => [a.value, a.label])) as Record<string, string>;

// What the columns are called on screen; ids, order and the like aren't shown.
const FIELD: Record<string, string> = {
  title: "Title",
  name: "Name",
  display_name: "Name",
  description: "Description",
  body: "Text",
  text: "Text",
  note: "Note",
  list_id: "List",
  board_id: "Board",
  due_date: "Due date",
  due_at: "Due",
  start_date: "Start date",
  start_on: "Starts",
  due_completed: "Done",
  completed: "Done",
  is_archived: "Archived",
  is_done: "Done list",
  cover_color: "Cover",
  color: "Colour",
  status: "Status",
  priority: "Priority",
  role: "Role",
  wb_role: "Miro role",
  trello_role: "Trello role",
  miro_role: "Miro role",
  delivery_role: "Deliveries",
  brief_role: "Briefs",
  is_active: "Active",
  avatar_url: "Picture",
  username: "Username",
  sessions_revoked_at: "Signed out",
  cost: "Cost",
  currency: "Currency",
  amount: "Amount",
  paid_on: "Paid on",
  issued_on: "Date",
  due_on: "Pay by",
  number: "Number",
  delivered: "Sent to the client",
  done_at: "Delivered",
  removed_at: "Removed",
  revoked_at: "Stopped",
  expires_at: "Expires",
  resolved_at: "Resolved",
  resolved: "Resolved",
  closed_at: "Closed",
  snoozed_until: "Snoozed until",
  close_note: "Note",
  visibility: "Visibility",
  comment_policy: "Comments",
  member_policy: "Adding members",
  background: "Background",
  is_enabled: "On",
  access: "Access",
  can_edit: "Can edit",
  can_reply: "Can reply",
  outcome: "Client's answer",
  submitted_at: "Sent",
  round: "Round",
  state: "State",
  external_url: "Link",
  max_devices: "Devices",
  max_people: "People",
  allow_download: "Download",
  label: "Label",
  calls_enabled: "Calls",
  enabled: "On",
};
const HIDDEN = /(^|_)(id|position|path|mime_type|size|kind|sid|x|y|w|h|z|rotation|data|questions|answers|items|trigger|conditions|actions|options|files|preview)$/;

const isTime = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v);
function show(v: unknown): string {
  if (v === null || v === undefined || v === "") return "empty";
  if (v === true) return "yes";
  if (v === false) return "no";
  if (isTime(v)) return new Date(v as string).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
const fieldName = (k: string) => FIELD[k] ?? k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** The changed fields worth showing, as [name, before, after]. */
function edits(r: AuditRow): [string, string, string][] {
  if (r.action !== "edit" || !r.changes) return [];
  return Object.entries(r.changes as Record<string, [unknown, unknown]>)
    .filter(([k]) => !HIDDEN.test(k) || k === "list_id" || k === "board_id")
    .map(([k, [a, b]]) => (k.endsWith("_id") ? [fieldName(k), "", ""] : [fieldName(k), show(a), show(b)]));
}

/** The words for a line: "changed the card", "added Sara to", … */
function sentence(r: AuditRow): { verb: string; what: string; where: string | null } {
  const c = (r.changes ?? {}) as Record<string, unknown>;
  const kinds: Record<string, string> = r.area === "miro" && r.entity === "board" ? { board: "Miro board" } : { board: r.area === "trello" ? "Trello board" : "board" };
  const thing = kinds[r.entity] ?? r.entity;
  const where = r.ref.card && r.entity !== "card" ? r.ref.card : r.ref.folder ?? r.ref.project ?? r.ref.board ?? null;
  const joined = ["card member", "board member", "team member"].includes(r.entity);
  if (joined) {
    const who = r.ref.person ?? r.label ?? "someone";
    const to = r.entity === "team member" ? r.ref.project : r.entity === "card member" ? r.ref.card : r.ref.board;
    if (r.action === "create") return { verb: "added", what: who, where: to ? `to ${to}` : null };
    if (r.action === "delete") return { verb: "removed", what: who, where: to ? `from ${to}` : null };
    return { verb: "changed", what: `${who}'s role`, where: to ? `on ${to}` : null };
  }
  if (r.entity === "card label") {
    const l = r.ref.label_name ?? "a label";
    return r.action === "create" ? { verb: "labelled", what: r.ref.card ?? "a card", where: l } : { verb: "took the label", what: l, where: r.ref.card ? `off ${r.ref.card}` : null };
  }
  const at = where ? `in ${where}` : null;
  if (r.action === "create") return { verb: r.entity === "comment" || r.entity === "note" ? "wrote a" : "added the", what: thing, where: at };
  if (r.action === "delete") return { verb: "deleted the", what: thing, where: at };
  const keys = Object.keys(c);
  if (keys.includes("is_archived")) return { verb: (c.is_archived as unknown[])[1] ? "archived the" : "restored the", what: thing, where: at };
  if (keys.includes("removed_at")) return { verb: (c.removed_at as unknown[])[1] ? "removed the" : "restored the", what: thing, where: at };
  if (keys.every((k) => k === "position" || k === "list_id")) return { verb: "moved the", what: thing, where: at };
  return { verb: "changed the", what: thing, where: at };
}

/** Where the thing is, if it's still there. */
function href(r: AuditRow): string | null {
  const id = r.row_id ?? "";
  const uuid = /^[0-9a-f-]{36}$/.test(id) ? id : null;
  if (r.action === "delete" && !["card", "comment", "attachment", "checklist", "checklist item", "card label", "card member"].includes(r.entity)) {
    if (r.ref.project_id && r.entity !== "project") return `/projects/${r.ref.project_id}`;
    if (r.ref.folder_id) return `/deliveries/${r.ref.folder_id}`;
    return null;
  }
  switch (r.area) {
    case "trello":
      if (r.entity === "card" && uuid && r.ref.board_id && r.action !== "delete") return `/pm/boards/${r.ref.board_id}/cards/${uuid}`;
      if (r.ref.card_id && r.ref.board_id) return `/pm/boards/${r.ref.board_id}/cards/${r.ref.card_id}`;
      if (r.entity === "board" && uuid) return `/pm/boards/${uuid}`;
      return r.ref.board_id ? `/pm/boards/${r.ref.board_id}` : null;
    case "miro":
      return r.entity === "board" && uuid ? `/wb/${uuid}` : r.ref.board_id ? `/wb/${r.ref.board_id}` : null;
    case "projects":
      return r.entity === "project" && uuid ? `/projects/${uuid}` : r.ref.project_id ? `/projects/${r.ref.project_id}` : null;
    case "deliveries":
      return r.entity === "delivery" && uuid ? `/deliveries/${uuid}` : r.ref.folder_id ? `/deliveries/${r.ref.folder_id}` : null;
    case "alerts":
      return uuid && r.entity === "alert" ? `/alerts?a=${uuid}` : "/alerts?tab=settings";
    case "briefs":
      return uuid ? `/briefs/${uuid}` : "/briefs";
    case "users":
      return "/users";
    case "invoices":
      return "/invoices";
    default:
      return null;
  }
}

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

export default function ActivityPage() {
  const [area, setArea] = useState("");
  const [actor, setActor] = useState("");
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const id = window.setTimeout(() => setQ(typed.trim()), 300);
    return () => window.clearTimeout(id);
  }, [typed]);

  const people = useQuery({
    queryKey: ["activity-people"],
    queryFn: async () => {
      const { data, error } = await supabase.from("profile").select("id, display_name").order("display_name");
      if (error) throw error;
      return (data ?? []) as { id: string; display_name: string }[];
    },
    staleTime: 5 * 60_000,
  });

  const log = useInfiniteQuery({
    queryKey: ["activity-log", area, actor, q],
    queryFn: ({ pageParam }) => fetchAudit({ before: pageParam, area, actor, q }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.length < PAGE ? undefined : last[last.length - 1].at),
    refetchInterval: 30_000,
  });
  const rows = useMemo(() => log.data?.pages.flat() ?? [], [log.data]);
  const days = useMemo(() => {
    const out: { day: string; rows: AuditRow[] }[] = [];
    for (const r of rows) {
      const day = dayLabel(r.at);
      if (out[out.length - 1]?.day !== day) out.push({ day, rows: [] });
      out[out.length - 1].rows.push(r);
    }
    return out;
  }, [rows]);
  const filtered = !!(area || actor || q);

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-3 sm:p-4 md:p-6">
        <div className="mb-4">
          <PageTitle>Activity log</PageTitle>
          <p className="text-sm text-muted mt-1 hidden sm:block">Who made, changed or deleted what in iklipse, and when. Kept for a year.</p>
        </div>

        <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-center">
          <SearchField value={typed} onChange={setTyped} placeholder="Search names and titles" className="flex-1 min-w-0 sm:max-w-sm" aria-label="Search the log" />
          <div className="flex gap-2">
            <Select value={area} onChange={setArea} size="sm" className="flex-1 sm:w-40" aria-label="Part of iklipse" options={[{ value: "", label: "Everything" }, ...AREAS]} />
            <Select
              value={actor}
              onChange={setActor}
              size="sm"
              searchable
              className="flex-1 sm:w-44"
              aria-label="Person"
              options={[{ value: "", label: "Everyone" }, ...(people.data ?? []).map((p) => ({ value: p.id, label: p.display_name }))]}
            />
          </div>
        </div>

        {log.isLoading ? (
          <PageSpinner />
        ) : log.error && !rows.length ? (
          <EmptyState icon={<AlertTriangle size={20} />} title="Couldn't load the log" description={(log.error as Error).message} />
        ) : !rows.length ? (
          <EmptyState
            icon={<History size={20} />}
            title={filtered ? "Nothing matches" : "Nothing yet"}
            description={filtered ? undefined : "From now on, everything people make, change or delete shows up here."}
          />
        ) : (
          <div className="space-y-8 max-w-4xl">
            {days.map((d) => (
              <section key={d.day}>
                <h2 className="pb-2 border-b border-rule text-sm font-semibold text-ink">{d.day}</h2>
                <ul className="divide-y divide-line">
                  {d.rows.map((r, i) => (
                    <Line key={r.id} r={r} i={i} />
                  ))}
                </ul>
              </section>
            ))}
            {log.hasNextPage && (
              <div className="flex justify-center">
                <Button variant="ghost" loading={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
                  Show older
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Line({ r, i }: { r: AuditRow; i: number }) {
  const [open, setOpen] = useState(false);
  const s = sentence(r);
  const list = edits(r);
  const to = href(r);
  const label = r.label && !["card member", "board member", "team member", "card label"].includes(r.entity) ? r.label : null;
  const time = new Date(r.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const named = list.filter(([, a, b]) => a || b);
  const more: ReactNode =
    list.length > 0 ? (
      <span className="text-subtle">{list.map(([k]) => k).filter((k, j, all) => all.indexOf(k) === j).join(", ")}</span>
    ) : null;

  return (
    <li style={{ "--i": Math.min(i, 12) } as React.CSSProperties} className="rise py-3 flex gap-3">
      <Avatar name={r.actor_name ?? "?"} src={r.actor_avatar} size={30} />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink break-words">
          <span className="font-semibold">{r.actor_name ?? "Someone"}</span> {s.verb} {s.what}
          {label && <span className="font-medium"> “{label}”</span>}
          {s.where && <span className="text-muted"> {s.where}</span>}
        </p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
          <span title={new Date(r.at).toLocaleString()}>{time}</span>
          <span aria-hidden>·</span>
          <span>{AREA_LABEL[r.area] ?? r.area}</span>
          {more && (
            <>
              <span aria-hidden>·</span>
              {named.length ? (
                <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="inline-flex items-center gap-1 hover:text-ink">
                  {more}
                  <ChevronDown size={12} className={cn("transition-transform", open && "rotate-180")} />
                </button>
              ) : (
                more
              )}
            </>
          )}
          <span className="sr-only">{relativeTime(r.at)}</span>
        </div>
        {open && named.length > 0 && (
          <dl className="mt-2 rounded-lg bg-inset/60 px-3 py-2 text-xs space-y-1.5 animate-fade-in">
            {named.map(([k, a, b], j) => (
              <div key={j} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2">
                <dt className="text-muted">{k}</dt>
                <dd className="text-ink break-words">
                  <span className="text-subtle line-through decoration-line">{a}</span>
                  <span className="text-subtle"> → </span>
                  {b}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      {to && (
        <Link to={to} className="shrink-0 self-start h-8 w-8 grid place-items-center rounded-md text-subtle hover:text-ink hover:bg-inset" aria-label="Open it" title="Open it">
          <ArrowRight size={15} />
        </Link>
      )}
    </li>
  );
}
