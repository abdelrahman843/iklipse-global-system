import { useCallback, useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { AlertTriangle, ArrowRight, History, SlidersHorizontal, X } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Controls";
import { DateField } from "@/components/ui/DateField";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { PageSpinner } from "@/components/ui/Spinner";
import { PageTitle } from "@/components/ui/PageTitle";
import { SearchField } from "@/components/ui/SearchField";
import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/format";
import { supabase } from "@/lib/supabase";
import { AREAS, PAGE, fetchAudit, fetchAuditEntities, type AuditAction, type AuditEntity, type AuditRow } from "@/lib/auditApi";

// -----------------------------------------------------------------------------
// Activity log (admins): everything people added, changed or deleted in
// iklipse, newest first, as a table. Narrow it by words, person, part of
// iklipse, type of thing, action and a time window; the filters live in the
// address, so coming back from a thing keeps them. Pick a row for the full
// details: who, when, where it lives, and every field it had or that changed
// (before and after), with a button to open the thing. Ids are never shown:
// each one reads as the name it points at, or "(deleted)" when that is gone.
// -----------------------------------------------------------------------------

type Names = Record<string, string>;

const AREA_LABEL = Object.fromEntries(AREAS.map((a) => [a.value, a.label])) as Record<string, string>;

// The accent is red-orange here, too close to Deleted: changes are amber.
const ACTION: Record<AuditAction, { word: string; tone: "success" | "warn" | "danger" }> = {
  create: { word: "Added", tone: "success" },
  edit: { word: "Changed", tone: "warn" },
  delete: { word: "Deleted", tone: "danger" },
};
const ACTIONS = Object.keys(ACTION) as AuditAction[];

// What the columns are called on screen. The order is also the order of the
// details (title first); anything not here is spelled out by humanise().
const FIELD: Record<string, string> = {
  title: "Title",
  name: "Name",
  display_name: "Name",
  description: "Description",
  body: "Text",
  text: "Text",
  note: "Note",
  notes: "Notes",
  list_id: "List",
  board_id: "Board",
  card_id: "Card",
  project_id: "Project",
  folder_id: "Delivery",
  client_id: "Client",
  checklist_id: "Checklist",
  label_id: "Label",
  user_id: "Person",
  assignee_id: "Assignee",
  owner_id: "Owner",
  author_id: "Author",
  author_name: "Author",
  author_email: "Author's email",
  grantee_id: "Shared with",
  item_id: "File",
  link_id: "Link",
  share_link_id: "Share link",
  delivery_id: "Delivery date",
  cover_attachment_id: "Cover picture",
  workspace_id: "Workspace",
  account_id: "Account",
  source_id: "Source",
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
  email: "Email",
  phone: "Phone",
  sessions_revoked_at: "Signed out",
  cost: "Cost",
  currency: "Currency",
  amount: "Amount",
  paid_on: "Paid on",
  issued_on: "Date",
  due_on: "Pay by",
  number: "Number",
  invoice_number: "Invoice number",
  invoice_date: "Invoice date",
  is_refund: "Refund",
  delivered: "Sent to the client",
  delivered_at: "Sent to the client on",
  done_at: "Delivered",
  done_by: "Delivered by",
  removed_at: "Removed",
  revoked_at: "Stopped",
  expires_at: "Expires",
  resolved_at: "Resolved",
  resolved: "Resolved",
  resolved_by: "Resolved by",
  closed_at: "Closed",
  closed_by: "Closed by",
  snoozed_until: "Snoozed until",
  close_note: "Note",
  client_note: "Note for the client",
  visibility: "Visibility",
  comment_policy: "Comments",
  member_policy: "Adding members",
  background: "Background",
  is_enabled: "On",
  is_template: "Template",
  access: "Access",
  can_edit: "Can edit",
  can_reply: "Can reply",
  outcome: "Client's answer",
  submitted_at: "Sent",
  submitted_name: "Sender's name",
  submitted_email: "Sender's email",
  round: "Round",
  added_round: "Added in round",
  state: "State",
  external_url: "Link",
  max_devices: "Devices",
  max_people: "People",
  max_calls: "Most calls",
  allow_download: "Download",
  label: "Label",
  calls_enabled: "Calls",
  enabled: "On",
  created_by: "Created by",
  added_by: "Added by",
  added_at: "Added",
  uploaded_by: "Uploaded by",
  opened_by: "Opened by",
  guest_name: "Guest's name",
  file_name: "File name",
  mime_type: "File type",
  size: "Size",
  storage_path: "Stored at",
  position: "Position",
  show_on_front: "Shown on the card",
  wb_allow_copy: "Allow copies",
  wb_team_access: "Team access",
  cc_admins: "Copy the admins",
  quiet_from: "Quiet from",
  quiet_to: "Quiet until",
  slug: "Link name",
  short_id: "Short link",
  mirror_of: "Mirror of",
  sender_name: "Sender",
  sender_email: "Sender's email",
  purchaser_email: "Buyer's email",
  received_at: "Received",
  last_alert_at: "Last alert",
  next_alert_at: "Next alert",
};
const RANK = new Map(Object.keys(FIELD).map((k, i) => [k, i]));

/** A column as words: "resolved_by" is "Resolved by", "assignee_id" "Assignee", "is_private" "Private", "label_ids" "Labels". */
function humanise(k: string): string {
  const s = k.replace(/^is_/, "").replace(/_ids$/, "s").replace(/_id$/, "").replace(/_url$/, "_link").replace(/_min$/, "_(minutes)").replace(/_/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : k;
}
const fieldName = (k: string) => FIELD[k] ?? humanise(k);
/** "checklist item" reads "Checklist item". */
const entityLabel = (e: string) => (e.charAt(0).toUpperCase() + e.slice(1)).replace(/_/g, " ");
const areaLabel = (a: string) => AREA_LABEL[a] ?? entityLabel(a);

// ------------------------------------------------------------------ values --

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_IN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const known = (names: Names, id: string) => Object.prototype.hasOwnProperty.call(names, id.toLowerCase());
const blank = (v: unknown) => v === null || v === undefined || v === "" || (typeof v === "object" && Object.keys(v as object).length === 0);

/** What an id reads as: the name it points at, or "(deleted)" when the thing is gone. */
function nameOf(id: string, names: Names): string {
  return known(names, id) ? names[id.toLowerCase()] || "(no name)" : "(deleted)";
}

/** Ids inside longer text (a file's path...): the name when known, otherwise left out. */
const hideIds = (s: string, names: Names) => s.replace(UUID_IN, (id) => (known(names, id) ? nameOf(id, names) : "…"));

/** A thing the row is about (its board, card...): its name now, the name it had then, or "(deleted)". */
function refName(id: string | undefined, then: string | undefined, names: Names): string | null {
  if (!id) return then ?? null;
  if (known(names, id)) return names[id.toLowerCase()] || then || "(no name)";
  return then ? `${then} (deleted)` : "(deleted)";
}

/** A value as words: Yes / No, local dates, names for ids, compact JSON for the rest ("" = empty). */
function text(v: unknown, names: Names): string {
  if (blank(v)) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "string") {
    if (UUID.test(v)) return nameOf(v, names);
    if (STAMP.test(v)) {
      const d = new Date(v);
      if (!isNaN(d.getTime())) return format(d, "d MMM yyyy, HH:mm");
    }
    if (DAY.test(v)) {
      const [y, m, d] = v.split("-").map(Number);
      return format(new Date(y, m - 1, d), "d MMM yyyy");
    }
    return hideIds(v, names);
  }
  if (Array.isArray(v) && v.every((x) => x === null || typeof x !== "object")) return v.map((x) => text(x, names) || "empty").join(", ");
  if (typeof v === "object") return JSON.stringify(v, (_k, x: unknown) => (typeof x !== "string" ? x : isUuid(x) ? nameOf(x, names) : hideIds(x, names)));
  return String(v);
}

const sameYear = (d: Date) => d.getFullYear() === new Date().getFullYear();
/** "16 Oct, 10:26" (with the year when it isn't this one). */
function whenShort(iso: string) {
  const d = new Date(iso);
  return format(d, sameYear(d) ? "d MMM, HH:mm" : "d MMM yyyy, HH:mm");
}
/** "Friday 16 October 2026, 10:26:05". */
const whenFull = (iso: string) => format(new Date(iso), "EEEE d MMMM yyyy, HH:mm:ss");
/** A picked "YYYY-MM-DDTHH:mm" as words, "16 Oct 2026, 10:26". */
const stamp = (local: string) => format(new Date(local), "d MMM yyyy, HH:mm");

// ------------------------------------------------------------------- rows --

interface Field {
  key: string;
  label: string;
  before?: unknown;
  value: unknown;
}

/** Every field of the row's changes, best known first. An edit has before and after (both empty is left out). */
function fields(r: AuditRow): Field[] {
  const out: Field[] = [];
  for (const [key, v] of Object.entries(r.changes ?? {})) {
    if (r.action !== "edit") {
      out.push({ key, label: fieldName(key), value: v });
      continue;
    }
    const [before, after] = Array.isArray(v) && v.length === 2 ? v : [undefined, v];
    if (blank(before) && blank(after)) continue;
    out.push({ key, label: fieldName(key), before, value: after });
  }
  return out.sort((a, b) => (RANK.get(a.key) ?? 1e3) - (RANK.get(b.key) ?? 1e3) || a.label.localeCompare(b.label));
}

/** The table's short line for an edit: "Title, Due date". */
function summary(r: AuditRow): string {
  return r.action === "edit" ? [...new Set(fields(r).map((f) => f.label))].join(", ") : "";
}

// Memberships are about a person on something.
const MEMBER_OF: Record<string, "card" | "board" | "project"> = { "card member": "card", "board member": "board", "team member": "project" };

/** The person a row is about (memberships): their name now, the one logged, or "(deleted)". */
function person(r: AuditRow): string | null {
  const id = r.changes?.user_id;
  if (isUuid(id) && known(r.names, id)) return nameOf(id, r.names);
  return r.ref.person ?? (isUuid(id) ? "(deleted)" : null);
}

/** A row without a label: the names of the ids in its row_id ("<board>:<card>"). */
function ownName(r: AuditRow): string | null {
  const ids = (r.row_id ?? "").split(":").filter((p) => isUuid(p) && known(r.names, p));
  return ids.length ? ids.map((p) => nameOf(p, r.names)).join(", ") : null;
}

/** What a row is about: its name, and where it lives ("in Marketing", "on Homepage"). */
function about(r: AuditRow): { title: string | null; where: string | null } {
  const n = r.names;
  const card = refName(r.ref.card_id, r.ref.card, n);
  const board = refName(r.ref.board_id, r.ref.board, n);
  const project = refName(r.ref.project_id, r.ref.project, n);
  const folder = refName(r.ref.folder_id, r.ref.folder, n);
  const member = MEMBER_OF[r.entity];
  if (member) {
    const on = member === "card" ? card : member === "board" ? board : project;
    return { title: person(r) ?? r.label, where: on ? `on ${on}` : null };
  }
  if (r.entity === "card label") {
    const id = r.changes?.label_id;
    return { title: r.ref.label_name ?? (isUuid(id) && known(n, id) ? nameOf(id, n) : null) ?? r.label, where: card ? `on ${card}` : null };
  }
  const where = (r.entity !== "card" ? card : null) ?? (r.entity !== "delivery" ? folder : null) ?? (r.entity !== "project" ? project : null) ?? (r.entity !== "board" ? board : null);
  return { title: r.label ?? ownName(r), where: where ? `in ${where}` : null };
}

/** Where it lives, for the details: board, card, project, delivery, person. */
function context(r: AuditRow): [string, string][] {
  const n = r.names;
  const all: [string, string | null][] = [
    ["Board", r.entity !== "board" ? refName(r.ref.board_id, r.ref.board, n) : null],
    ["Card", r.entity !== "card" ? refName(r.ref.card_id, r.ref.card, n) : null],
    ["Project", r.entity !== "project" ? refName(r.ref.project_id, r.ref.project, n) : null],
    ["Delivery", r.entity !== "delivery" ? refName(r.ref.folder_id, r.ref.folder, n) : null],
    // A membership's person is already its name.
    ["Person", MEMBER_OF[r.entity] ? null : (r.ref.person ?? null)],
  ];
  return all.filter((x): x is [string, string] => !!x[1]);
}

/** Where the thing is, if it's still there (boards, cards, projects and deliveries missing from names are gone). */
function href(r: AuditRow): string | null {
  const id = r.row_id ?? "";
  const uuid = isUuid(id) ? id : null;
  const alive = (x?: string | null): x is string => !!x && known(r.names, x);
  if (r.action === "delete" && !["card", "comment", "attachment", "checklist", "checklist item", "card label", "card member"].includes(r.entity)) {
    if (r.entity !== "project" && alive(r.ref.project_id)) return `/projects/${r.ref.project_id}`;
    if (alive(r.ref.folder_id)) return `/deliveries/${r.ref.folder_id}`;
    return null;
  }
  switch (r.area) {
    case "trello":
      if (r.entity === "card" && r.action !== "delete" && alive(uuid) && alive(r.ref.board_id)) return `/pm/boards/${r.ref.board_id}/cards/${uuid}`;
      if (alive(r.ref.card_id) && alive(r.ref.board_id)) return `/pm/boards/${r.ref.board_id}/cards/${r.ref.card_id}`;
      if (r.entity === "board" && alive(uuid)) return `/pm/boards/${uuid}`;
      return alive(r.ref.board_id) ? `/pm/boards/${r.ref.board_id}` : null;
    case "miro":
      return r.entity === "board" && alive(uuid) ? `/wb/${uuid}` : alive(r.ref.board_id) ? `/wb/${r.ref.board_id}` : null;
    case "projects":
      return r.entity === "project" && alive(uuid) ? `/projects/${uuid}` : alive(r.ref.project_id) ? `/projects/${r.ref.project_id}` : null;
    case "deliveries":
      return r.entity === "delivery" && alive(uuid) ? `/deliveries/${uuid}` : alive(r.ref.folder_id) ? `/deliveries/${r.ref.folder_id}` : null;
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

// ---------------------------------------------------------------- filters --

interface Filters {
  q: string;
  who: string;
  part: string;
  type: string;
  did: AuditAction | "";
  /** Local "YYYY-MM-DDTHH:mm", as the date field gives it. */
  from: string;
  to: string;
}

function readFilters(p: URLSearchParams): Filters {
  const did = p.get("did") ?? "";
  return {
    q: p.get("q") ?? "",
    who: p.get("who") ?? "",
    part: p.get("part") ?? "",
    type: p.get("type") ?? "",
    did: ACTIONS.includes(did as AuditAction) ? (did as AuditAction) : "",
    from: p.get("from") ?? "",
    to: p.get("to") ?? "",
  };
}

/** A picked local time as an ISO timestamp (null when unset or unreadable). */
function toIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

type Person = { id: string; display_name: string; avatar_url: string | null };

// ------------------------------------------------------------------- page --

export default function ActivityPage() {
  const [params, setParams] = useSearchParams();
  const f = useMemo(() => readFilters(params), [params]);
  const set = useCallback(
    (patch: Partial<Filters>) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v) next.set(k, v);
            else next.delete(k);
          }
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );

  // The search box types freely; the address (and the query) follow 300ms later.
  const [typed, setTyped] = useState(f.q);
  useEffect(() => {
    const q = typed.trim();
    if (q === f.q) return;
    const id = window.setTimeout(() => set({ q }), 300);
    return () => window.clearTimeout(id);
  }, [typed, f.q, set]);

  const people = useQuery({
    queryKey: ["activity-people"],
    queryFn: async () => {
      const { data, error } = await supabase.from("profile").select("id, display_name, avatar_url").order("display_name");
      if (error) throw error;
      return (data ?? []) as Person[];
    },
    staleTime: 5 * 60_000,
  });
  const kinds = useQuery({ queryKey: ["activity-entities"], queryFn: fetchAuditEntities, staleTime: 5 * 60_000 });

  const from = toIso(f.from);
  const to = toIso(f.to);
  const log = useInfiniteQuery({
    queryKey: ["activity-log", f.part, f.who, f.q, f.did, f.type, from, to],
    queryFn: ({ pageParam }) => fetchAudit({ before: pageParam, area: f.part, actor: f.who, q: f.q, action: f.did, entity: f.type, from, to }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.length < PAGE ? undefined : last[last.length - 1].at),
    // A new filter keeps the old rows on screen (dimmed) until the new ones land.
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const rows = useMemo(() => log.data?.pages.flat() ?? [], [log.data]);
  const [open, setOpen] = useState<AuditRow | null>(null);

  const filtered = !!(f.q || f.who || f.part || f.type || f.did || f.from || f.to);
  const backwards = !!(from && to && from >= to);
  const clear = () => {
    setTyped("");
    set({ q: "", who: "", part: "", type: "", did: "", from: "", to: "" });
  };

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 px-4 pt-4 md:px-6 md:pt-6">
        <div className="mb-4">
          <PageTitle>Activity log</PageTitle>
          <p className="text-sm text-muted mt-1 hidden sm:block">Who added, changed or deleted what in iklipse, and when. Pick a row for the full details. Kept for a year.</p>
        </div>
        <FilterBar
          f={f}
          set={set}
          typed={typed}
          onType={setTyped}
          busy={log.isFetching && log.isPlaceholderData}
          people={people.data ?? []}
          kinds={kinds.data ?? []}
          onClear={clear}
        />
      </div>

      <div className="flex-1 min-h-0 flex flex-col px-4 pt-3 pb-4 md:px-6 md:pb-6">
        {log.isLoading ? (
          <PageSpinner />
        ) : log.error && !rows.length ? (
          <EmptyState icon={<AlertTriangle size={20} />} title="Couldn't load the log" description={(log.error as Error).message} />
        ) : !rows.length ? (
          <EmptyState
            icon={<History size={20} />}
            title={filtered ? "Nothing matches" : "Nothing yet"}
            description={
              backwards
                ? "The From time is after the To time."
                : filtered
                  ? "Try fewer filters or a wider time window."
                  : "From now on, everything people add, change or delete shows up here."
            }
            action={filtered ? <Button onClick={clear}>Clear filters</Button> : undefined}
          />
        ) : (
          <>
            <LogTable rows={rows} stale={log.isPlaceholderData} onOpen={setOpen} />
            <div className="shrink-0 pt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
              <span>
                Showing <span className="font-semibold text-muted tabular-nums">{rows.length}</span> {rows.length === 1 ? "entry" : "entries"}
              </span>
              {log.isFetchNextPageError && <span className="text-danger">Couldn't load older entries.</span>}
              {log.hasNextPage && (
                <Button size="sm" variant="ghost" className="ml-auto" loading={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
                  Show older
                </Button>
              )}
            </div>
          </>
        )}
      </div>

      <EntryModal r={open} onClose={() => setOpen(null)} />
    </div>
  );
}

// Phones: the search box and a Filters button; the filters open below it in
// two columns. sm and up: everything in one wrapping row (the panel is
// display: contents there).
function FilterBar({
  f,
  set,
  typed,
  onType,
  busy,
  people,
  kinds,
  onClear,
}: {
  f: Filters;
  set: (patch: Partial<Filters>) => void;
  typed: string;
  onType: (v: string) => void;
  busy: boolean;
  people: Person[];
  kinds: AuditEntity[];
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const picked = [f.who, f.part, f.type, f.did, f.from, f.to].filter(Boolean).length;

  const who = useMemo(
    () => [
      { value: "", label: "Everyone" },
      ...people.map((p) => ({ value: p.id, label: p.display_name, icon: <Avatar name={p.display_name} src={p.avatar_url} size={18} /> })),
    ],
    [people],
  );
  // Types in the log, deduped (a "comment" is in Trello, Miro and Deliveries), for the picked part only.
  const types = useMemo(() => {
    const seen = new Set<string>();
    for (const k of kinds) if (!f.part || k.area === f.part) seen.add(k.entity);
    if (f.type) seen.add(f.type);
    const list = [...seen].map((e) => ({ value: e, label: entityLabel(e) })).sort((a, b) => a.label.localeCompare(b.label));
    return [{ value: "", label: "All types" }, ...list];
  }, [kinds, f.part, f.type]);
  // A part without the picked type drops the type.
  const pickPart = (part: string) => set({ part, type: part && f.type && kinds.length && !kinds.some((k) => k.area === part && k.entity === f.type) ? "" : f.type });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <SearchField value={typed} onChange={onType} loading={busy} placeholder="Search names and titles" aria-label="Search the log" className="flex-1 min-w-0 sm:flex-none sm:w-64" />
      <Button className="sm:hidden" iconLeft={<SlidersHorizontal size={15} />} aria-expanded={open} aria-controls={panel} onClick={() => setOpen(!open)}>
        Filters
        {picked > 0 && <span className="rounded-full bg-accent-soft px-1.5 text-xs font-semibold text-accent tabular-nums">{picked}</span>}
      </Button>
      <div id={panel} className={cn("w-full grid-cols-2 gap-2 sm:contents", open ? "grid" : "hidden")}>
        <Select value={f.who} onChange={(v) => set({ who: v })} options={who} searchable placeholder="Person" aria-label="Person" className="col-span-2 sm:w-48" />
        <Select value={f.part} onChange={pickPart} options={[{ value: "", label: "All parts" }, ...AREAS]} aria-label="Part of iklipse" className="sm:w-36" />
        <Select value={f.type} onChange={(v) => set({ type: v })} options={types} aria-label="Type" className="sm:w-44" />
        <div role="group" aria-label="Action" className="col-span-2">
          <Segmented<"all" | AuditAction>
            value={f.did || "all"}
            onChange={(v) => set({ did: v === "all" ? "" : v })}
            options={[{ value: "all", label: "All" }, ...ACTIONS.map((a) => ({ value: a, label: ACTION[a].word }))]}
          />
        </div>
        <TimeFilter label="From" value={f.from} onChange={(v) => set({ from: v })} max={f.to.slice(0, 10) || undefined} />
        <TimeFilter label="To" value={f.to} onChange={(v) => set({ to: v })} min={f.from.slice(0, 10) || undefined} />
        {(picked > 0 || !!typed.trim()) && (
          <Button variant="ghost" iconLeft={<X size={14} />} onClick={onClear} className="col-span-2 justify-self-start">
            Clear filters
          </Button>
        )}
      </div>
    </div>
  );
}

/** "From [date and time]": one end of the time window. */
function TimeFilter({ label, value, onChange, min, max }: { label: string; value: string; onChange: (v: string) => void; min?: string; max?: string }) {
  return (
    <div className="col-span-2 flex items-center gap-2 sm:w-64">
      <span className="w-9 shrink-0 text-base text-muted sm:w-auto sm:text-sm">{label}</span>
      <DateField
        withTime
        value={value}
        onChange={onChange}
        min={min}
        max={max}
        placeholder="Any time"
        aria-label={value ? `${label} ${stamp(value)}` : `${label}, any time`}
        className="flex-1 min-w-0"
      />
    </div>
  );
}

// ------------------------------------------------------------------ table --

const TH = "text-left font-semibold px-3 py-2.5 border-b border-border";
const TD = "px-3 py-2.5 border-b border-line align-middle";

// One scroll box for both ways, so the header sticks and a phone scrolls the
// table sideways, never the page.
function LogTable({ rows, stale, onOpen }: { rows: AuditRow[]; stale: boolean; onOpen: (r: AuditRow) => void }) {
  return (
    <div className={cn("min-h-0 overflow-auto rounded-lg border border-border bg-surface transition-opacity", stale && "opacity-60")}>
      <table className="w-full min-w-[880px] table-fixed text-sm border-separate border-spacing-0 [&>tbody>tr:last-child>td]:border-b-0">
        <caption className="sr-only">Activity, newest first. Pick a row for the full details.</caption>
        <colgroup>
          <col className="w-[8.5rem]" />
          <col className="w-[10rem]" />
          <col className="w-[6rem]" />
          <col className="w-[8.5rem]" />
          <col />
          <col className="w-[11rem]" />
        </colgroup>
        <thead className="sticky top-0 z-10">
          <tr className="bg-inset/95 backdrop-blur text-muted text-[11px] uppercase tracking-eyebrow">
            <th scope="col" className={TH}>When</th>
            <th scope="col" className={TH}>Who</th>
            <th scope="col" className={TH}>Action</th>
            <th scope="col" className={TH}>Type</th>
            <th scope="col" className={TH}>What</th>
            <th scope="col" className={TH}>Changes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <LogRow key={r.id} r={r} i={i % PAGE} onOpen={onOpen} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The whole row opens the details on a click; the What cell is the row's
// real button, for the keyboard and screen readers.
function LogRow({ r, i, onOpen }: { r: AuditRow; i: number; onOpen: (r: AuditRow) => void }) {
  const a = ACTION[r.action];
  const { title, where } = about(r);
  const changed = summary(r);
  const who = r.actor_name ?? "Someone";
  return (
    <tr
      style={{ "--i": Math.min(i, 12) } as CSSProperties}
      onClick={() => onOpen(r)}
      className="rise group cursor-pointer transition-colors hover:bg-inset has-[:focus-visible]:bg-accent-soft"
    >
      <td className={TD}>
        <time dateTime={r.at} className="block truncate text-ink tabular-nums">
          {whenShort(r.at)}
        </time>
        <span className="block truncate text-xs text-subtle">{relativeTime(r.at)}</span>
      </td>
      <td className={TD}>
        <span className="flex min-w-0 items-center gap-2">
          <Avatar name={who} src={r.actor_avatar} size={24} className="shrink-0" />
          <span className="truncate text-ink">{who}</span>
        </span>
      </td>
      <td className={TD}>
        <Badge tone={a.tone}>{a.word}</Badge>
      </td>
      <td className={TD}>
        <span className="block truncate text-ink">{entityLabel(r.entity)}</span>
        <span className="block truncate text-xs text-subtle">{areaLabel(r.area)}</span>
      </td>
      <td className={TD}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpen(r);
          }}
          aria-label={`${a.word} ${r.entity}: ${title ?? "no name"}, by ${who}, ${whenShort(r.at)}. Show the details`}
          className="block w-full min-w-0 scroll-my-12 text-left outline-none"
        >
          <span title={title ?? undefined} className={cn("block truncate font-medium transition-colors group-hover:text-accent", title ? "text-ink" : "text-muted")}>
            {title ?? entityLabel(r.entity)}
          </span>
          {where && <span className="block truncate text-xs text-muted">{where}</span>}
        </button>
      </td>
      <td className={TD} title={changed || undefined}>
        <span className={cn("block truncate", changed ? "text-muted" : "text-subtle")}>{changed || "-"}</span>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------- details --

function EntryModal({ r, onClose }: { r: AuditRow | null; onClose: () => void }) {
  const navigate = useNavigate();
  const to = r ? href(r) : null;
  return (
    <Modal
      open={!!r}
      onClose={onClose}
      size="lg"
      title={r ? `${ACTION[r.action].word} ${r.entity}` : undefined}
      footer={
        r ? (
          <>
            <Button onClick={onClose}>Close</Button>
            {to && (
              <Button variant="primary" iconRight={<ArrowRight size={15} />} onClick={() => navigate(to)}>
                Open
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {r && <Details r={r} />}
    </Modal>
  );
}

function Details({ r }: { r: AuditRow }) {
  const a = ACTION[r.action];
  const { title } = about(r);
  const list = fields(r);
  const who = r.actor_name ?? "Someone";
  const heading = r.action === "edit" ? "What changed" : r.action === "create" ? "Details when added" : "Details when deleted";
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Avatar name={who} src={r.actor_avatar} size={36} className="shrink-0" />
        <div className="min-w-0">
          <div className="truncate font-semibold text-ink">{who}</div>
          <div className="text-sm text-muted">
            <time dateTime={r.at}>{whenFull(r.at)}</time> · {relativeTime(r.at)}
          </div>
        </div>
      </div>

      <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-base">
        <Term k="Action">
          <Badge tone={a.tone}>{a.word}</Badge>
        </Term>
        <Term k="Part">{areaLabel(r.area)}</Term>
        <Term k="Type">{entityLabel(r.entity)}</Term>
        <Term k="What">{title ?? <span className="text-subtle">No name</span>}</Term>
        {context(r).map(([k, v]) => (
          <Term key={k} k={k}>
            {v}
          </Term>
        ))}
      </dl>

      <section>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-eyebrow text-subtle">
          {heading}
          {list.length > 0 && ` (${list.length})`}
        </h3>
        {list.length ? <FieldTable edit={r.action === "edit"} list={list} names={r.names} /> : <p className="text-base text-muted">No details were kept for this one.</p>}
      </section>
    </div>
  );
}

function Term({ k, children }: { k: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd className="min-w-0 text-ink [overflow-wrap:anywhere]">{children}</dd>
    </>
  );
}

/** Field | Before | After for an edit, Field | Value for an add or a delete. */
function FieldTable({ edit, list, names }: { edit: boolean; list: Field[]; names: Names }) {
  const th = "text-left font-semibold px-3 py-2";
  const td = "align-top px-3 py-2 border-t border-line";
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full table-fixed text-base border-separate border-spacing-0">
        <colgroup>
          <col className={edit ? "w-[28%]" : "w-[34%]"} />
          <col />
          {edit && <col />}
        </colgroup>
        <thead>
          <tr className="bg-inset text-muted text-[11px] uppercase tracking-eyebrow">
            <th scope="col" className={th}>Field</th>
            {edit ? (
              <>
                <th scope="col" className={th}>Before</th>
                <th scope="col" className={th}>After</th>
              </>
            ) : (
              <th scope="col" className={th}>Value</th>
            )}
          </tr>
        </thead>
        <tbody>
          {list.map((x) => (
            <tr key={x.key}>
              <th scope="row" title={x.key} className={cn(td, "text-left font-medium text-muted [overflow-wrap:anywhere]")}>
                {x.label}
              </th>
              {edit && (
                <td className={td}>
                  <Val v={x.before} names={names} was />
                </td>
              )}
              <td className={td}>
                <Val v={x.value} names={names} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One value, readable; the old one of an edit struck through. */
function Val({ v, names, was }: { v: unknown; names: Names; was?: boolean }) {
  const t = text(v, names);
  if (!t) return <span className="text-subtle">empty</span>;
  return (
    <span className={cn("whitespace-pre-wrap [overflow-wrap:anywhere]", was ? "text-subtle line-through decoration-line" : "text-ink")}>
      {typeof v === "string" && HEX.test(v) && <span aria-hidden className="mr-1.5 inline-block h-3 w-3 rounded-sm border border-line align-[-1px]" style={{ background: v }} />}
      {t}
    </span>
  );
}
