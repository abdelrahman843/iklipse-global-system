import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Briefcase, Building2, Clock, FolderKanban, Mail, MessageCircle, MoreHorizontal, Pencil, Phone, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { LineTabs, type LineTab } from "@/components/ui/LineTabs";
import { SearchField } from "@/components/ui/SearchField";
import { Select } from "@/components/ui/Select";
import { Menu, MenuDivider, MenuItem } from "@/components/ui/Menu";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSpinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { ROW, ROWS, Section, Stat, StatStrip } from "@/components/ui/Section";
import { cn } from "@/lib/cn";
import { DueLabel, PriorityBadge, Progress, StatusBadge, TeamFaces } from "@/components/projects/parts";
import { ClientModal, ProjectModal } from "@/components/projects/ProjectModals";
import { PageTitle, plural } from "@/components/ui/PageTitle";
import {
  PRIORITY_RANK,
  deleteClient,
  dueTone,
  fetchProjectsOverview,
  money,
  whatsappLink,
  type Client,
  type ProjectSummary,
} from "@/lib/projectsApi";

// -----------------------------------------------------------------------------
// Projects: the client projects the team works on. Admins see all of them and
// the clients (with their contacts); everyone else sees the projects they're
// on. ?tab=delivered|all|clients, ?client=<id> shows one client's projects.
// -----------------------------------------------------------------------------

type Tab = "active" | "delivered" | "all" | "clients";
type Sort = "due" | "priority" | "new";

/** The next date that matters: the earliest open delivery or the final date. */
export function nextDate(p: ProjectSummary): { at: string; what: string | null } | null {
  const open = p.status === "active" || p.status === "on_hold";
  const dates: { at: string; what: string | null }[] = [];
  if (p.next_due) dates.push({ at: p.next_due.due_at, what: p.next_due.title });
  if (open && p.due_at) dates.push({ at: p.due_at, what: "Final delivery" });
  dates.sort((a, b) => a.at.localeCompare(b.at));
  return dates[0] ?? null;
}

export default function ProjectsPage() {
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const askedTab = params.get("tab") as Tab | null;
  const clientFilter = params.get("client");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("due");
  const [newProject, setNewProject] = useState(false);
  const [editClient, setEditClient] = useState<Client | null | "new">(null);

  const overview = useQuery({ queryKey: ["projects"], queryFn: fetchProjectsOverview, refetchInterval: 60_000 });
  const ov = overview.data;
  const admin = !!ov?.admin;
  const tab: Tab = askedTab && ["active", "delivered", "all", "clients"].includes(askedTab) && (askedTab !== "clients" || admin) ? askedTab : "active";
  const go = (t: Tab, client?: string | null) => {
    const next: Record<string, string> = {};
    if (t !== "active") next.tab = t;
    if (client) next.client = client;
    setParams(next, { replace: true });
  };

  const removeClient = useMutation({
    mutationFn: deleteClient,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["projects"] }),
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't delete the client", description: e.message }),
  });

  const projects = ov?.projects ?? [];
  const clients = ov?.clients ?? [];
  const client = clientFilter ? clients.find((c) => c.id === clientFilter) ?? null : null;
  const needle = q.trim().toLowerCase();

  const byTab = useMemo(() => {
    const scoped = client ? projects.filter((p) => p.client_id === client.id) : projects;
    return {
      active: scoped.filter((p) => p.status === "active" || p.status === "on_hold"),
      delivered: scoped.filter((p) => p.status === "delivered" || p.status === "cancelled"),
      all: scoped,
    };
  }, [projects, client]);

  const shown = useMemo(() => {
    if (tab === "clients") return [];
    const list = byTab[tab].filter(
      (p) =>
        !needle ||
        [p.title, p.client?.name, p.client?.company, p.description, ...p.members.map((m) => m.name)]
          .filter(Boolean)
          .some((x) => x!.toLowerCase().includes(needle)),
    );
    const far = "9999";
    return [...list].sort((a, b) => {
      if (sort === "priority") return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (nextDate(a)?.at ?? far).localeCompare(nextDate(b)?.at ?? far);
      if (sort === "new") return b.created_at.localeCompare(a.created_at);
      return (nextDate(a)?.at ?? far).localeCompare(nextDate(b)?.at ?? far) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    });
  }, [byTab, tab, needle, sort]);

  const shownClients = useMemo(
    () =>
      clients.filter(
        (c) => !needle || [c.name, c.company, c.email, c.phone].filter(Boolean).some((x) => x!.toLowerCase().includes(needle)),
      ),
    [clients, needle],
  );

  const active = byTab.active;
  const late = active.filter((p) => {
    const n = nextDate(p);
    return n && dueTone(n.at, false) === "late";
  }).length;
  const soon = active.filter((p) => {
    const n = nextDate(p);
    return n && dueTone(n.at, false) === "soon";
  }).length;

  const tabs: LineTab<Tab>[] = [
    { value: "active", label: "Active", count: byTab.active.length },
    { value: "delivered", label: "Done", count: byTab.delivered.length },
    { value: "all", label: "All", count: byTab.all.length },
    ...(admin ? [{ value: "clients" as const, label: "Clients", count: clients.length }] : []),
  ];

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-3 sm:p-4 md:p-6">
        <div className="flex flex-wrap items-start sm:items-center gap-3 mb-4">
          <div className="flex-1 min-w-[12rem]">
            <PageTitle count={ov && plural(projects.length, "project")}>Projects</PageTitle>
            <p className="text-sm text-muted mt-1 hidden sm:block">
              {admin ? "Every client project, who's on it and when it's due." : "The projects you're on and when they're due."}
            </p>
          </div>
          {admin && (
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <Button size="sm" iconLeft={<Building2 size={14} />} onClick={() => setEditClient("new")}>
                New client
              </Button>
              <Button size="sm" variant="primary" iconLeft={<Plus size={14} />} onClick={() => setNewProject(true)}>
                New project
              </Button>
            </div>
          )}
        </div>
        <div className="mb-5 flex flex-col-reverse gap-3 lg:flex-row lg:items-end border-b border-border">
          <LineTabs value={tab} tabs={tabs} onChange={(t) => go(t, t === "clients" ? null : clientFilter)} label="Projects" bare />
          <div className="lg:ml-auto lg:pb-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            {tab !== "clients" && (
              <Select
                value={sort}
                onChange={(v) => setSort(v as Sort)}
                className="sm:w-44"
                aria-label="Sort"
                options={[
                  { value: "due", label: "Sort: next date" },
                  { value: "priority", label: "Sort: importance" },
                  { value: "new", label: "Sort: newest" },
                ]}
              />
            )}
            <SearchField value={q} onChange={setQ} placeholder={tab === "clients" ? "Search clients" : "Search projects"} className="sm:w-56" />
          </div>
        </div>

        <div key={`${tab}:${clientFilter ?? ""}`} className="view-enter space-y-8">
        {client && tab !== "clients" && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted">Client:</span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface pl-3 pr-1 py-0.5 text-ink">
              {client.name}
              <button type="button" aria-label="Show every client" onClick={() => go(tab)} className="h-6 w-6 grid place-items-center rounded-full text-subtle hover:text-ink hover:bg-inset">
                <X size={13} />
              </button>
            </span>
          </div>
        )}

        {tab === "active" && active.length > 0 && (
          <StatStrip>
            <Stat className="rise" style={{ "--i": 0 } as React.CSSProperties} label="Active" value={active.length} />
            <Stat
              className="rise"
              style={{ "--i": 1 } as React.CSSProperties}
              label={
                <span className="inline-flex items-center gap-1">
                  <AlertTriangle size={13} /> Late
                </span>
              }
              value={late}
              tone={late ? "danger" : undefined}
            />
            <Stat
              className="rise"
              style={{ "--i": 2 } as React.CSSProperties}
              label={
                <span className="inline-flex items-center gap-1">
                  <Clock size={13} /> Due in 2 days
                </span>
              }
              value={soon}
              tone={soon ? "warn" : undefined}
            />
          </StatStrip>
        )}

        {overview.isLoading ? (
          <PageSpinner />
        ) : !ov && overview.error ? (
          <EmptyState icon={<AlertTriangle size={20} />} title="Couldn't load the projects" description={(overview.error as Error).message} />
        ) : tab === "clients" ? (
          !shownClients.length ? (
            <EmptyState
              icon={<Building2 size={20} />}
              title={needle ? "Nothing matches" : "No clients yet"}
              description={needle ? undefined : "Add a client with their email and phone, then their projects."}
              action={!needle && <Button variant="primary" iconLeft={<Plus size={14} />} onClick={() => setEditClient("new")}>New client</Button>}
            />
          ) : (
            <Section title="Clients" count={shownClients.length}>
            <div className={ROWS}>
              {shownClients.map((c, i) => (
                <ClientRow
                  key={c.id}
                  i={i}
                  c={c}
                  onOpen={() => go("all", c.id)}
                  onEdit={() => setEditClient(c)}
                  onDelete={async () => {
                    const ok = await confirm({
                      title: `Delete ${c.name}?`,
                      message: c.projects ? `Their ${c.projects} ${c.projects === 1 ? "project stays" : "projects stay"}, without a client.` : undefined,
                      confirmLabel: "Delete",
                      danger: true,
                    });
                    if (ok) removeClient.mutate(c.id);
                  }}
                />
              ))}
            </div>
            </Section>
          )
        ) : !shown.length ? (
          <EmptyState
            icon={<FolderKanban size={20} />}
            title={needle ? "Nothing matches" : tab === "delivered" ? "Nothing delivered yet" : admin ? "No projects yet" : "You're not on a project yet"}
            description={
              needle
                ? undefined
                : admin
                  ? tab === "active"
                    ? "Make a project for a client, put the team on it and set its delivery dates."
                    : undefined
                  : "When an admin puts you on a project, it shows up here."
            }
            action={admin && !needle && tab === "active" ? <Button variant="primary" iconLeft={<Plus size={14} />} onClick={() => setNewProject(true)}>New project</Button> : undefined}
          />
        ) : (
          <Section title={tab === "delivered" ? "Done projects" : tab === "all" ? "All projects" : "Active projects"} count={shown.length}>
            <div className={ROWS}>
              {shown.map((p, i) => (
                <ProjectRow key={p.id} i={i} p={p} admin={admin} />
              ))}
            </div>
          </Section>
        )}
        </div>
      </div>

      {newProject && ov && (
        <ProjectModal project={null} clients={clients} people={ov.people} onClose={() => setNewProject(false)} onSaved={(id) => nav(`/projects/${id}`)} />
      )}
      {editClient && <ClientModal client={editClient === "new" ? null : editClient} onClose={() => setEditClient(null)} />}
    </div>
  );
}

/** One project as a row: name and client, the next date, then team, progress and cost. */
function ProjectRow({ p, admin, i }: { p: ProjectSummary; admin: boolean; i: number }) {
  const next = nextDate(p);
  const open = p.status === "active" || p.status === "on_hold";
  return (
    <Link
      to={`/projects/${p.id}`}
      style={{ "--i": Math.min(i, 12) } as React.CSSProperties}
      className={cn("rise", ROW, "group -mx-2 px-2 flex flex-col gap-2 min-w-0 md:flex-row md:items-center md:gap-6")}
    >
      <div className="min-w-0 flex-1 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-ink truncate group-hover:text-accent transition-colors">{p.title}</div>
          <div className="text-sm text-muted truncate">
            {p.client ? [p.client.name, p.client.company].filter(Boolean).join(" · ") : "No client"}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {p.status !== "active" && <StatusBadge status={p.status} />}
          <PriorityBadge priority={p.priority} />
        </div>
      </div>

      <div className="min-w-0 md:w-52 md:shrink-0">
        {open && next ? (
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-xs text-subtle truncate">Next: {next.what}</span>
            <DueLabel due={next.at} />
          </div>
        ) : p.status === "delivered" && p.delivered_at ? (
          <DueLabel due={p.delivered_at} done short />
        ) : (
          <span className="text-xs text-subtle">{open ? "No dates yet" : "Closed"}</span>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 md:shrink-0 md:justify-end md:w-72">
        <TeamFaces members={p.members} />
        <div className="flex items-center gap-3">
          <Progress done={p.deliveries_done} total={p.deliveries_total} />
          {admin && p.cost != null && <span className="text-sm font-semibold text-ink tabular-nums">{money(p.cost, p.currency)}</span>}
        </div>
      </div>
    </Link>
  );
}

function ClientRow({ c, i, onOpen, onEdit, onDelete }: { c: Client; i: number; onOpen: () => void; onEdit: () => void; onDelete: () => void }) {
  return (
    <div style={{ "--i": Math.min(i, 12) } as React.CSSProperties} className={cn("rise", ROW, "-mx-2 px-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4")}>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left group">
        <div className="font-medium text-ink truncate group-hover:text-accent">{c.name}</div>
        <div className="text-xs text-muted truncate">
          {[
            c.company,
            `${c.projects ?? 0} ${c.projects === 1 ? "project" : "projects"}${c.open ? `, ${c.open} open` : ""}`,
            c.from_chat && "added from WhatsApp",
            c.from_chat && !c.email && "no email yet",
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </button>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm min-w-0 sm:justify-end">
        {c.email && (
          <a href={`mailto:${c.email}`} className="inline-flex items-center gap-1.5 text-muted hover:text-ink min-w-0">
            <Mail size={14} className="shrink-0" /> <span className="truncate">{c.email}</span>
          </a>
        )}
        {c.phone && (
          <a href={`tel:${c.phone.replace(/\s+/g, "")}`} className="inline-flex items-center gap-1.5 text-muted hover:text-ink">
            <Phone size={14} /> {c.phone}
          </a>
        )}
      </div>
      <Menu
        align="right"
        trigger={
          <button type="button" aria-label={`Actions for ${c.name}`} className="h-9 w-9 self-end sm:self-auto grid place-items-center rounded-md text-subtle hover:text-ink hover:bg-inset">
            <MoreHorizontal size={16} />
          </button>
        }
      >
        {(close) => (
          <>
            <MenuItem onClick={() => (close(), onOpen())}>
              <span className="inline-flex items-center gap-2">
                <Briefcase size={14} /> Their projects
              </span>
            </MenuItem>
            {c.phone && (
              <MenuItem onClick={() => (close(), window.open(whatsappLink(c.phone!), "_blank", "noopener"))}>
                <span className="inline-flex items-center gap-2">
                  <MessageCircle size={14} /> WhatsApp
                </span>
              </MenuItem>
            )}
            <MenuItem onClick={() => (close(), onEdit())}>
              <span className="inline-flex items-center gap-2">
                <Pencil size={14} /> Edit
              </span>
            </MenuItem>
            <MenuDivider />
            <MenuItem destructive onClick={() => (close(), onDelete())}>
              <span className="inline-flex items-center gap-2">
                <Trash2 size={14} /> Delete
              </span>
            </MenuItem>
          </>
        )}
      </Menu>
    </div>
  );
}
