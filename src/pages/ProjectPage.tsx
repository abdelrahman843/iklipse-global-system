import { useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Building2,
  Check,
  CheckCircle2,
  Download,
  ExternalLink,
  File as FileIcon,
  FileText,
  Film,
  Image as ImageIcon,
  Link2,
  Mail,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Phone,
  Plus,
  Receipt,
  Send,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { BackButton } from "@/components/ui/BackButton";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { Textarea } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { PillTabs, type PillTab } from "@/components/ui/PillTabs";
import { Menu, MenuDivider, MenuItem } from "@/components/ui/Menu";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSpinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useAuth } from "@/lib/auth";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import { DueLabel, PriorityBadge, Progress, StatusBadge } from "@/components/projects/parts";
import { ClientModal, DeliveryModal, InvoiceModal, LinkModal, ProjectModal, TeamModal } from "@/components/projects/ProjectModals";
import {
  MAX_FILE,
  addNote,
  deleteDelivery,
  deleteNote,
  deleteProject,
  deleteProjectFile,
  deleteProjectInvoice,
  fetchProject,
  fetchProjectsOverview,
  fileSize,
  invoiceState,
  money,
  saveProjectInvoice,
  setDeliveryDone,
  signedUrls,
  updateProjectFile,
  uploadProjectFiles,
  whatsappLink,
  type Client,
  type Delivery,
  type ProjectDetail,
  type ProjectFile,
  type ProjectInvoice,
} from "@/lib/projectsApi";

// -----------------------------------------------------------------------------
// One project: what it is, its delivery dates, the team and notes; its files
// (the team's work and what was sent to the client); and, for admins, the
// client's contacts, the cost and the invoices. ?tab=files|money.
// -----------------------------------------------------------------------------

type Tab = "overview" | "files" | "money";

export default function ProjectPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const asked = params.get("tab") as Tab | null;

  const q = useQuery({ queryKey: ["project", id], queryFn: () => fetchProject(id), enabled: !!id, refetchInterval: 30_000 });
  const p = q.data;
  const admin = !!p?.admin;
  // Clients and people for the admin forms.
  const ov = useQuery({ queryKey: ["projects"], queryFn: fetchProjectsOverview, enabled: admin });

  const tab: Tab = asked === "files" || (asked === "money" && admin) ? asked : "overview";
  const setTab = (t: Tab) => setParams(t === "overview" ? {} : { tab: t }, { replace: true });

  const [editing, setEditing] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);

  const remove = useMutation({
    mutationFn: () => deleteProject(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["projects-count"] });
      nav("/projects", { replace: true });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't delete the project", description: e.message }),
  });

  if (q.isLoading) return <PageSpinner />;
  if (!p) {
    return (
      <div className="h-full grid place-items-center">
        <EmptyState
          icon={<AlertTriangle size={20} />}
          title="Project not found"
          description={(q.error as Error | null)?.message === "Project not found" ? "It was deleted, or you're not on its team." : (q.error as Error | null)?.message}
          action={<Button onClick={() => nav("/projects")}>All projects</Button>}
        />
      </div>
    );
  }

  const tabs: PillTab<Tab>[] = [
    { value: "overview", label: "Overview" },
    { value: "files", label: "Files", count: p.files.length },
    ...(admin ? [{ value: "money" as const, label: "Client & money", count: p.invoices.length }] : []),
  ];

  return (
    <div className="h-full flex flex-col min-h-0">
      <header className="shrink-0 px-3 sm:px-4 md:px-6 pt-3 sm:pt-4 pb-4 border-b border-border bg-surface flex flex-col gap-3">
        <BackButton fallback="/projects" label="Projects" className="self-start" />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl sm:text-2xl font-semibold text-ink tracking-tight break-words">{p.title}</h1>
              <PriorityBadge priority={p.priority} />
              <StatusBadge status={p.status} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
              <span className="inline-flex items-center gap-1.5">
                <Building2 size={14} /> {p.client ? [p.client.name, p.client.company].filter(Boolean).join(" · ") : "No client"}
              </span>
              {p.due_at && (
                <span className="inline-flex items-center gap-1.5">
                  Final delivery <DueLabel due={p.due_at} done={p.status === "delivered" || p.status === "cancelled"} />
                </span>
              )}
            </div>
          </div>
          {admin && (
            <div className="flex items-center gap-2 shrink-0">
              <Button size="sm" iconLeft={<Pencil size={14} />} onClick={() => setEditing(true)} disabled={!ov.data}>
                Edit
              </Button>
              <Menu
                align="right"
                trigger={
                  <button type="button" aria-label="More" className="h-8 w-8 grid place-items-center rounded-md border border-border text-muted hover:text-ink hover:bg-inset">
                    <MoreHorizontal size={16} />
                  </button>
                }
              >
                {(close) => (
                  <MenuItem
                    destructive
                    onClick={async () => {
                      close();
                      const ok = await confirm({
                        title: `Delete ${p.title}?`,
                        message: "Its deliveries, notes, files and invoices go too. This can't be undone.",
                        confirmLabel: "Delete",
                        danger: true,
                      });
                      if (ok) remove.mutate();
                    }}
                  >
                    <span className="inline-flex items-center gap-2">
                      <Trash2 size={14} /> Delete project
                    </span>
                  </MenuItem>
                )}
              </Menu>
            </div>
          )}
        </div>
        <PillTabs value={tab} tabs={tabs} onChange={setTab} label="Project" scroll className="self-start" />
      </header>

      <div className="flex-1 min-h-0 overflow-auto px-3 sm:px-4 md:px-6 py-4">
        {tab === "overview" ? (
          <Overview p={p} onTeam={() => setTeamOpen(true)} canTeam={admin && !!ov.data} />
        ) : tab === "files" ? (
          <Files p={p} />
        ) : (
          <Money p={p} />
        )}
      </div>

      {editing && ov.data && (
        <ProjectModal project={p} clients={ov.data.clients} people={ov.data.people} onClose={() => setEditing(false)} />
      )}
      {teamOpen && ov.data && <TeamModal project={p} people={ov.data.people} onClose={() => setTeamOpen(false)} />}
    </div>
  );
}

function Section({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-xl border border-border bg-surface shadow-card", className)}>
      <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-2">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {action}
      </div>
      <div className="px-4 pb-4">{children}</div>
    </section>
  );
}

// ----------------------------------------------------------------- overview --
function Overview({ p, onTeam, canTeam }: { p: ProjectDetail; onTeam: () => void; canTeam: boolean }) {
  const { profile } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["project", p.id] });
    void qc.invalidateQueries({ queryKey: ["projects"] });
  };
  const [delivery, setDelivery] = useState<Delivery | null | "new">(null);
  const [note, setNote] = useState("");

  const done = useMutation({
    mutationFn: ({ d, v }: { d: Delivery; v: boolean }) => setDeliveryDone(d.id, v),
    onSuccess: refresh,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't update it", description: e.message }),
  });
  const removeDelivery = useMutation({
    mutationFn: deleteDelivery,
    onSuccess: refresh,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't delete it", description: e.message }),
  });
  const post = useMutation({
    mutationFn: () => addNote(p.id, note.trim()),
    onSuccess: () => {
      setNote("");
      refresh();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't post the note", description: e.message }),
  });
  const removeNote = useMutation({
    mutationFn: deleteNote,
    onSuccess: refresh,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't delete the note", description: e.message }),
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] items-start">
      <div className="space-y-4 min-w-0">
        <Section title="About">
          {p.description ? (
            <p className="text-sm text-ink whitespace-pre-wrap break-words leading-relaxed">{p.description}</p>
          ) : (
            <p className="text-sm text-subtle">{p.admin ? "Nothing written yet. Edit the project to add the brief." : "Nothing written yet."}</p>
          )}
        </Section>

        <Section
          title="Deliveries"
          action={
            <div className="flex items-center gap-3">
              <Progress done={p.deliveries_done} total={p.deliveries_total} />
              {p.admin && (
                <Button size="sm" variant="ghost" iconLeft={<Plus size={14} />} onClick={() => setDelivery("new")}>
                  Add
                </Button>
              )}
            </div>
          }
        >
          {!p.deliveries.length ? (
            <p className="text-sm text-subtle">
              {p.admin ? "Add the dates things are due. The team hears two days before, and when one is late." : "No delivery dates yet."}
            </p>
          ) : (
            <ul className="divide-y divide-line -mx-4">
              {p.deliveries.map((d) => (
                <li key={d.id} className="px-4 py-2.5 flex items-start gap-3">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={!!d.done_at}
                    aria-label={d.done_at ? `Mark ${d.title} not delivered` : `Mark ${d.title} delivered`}
                    disabled={done.isPending}
                    onClick={() => done.mutate({ d, v: !d.done_at })}
                    className={cn(
                      "mt-0.5 h-5 w-5 shrink-0 grid place-items-center rounded-md border transition-colors",
                      d.done_at ? "bg-success border-success text-white" : "border-rule hover:border-accent",
                    )}
                  >
                    {d.done_at && <Check size={13} strokeWidth={3} />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className={cn("text-sm break-words", d.done_at ? "text-muted line-through" : "text-ink font-medium")}>{d.title}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <DueLabel due={d.due_at} done={!!d.done_at} />
                      {d.assignee && (
                        <span className="inline-flex items-center gap-1.5 text-xs text-muted">
                          <Avatar src={d.assignee_avatar} name={d.assignee} size={16} /> {d.assignee}
                        </span>
                      )}
                      {d.done_at && d.done_by && <span className="text-xs text-subtle">Delivered by {d.done_by}</span>}
                    </div>
                  </div>
                  {p.admin && (
                    <Menu
                      align="right"
                      trigger={
                        <button type="button" aria-label={`Actions for ${d.title}`} className="h-8 w-8 shrink-0 grid place-items-center rounded-md text-subtle hover:text-ink hover:bg-inset">
                          <MoreHorizontal size={16} />
                        </button>
                      }
                    >
                      {(close) => (
                        <>
                          <MenuItem onClick={() => (close(), setDelivery(d))}>
                            <span className="inline-flex items-center gap-2">
                              <Pencil size={14} /> Edit
                            </span>
                          </MenuItem>
                          <MenuItem
                            destructive
                            onClick={async () => {
                              close();
                              if (await confirm({ title: `Delete ${d.title}?`, confirmLabel: "Delete", danger: true })) removeDelivery.mutate(d.id);
                            }}
                          >
                            <span className="inline-flex items-center gap-2">
                              <Trash2 size={14} /> Delete
                            </span>
                          </MenuItem>
                        </>
                      )}
                    </Menu>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Notes">
          <div className="space-y-2">
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={5000}
              placeholder="Write a note for the team…"
              aria-label="New note"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && note.trim()) post.mutate();
              }}
            />
            <div className="flex justify-end">
              <Button size="sm" variant="primary" iconLeft={<Send size={14} />} loading={post.isPending} disabled={!note.trim()} onClick={() => post.mutate()}>
                Post
              </Button>
            </div>
          </div>
          {p.notes.length > 0 && (
            <ul className="mt-3 space-y-3">
              {p.notes.map((n) => (
                <li key={n.id} className="flex gap-3">
                  <Avatar src={n.author_avatar} name={n.author ?? "?"} size={28} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-medium text-ink">{n.author ?? "Someone"}</span>
                      <span className="text-subtle">{relativeTime(n.created_at)}</span>
                      {(p.admin || n.author_id === profile?.id) && (
                        <button
                          type="button"
                          aria-label="Delete the note"
                          onClick={async () => {
                            if (await confirm({ title: "Delete this note?", confirmLabel: "Delete", danger: true })) removeNote.mutate(n.id);
                          }}
                          className="ml-auto h-7 w-7 grid place-items-center rounded-md text-subtle hover:text-danger hover:bg-inset"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                    <p className="text-sm text-ink whitespace-pre-wrap break-words">{n.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <div className="space-y-4 min-w-0">
        <Section
          title="Team"
          action={
            canTeam && (
              <Button size="sm" variant="ghost" iconLeft={<Users size={14} />} onClick={onTeam}>
                Edit
              </Button>
            )
          }
        >
          {!p.members.length ? (
            <p className="text-sm text-subtle">{p.admin ? "Nobody yet. Add the people working on it." : "Nobody yet."}</p>
          ) : (
            <ul className="space-y-2.5">
              {p.members.map((m) => (
                <li key={m.user_id} className="flex items-center gap-2.5 min-w-0">
                  <Avatar src={m.avatar_url} name={m.name} size={30} />
                  <div className="min-w-0">
                    <div className="text-sm text-ink truncate">{m.name}</div>
                    {m.role && <div className="text-xs text-muted truncate">{m.role}</div>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Dates">
          <dl className="space-y-2 text-sm">
            <Row label="Starts">{p.start_on ? new Date(`${p.start_on}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "Not set"}</Row>
            <Row label="Final delivery">{p.due_at ? <DueLabel due={p.due_at} done={p.status === "delivered" || p.status === "cancelled"} short /> : "Not set"}</Row>
            {p.delivered_at && <Row label="Delivered">{relativeTime(p.delivered_at)}</Row>}
            <Row label="Created">{relativeTime(p.created_at)}</Row>
          </dl>
        </Section>
      </div>

      {delivery && <DeliveryModal projectId={p.id} delivery={delivery === "new" ? null : delivery} members={p.members} onClose={() => setDelivery(null)} />}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="text-ink text-right min-w-0">{children}</dd>
    </div>
  );
}

// -------------------------------------------------------------------- files --
const isImage = (f: ProjectFile) => !!f.mime_type?.startsWith("image/");
const isVideo = (f: ProjectFile) => !!f.mime_type?.startsWith("video/");

function Files({ p }: { p: ProjectDetail }) {
  const { profile } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const picker = useRef<HTMLInputElement>(null);
  const [forDelivery, setForDelivery] = useState("");
  const [over, setOver] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["project", p.id] });
    void qc.invalidateQueries({ queryKey: ["projects"] });
  };

  const paths = useMemo(() => p.files.map((f) => f.storage_path).filter(Boolean) as string[], [p.files]);
  const urls = useQuery({
    queryKey: ["project-file-urls", p.id, paths],
    queryFn: () => signedUrls(paths),
    enabled: paths.length > 0,
    staleTime: 45 * 60_000,
    refetchInterval: 50 * 60_000,
  });

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      setProgress({ done: 0, total: files.length });
      await uploadProjectFiles(p.id, forDelivery || null, files, (done) => setProgress({ done, total: files.length }));
    },
    onSuccess: (_, files) => {
      refresh();
      toast.push({ kind: "success", title: files.length === 1 ? `${files[0].name} uploaded` : `${files.length} files uploaded` });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't upload", description: e.message }),
    onSettled: () => setProgress(null),
  });
  const update = useMutation({
    mutationFn: ({ f, delivered }: { f: ProjectFile; delivered: boolean }) => updateProjectFile(f.id, delivered, f.delivery_id),
    onSuccess: refresh,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't update it", description: e.message }),
  });
  const remove = useMutation({
    mutationFn: deleteProjectFile,
    onSuccess: refresh,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't delete it", description: e.message }),
  });

  const take = (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (!files.length || upload.isPending) return;
    const big = files.filter((f) => f.size > MAX_FILE);
    if (big.length) {
      toast.push({
        kind: "error",
        title: big.length === 1 ? `${big[0].name} is over 50 MB` : `${big.length} files are over 50 MB`,
        description: "Upload big videos to Drive (or WeTransfer) and add the link instead.",
      });
      const rest = files.filter((f) => f.size <= MAX_FILE);
      if (rest.length) upload.mutate(rest);
      return;
    }
    upload.mutate(files);
  };

  const sent = p.files.filter((f) => f.delivered);
  const work = p.files.filter((f) => !f.delivered);
  const row = (f: ProjectFile) => (
    <FileRow
      key={f.id}
      f={f}
      url={f.storage_path ? urls.data?.[f.storage_path] ?? null : f.external_url}
      admin={p.admin}
      mine={f.uploaded_by === profile?.id}
      onSent={(v) => update.mutate({ f, delivered: v })}
      onDelete={async () => {
        if (await confirm({ title: `Delete ${f.name}?`, confirmLabel: "Delete", danger: true })) remove.mutate(f.id);
      }}
    />
  );

  return (
    <div className="space-y-4">
      <div
        className={cn(
          "rounded-xl border-2 border-dashed bg-surface px-4 py-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between transition-colors",
          over ? "border-accent bg-accent/5" : "border-border",
        )}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          take(e.dataTransfer.files);
        }}
      >
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink">
            {progress ? `Uploading ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…` : "Upload your work"}
          </div>
          <div className="text-xs text-muted">Pictures, videos and files up to 50 MB each (drop them here). Bigger ones: add a link.</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {p.deliveries.length > 0 && (
            <Select
              value={forDelivery}
              onChange={setForDelivery}
              size="sm"
              className="w-44"
              aria-label="For which delivery"
              options={[{ value: "", label: "For: the project" }, ...p.deliveries.map((d) => ({ value: d.id, label: `For: ${d.title}` }))]}
            />
          )}
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              take(e.target.files);
              e.target.value = "";
            }}
          />
          <Button size="sm" iconLeft={<Link2 size={14} />} onClick={() => setLinkOpen(true)}>
            Add a link
          </Button>
          <Button size="sm" variant="primary" iconLeft={<Upload size={14} />} loading={upload.isPending} onClick={() => picker.current?.click()}>
            Upload
          </Button>
        </div>
      </div>

      {!p.files.length ? (
        <EmptyState icon={<FileIcon size={20} />} title="No files yet" description="The team's work and what's sent to the client show up here." />
      ) : (
        <>
          {sent.length > 0 && (
            <Section title={`Sent to the client (${sent.length})`}>
              <ul className="divide-y divide-line -mx-4">{sent.map(row)}</ul>
            </Section>
          )}
          {work.length > 0 && (
            <Section title={`Work (${work.length})`}>
              <ul className="divide-y divide-line -mx-4">{work.map(row)}</ul>
            </Section>
          )}
        </>
      )}

      {linkOpen && <LinkModal projectId={p.id} deliveries={p.deliveries} onClose={() => setLinkOpen(false)} />}
    </div>
  );
}

function FileRow({
  f,
  url,
  admin,
  mine,
  onSent,
  onDelete,
}: {
  f: ProjectFile;
  url: string | null;
  admin: boolean;
  mine: boolean;
  onSent: (v: boolean) => void;
  onDelete: () => void;
}) {
  const Icon = f.external_url ? Link2 : isImage(f) ? ImageIcon : isVideo(f) ? Film : f.mime_type === "application/pdf" ? FileText : FileIcon;
  const download = url && f.storage_path ? `${url}${url.includes("?") ? "&" : "?"}download=${encodeURIComponent(f.name)}` : null;
  return (
    <li className="px-4 py-2.5 flex items-center gap-3">
      <a
        href={url ?? undefined}
        target="_blank"
        rel="noopener noreferrer"
        className="h-12 w-12 shrink-0 rounded-lg bg-inset border border-line overflow-hidden grid place-items-center text-muted"
        aria-label={`Open ${f.name}`}
      >
        {url && isImage(f) ? <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" /> : <Icon size={18} />}
      </a>
      <div className="min-w-0 flex-1">
        <a href={url ?? undefined} target="_blank" rel="noopener noreferrer" className="block text-sm font-medium text-ink truncate hover:text-accent">
          {f.name}
        </a>
        <div className="text-xs text-muted truncate">
          {[f.external_url ? hostOf(f.external_url) : fileSize(f.size), f.uploader, relativeTime(f.created_at)].filter(Boolean).join(" · ")}
        </div>
        {f.delivery && <div className="text-xs text-subtle truncate">For {f.delivery}</div>}
      </div>
      {f.delivered && (
        <Badge tone="success" className="hidden sm:inline-flex">
          <CheckCircle2 size={11} /> Sent
        </Badge>
      )}
      <Menu
        align="right"
        trigger={
          <button type="button" aria-label={`Actions for ${f.name}`} className="h-9 w-9 shrink-0 grid place-items-center rounded-md text-subtle hover:text-ink hover:bg-inset">
            <MoreHorizontal size={16} />
          </button>
        }
      >
        {(close) => (
          <>
            {url && (
              <MenuItem onClick={() => (close(), window.open(url, "_blank", "noopener"))}>
                <span className="inline-flex items-center gap-2">
                  <ExternalLink size={14} /> Open
                </span>
              </MenuItem>
            )}
            {download && (
              <MenuItem onClick={() => (close(), (window.location.href = download))}>
                <span className="inline-flex items-center gap-2">
                  <Download size={14} /> Download
                </span>
              </MenuItem>
            )}
            {admin && (
              <MenuItem onClick={() => (close(), onSent(!f.delivered))}>
                <span className="inline-flex items-center gap-2">
                  <CheckCircle2 size={14} /> {f.delivered ? "Not sent to the client" : "Sent to the client"}
                </span>
              </MenuItem>
            )}
            {(admin || mine) && (
              <>
                <MenuDivider />
                <MenuItem destructive onClick={() => (close(), onDelete())}>
                  <span className="inline-flex items-center gap-2">
                    <Trash2 size={14} /> Delete
                  </span>
                </MenuItem>
              </>
            )}
          </>
        )}
      </Menu>
    </li>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Link";
  }
};

// -------------------------------------------------------- client and money --
function Money({ p }: { p: ProjectDetail }) {
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [invoice, setInvoice] = useState<ProjectInvoice | null | "new">(null);
  const [clientOpen, setClientOpen] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["project", p.id] });
    void qc.invalidateQueries({ queryKey: ["projects"] });
  };
  const paths = useMemo(() => p.invoices.map((i) => i.storage_path).filter(Boolean) as string[], [p.invoices]);
  const urls = useQuery({ queryKey: ["project-invoice-urls", p.id, paths], queryFn: () => signedUrls(paths), enabled: paths.length > 0, staleTime: 45 * 60_000 });

  const markPaid = useMutation({
    mutationFn: (i: ProjectInvoice) =>
      saveProjectInvoice(
        p.id,
        i,
        {
          number: i.number ?? "",
          amount: i.amount,
          currency: i.currency,
          issued_on: i.issued_on,
          due_on: i.due_on,
          paid_on: i.paid_on ? null : new Date().toISOString().slice(0, 10),
          note: i.note ?? "",
        },
        null,
      ),
    onSuccess: refresh,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't update the invoice", description: e.message }),
  });
  const remove = useMutation({
    mutationFn: deleteProjectInvoice,
    onSuccess: refresh,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't delete the invoice", description: e.message }),
  });

  const c = p.client;
  const cur = p.currency ?? "USD";
  const other = p.invoices.filter((i) => i.currency !== cur);
  const left = p.cost != null ? Math.max(0, p.cost - (p.paid ?? 0)) : null;

  return (
    <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)] items-start">
      <Section
        title="Client"
        action={
          c?.id && (
            <Button size="sm" variant="ghost" iconLeft={<Pencil size={14} />} onClick={() => setClientOpen(true)}>
              Edit
            </Button>
          )
        }
      >
        {!c ? (
          <p className="text-sm text-subtle">No client. Edit the project to pick one.</p>
        ) : (
          <div className="space-y-3 text-sm">
            <div>
              <div className="font-medium text-ink">{c.name}</div>
              {c.company && <div className="text-muted">{c.company}</div>}
            </div>
            {c.email && (
              <a href={`mailto:${c.email}`} className="flex items-center gap-2 text-ink hover:text-accent min-w-0">
                <Mail size={14} className="shrink-0 text-muted" /> <span className="truncate">{c.email}</span>
              </a>
            )}
            {c.phone && (
              <div className="flex flex-wrap items-center gap-2">
                <a href={`tel:${c.phone.replace(/\s+/g, "")}`} className="inline-flex items-center gap-2 text-ink hover:text-accent">
                  <Phone size={14} className="text-muted" /> {c.phone}
                </a>
                <a
                  href={whatsappLink(c.phone)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs text-muted hover:text-ink hover:bg-inset"
                >
                  <MessageCircle size={12} /> WhatsApp
                </a>
              </div>
            )}
            {c.notes && <p className="text-muted whitespace-pre-wrap break-words border-t border-line pt-3">{c.notes}</p>}
          </div>
        )}
      </Section>

      <div className="space-y-4 min-w-0">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Tile label="Cost" value={p.cost != null ? money(p.cost, cur) : "Not set"} />
          <Tile label="Invoiced" value={money(p.invoiced ?? 0, cur)} />
          <Tile label="Paid" value={money(p.paid ?? 0, cur)} tone="success" />
          <Tile label="Left to pay" value={left != null ? money(left, cur) : "No cost set"} tone={left ? "warn" : undefined} />
        </div>
        {other.length > 0 && (
          <p className="text-xs text-muted inline-flex items-center gap-1.5">
            <AlertTriangle size={12} className="text-warn" /> {other.length} {other.length === 1 ? "invoice is" : "invoices are"} in another currency and left out of
            the totals.
          </p>
        )}

        <Section
          title="Invoices"
          action={
            <Button size="sm" variant="ghost" iconLeft={<Plus size={14} />} onClick={() => setInvoice("new")}>
              Add
            </Button>
          }
        >
          {!p.invoices.length ? (
            <p className="text-sm text-subtle">No invoices yet. Add each invoice you send the client and mark it paid when it is.</p>
          ) : (
            <ul className="divide-y divide-line -mx-4">
              {p.invoices.map((i) => {
                const state = invoiceState(i);
                const url = i.storage_path ? urls.data?.[i.storage_path] ?? null : null;
                return (
                  <li key={i.id} className="px-4 py-2.5 flex items-center gap-3">
                    <span className="h-9 w-9 shrink-0 grid place-items-center rounded-lg bg-inset text-muted">
                      <Receipt size={16} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-ink">{i.number ? `No. ${i.number}` : "Invoice"}</span>
                        <Badge tone={state === "paid" ? "success" : state === "late" ? "danger" : "warn"}>
                          {state === "paid" ? "Paid" : state === "late" ? "Late" : "Unpaid"}
                        </Badge>
                      </div>
                      <div className="text-xs text-muted truncate">
                        {[
                          i.issued_on && `Sent ${shortDay(i.issued_on)}`,
                          i.paid_on ? `paid ${shortDay(i.paid_on)}` : i.due_on && `pay by ${shortDay(i.due_on)}`,
                          i.note,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </div>
                    <span className="text-sm font-semibold text-ink tabular-nums shrink-0">{money(i.amount, i.currency)}</span>
                    <Menu
                      align="right"
                      trigger={
                        <button type="button" aria-label="Invoice actions" className="h-9 w-9 shrink-0 grid place-items-center rounded-md text-subtle hover:text-ink hover:bg-inset">
                          <MoreHorizontal size={16} />
                        </button>
                      }
                    >
                      {(close) => (
                        <>
                          {url && (
                            <MenuItem onClick={() => (close(), window.open(url, "_blank", "noopener"))}>
                              <span className="inline-flex items-center gap-2">
                                <FileText size={14} /> Open the file
                              </span>
                            </MenuItem>
                          )}
                          <MenuItem onClick={() => (close(), markPaid.mutate(i))}>
                            <span className="inline-flex items-center gap-2">
                              <CheckCircle2 size={14} /> {i.paid_on ? "Mark unpaid" : "Mark paid today"}
                            </span>
                          </MenuItem>
                          <MenuItem onClick={() => (close(), setInvoice(i))}>
                            <span className="inline-flex items-center gap-2">
                              <Pencil size={14} /> Edit
                            </span>
                          </MenuItem>
                          <MenuDivider />
                          <MenuItem
                            destructive
                            onClick={async () => {
                              close();
                              if (await confirm({ title: "Delete this invoice?", confirmLabel: "Delete", danger: true })) remove.mutate(i.id);
                            }}
                          >
                            <span className="inline-flex items-center gap-2">
                              <Trash2 size={14} /> Delete
                            </span>
                          </MenuItem>
                        </>
                      )}
                    </Menu>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      </div>

      {invoice && <InvoiceModal projectId={p.id} invoice={invoice === "new" ? null : invoice} currency={cur} onClose={() => setInvoice(null)} />}
      {clientOpen && c?.id && <ClientModal client={c as Client} onClose={() => setClientOpen(false)} />}
    </div>
  );
}

const shortDay = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

function Tile({ label, value, tone }: { label: string; value: string; tone?: "success" | "warn" }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 shadow-card min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-subtle">{label}</div>
      <div className={cn("text-base font-semibold tabular-nums truncate", tone === "success" ? "text-success" : tone === "warn" ? "text-warn" : "text-ink")}>
        {value}
      </div>
    </div>
  );
}
