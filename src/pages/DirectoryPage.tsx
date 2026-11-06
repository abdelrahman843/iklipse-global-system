import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Archive, ArchiveRestore, BookUser, Download, Plus, Trash2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { Segmented, Toggle } from "@/components/ui/Controls";
import { EmptyState } from "@/components/ui/EmptyState";
import { Hint, Input, Label, Textarea } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { PageTitle, plural } from "@/components/ui/PageTitle";
import { Pager, usePaged } from "@/components/ui/Pager";
import { SearchField } from "@/components/ui/SearchField";
import { PageSpinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useAuth } from "@/lib/auth";
import { LIVE_FALLBACK } from "@/lib/live";
import {
  KINDS,
  archiveRecord,
  deleteRecord,
  fetchDirectory,
  fetchDupes,
  fetchHistory,
  fetchPlaces,
  kindLabel,
  mergeRecords,
  nameLike,
  rowsOf,
  saveRecord,
  tableOf,
  toCsv,
  type Entry,
  type Fields,
  type ListRows,
  type Match,
} from "@/lib/directoryApi";

// -----------------------------------------------------------------------------
// Directory: everyone iklipse deals with, one record each, the team, clients,
// freelancers, partners, vendors and contacts. Anyone on the team searches it;
// admins add, change, archive, merge, import and export. A record gives nobody
// any access: that stays on the Users page and in Alerts > Brain > Permissions.
// Changes from WhatsApp show here at once.
// -----------------------------------------------------------------------------

type Filter = "all" | "staff" | "client" | "freelancer" | "partner" | "vendor" | "contact";

const TEXT_FIELDS: { key: keyof Entry & string; label: string }[] = [
  { key: "company", label: "Company" },
  { key: "department", label: "Department" },
  { key: "role_title", label: "Role" },
  { key: "team", label: "Team" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone / WhatsApp" },
  { key: "language", label: "Language" },
];

const blank = (kind: string): Entry => ({
  ref: "",
  kind,
  name: "",
  company: null,
  department: null,
  role_title: null,
  team: null,
  is_manager: false,
  responsibilities: null,
  email: null,
  phone: null,
  language: null,
  notes: null,
  status: "active",
});

const haystack = (r: Entry) => [r.name, r.company, r.department, r.role_title, r.team, r.responsibilities, r.email, r.phone, r.language, r.notes].filter(Boolean).join(" ").toLowerCase();

function download(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function DirectoryPage() {
  const { profile } = useAuth();
  const admin = profile?.role === "admin";
  const qc = useQueryClient();
  const { data: rows = [], isLoading } = useQuery({ queryKey: ["directory"], queryFn: fetchDirectory, refetchInterval: LIVE_FALLBACK });
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [archived, setArchived] = useState(false);
  const [open, setOpen] = useState<Entry | null>(null);
  const [importing, setImporting] = useState<ListRows | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const shown = useMemo(() => {
    const need = q.toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter((r) => {
      if (!archived && r.status !== "active") return false;
      if (filter !== "all" && r.kind !== filter) return false;
      const text = haystack(r);
      return need.every((n) => text.includes(n));
    });
  }, [rows, q, filter, archived]);
  const paged = usePaged(shown, "directory");

  const fresh = () => qc.invalidateQueries({ queryKey: ["directory"] });

  const readList = async (f: File) => {
    try {
      setImporting(rowsOf(tableOf(await f.text())));
    } catch (e) {
      toast.push({ kind: "error", title: "Couldn't read that list", description: (e as Error).message });
    }
  };

  if (isLoading) return <PageSpinner />;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageTitle count={plural(shown.length, "person", "people")} info="Everyone iklipse deals with, one record each. A record gives nobody any access.">
          Directory
        </PageTitle>
        {admin && (
          <div className="flex flex-wrap gap-2">
            <input ref={file} type="file" accept=".csv,text/csv,text/plain" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void readList(f); }} />
            <Button iconLeft={<Upload size={14} />} onClick={() => file.current?.click()}>Import CSV</Button>
            <Button iconLeft={<Download size={14} />} onClick={() => download(`directory-${format(new Date(), "yyyy-MM-dd")}.csv`, toCsv(shown))}>Export</Button>
            <Button variant="primary" iconLeft={<Plus size={14} />} onClick={() => setOpen(blank("contact"))}>New record</Button>
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <SearchField value={q} onChange={setQ} placeholder="Name, role, company, number..." className="min-w-56 flex-1" hotkey />
        <Segmented<Filter> value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, ...(KINDS as { value: Filter; label: string }[])]} />
        <Toggle checked={archived} onChange={setArchived} label="Archived too" />
      </div>

      {!shown.length ? (
        <div className="mt-8"><EmptyState icon={<BookUser size={20} />} title="Nobody fits" description={q ? "Try other words." : undefined} /></div>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-left text-sm">
            <thead className="bg-inset text-xs text-muted">
              <tr>
                {["Name", "Type", "Role", "Company", "Phone", "Email"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {paged.rows.map((r) => (
                <tr key={r.ref} className="cursor-pointer border-t border-line hover:bg-inset" onClick={() => setOpen(r)}>
                  <td className="px-3 py-2 font-medium">
                    {r.name}
                    {r.is_manager && <Badge tone="accent" className="ml-2">Manager</Badge>}
                    {r.status !== "active" && <Badge className="ml-2">{r.status === "left" ? "Left" : "Archived"}</Badge>}
                  </td>
                  <td className="px-3 py-2 text-muted">{kindLabel(r.kind)}</td>
                  <td className="px-3 py-2">{[r.role_title, r.department].filter(Boolean).join(", ")}</td>
                  <td className="px-3 py-2">{r.company}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{r.phone ? `+${r.phone}` : ""}</td>
                  <td className="px-3 py-2">{r.email}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager {...paged.pager} className="mt-3" />

      {open && <RecordModal entry={open} admin={admin} onClose={() => setOpen(null)} onChanged={fresh} />}
      {importing && <ImportModal list={importing} onClose={() => setImporting(null)} onChanged={fresh} />}
    </div>
  );
}

function RecordModal({ entry, admin, onClose, onChanged }: { entry: Entry; admin: boolean; onClose: () => void; onChanged: () => void }) {
  const isNew = !entry.ref;
  const staff = entry.kind === "staff";
  const part = entry.ref.split(":")[0];
  const [v, setV] = useState<Entry>(entry);
  const [busy, setBusy] = useState(false);
  const [dupes, setDupes] = useState<Match[] | null>(null);
  const toast = useToast();
  const confirm = useConfirm();
  const places = useQuery({ queryKey: ["directory-places", entry.ref], queryFn: () => fetchPlaces(entry.ref), enabled: admin && !isNew });
  const history = useQuery({ queryKey: ["directory-history", entry.ref], queryFn: () => fetchHistory(entry.ref), enabled: admin && !isNew });

  const set = (k: keyof Entry) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));

  const changes = (): Fields => {
    const f: Fields = {};
    const keys = ["name", "company", "department", "role_title", "team", "responsibilities", "email", "phone", "language", "notes"] as const;
    for (const k of keys) if ((v[k] ?? "") !== (entry[k] ?? "")) f[k] = v[k] ?? null;
    if (v.is_manager !== entry.is_manager) f.is_manager = v.is_manager;
    if (isNew || v.kind !== entry.kind) f.kind = v.kind;
    return f;
  };

  const fail = (e: unknown) => toast.push({ kind: "error", title: "Not saved", description: (e as Error).message });

  const save = async (force = false) => {
    setBusy(true);
    try {
      const r = await saveRecord(isNew ? null : entry.ref, changes(), force);
      if (r.status === "duplicates") setDupes(r.matches);
      else {
        toast.push({ kind: "success", title: isNew ? "Added" : "Saved" });
        onChanged();
        onClose();
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const merge = async (keep: Match) => {
    if (!(await confirm({ title: `Merge into ${keep.name}?`, message: `${entry.name} folds into ${keep.name}. What doesn't fit goes in the notes.`, confirmLabel: "Merge", danger: true }))) return;
    try {
      await mergeRecords(keep.ref, entry.ref);
      onChanged();
      onClose();
    } catch (e) {
      fail(e);
    }
  };

  const archive = async () => {
    try {
      await archiveRecord(entry.ref, entry.status === "active");
      onChanged();
      onClose();
    } catch (e) {
      fail(e);
    }
  };

  const remove = async () => {
    if (!(await confirm({ title: `Delete ${entry.name}?`, message: "Their record goes. Its history stays.", confirmLabel: "Delete", danger: true }))) return;
    try {
      await deleteRecord(entry.ref);
      onChanged();
      onClose();
    } catch (e) {
      fail(e);
    }
  };

  const findTwins = async () => {
    try {
      const m = await fetchDupes({ name: entry.name, email: entry.email, phone: entry.phone });
      setDupes(m.filter((x) => x.ref !== entry.ref));
    } catch (e) {
      fail(e);
    }
  };

  const locked = !admin;
  const baseLocked = locked || staff;

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={isNew ? "New record" : entry.name}
      footer={
        admin ? (
          <div className="flex w-full flex-wrap items-center gap-2">
            {!isNew && !staff && <Button iconLeft={entry.status === "active" ? <Archive size={14} /> : <ArchiveRestore size={14} />} onClick={archive}>{entry.status === "active" ? "Archive" : "Restore"}</Button>}
            {!isNew && part === "card" && <Button iconLeft={<Trash2 size={14} />} onClick={remove}>Delete</Button>}
            {!isNew && part === "card" && <Button onClick={findTwins}>Find duplicates</Button>}
            <span className="flex-1" />
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={busy || !v.name.trim() || (!isNew && !Object.keys(changes()).length)} onClick={() => void save()}>Save</Button>
          </div>
        ) : undefined
      }
    >
      <div className="space-y-3">
        {dupes && (
          <div className="rounded-md border border-warn/25 bg-warn/10 p-3 text-sm">
            {dupes.length ? (
              <>
                <p className="font-medium">Probably already here:</p>
                <ul className="mt-1 space-y-1">
                  {dupes.map((m) => (
                    <li key={m.ref} className="flex flex-wrap items-center gap-2">
                      <span>{m.name} ({kindLabel(m.kind)}, {m.why})</span>
                      {!isNew && part === "card" && <Button size="sm" onClick={() => void merge(m)}>Merge into this</Button>}
                    </li>
                  ))}
                </ul>
                <Button size="sm" className="mt-2" onClick={() => void save(true)}>{isNew ? "It's someone else: add anyway" : "It's someone else: save anyway"}</Button>
              </>
            ) : (
              <p>No duplicates found.</p>
            )}
          </div>
        )}
        {isNew && (
          <div>
            <Label>Type</Label>
            <Segmented value={v.kind} onChange={(kind) => setV((x) => ({ ...x, kind }))} options={KINDS.filter((k) => k.value !== "staff")} />
            <Hint>Someone on the team gets their account on the Users page.</Hint>
          </div>
        )}
        <div>
          <Label htmlFor="dir-name">Name</Label>
          <Input id="dir-name" value={v.name} onChange={set("name")} disabled={baseLocked} autoFocus={isNew} maxLength={200} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {TEXT_FIELDS.map((f) => (
            <div key={f.key}>
              <Label htmlFor={`dir-${f.key}`}>{f.label}</Label>
              <Input id={`dir-${f.key}`} value={String(v[f.key] ?? "")} onChange={set(f.key)} disabled={locked || (staff && (f.key === "email" || f.key === "phone"))} />
            </div>
          ))}
        </div>
        {staff && admin && <Hint>A team member's name, number and email are changed on the Users page.</Hint>}
        <Toggle checked={v.is_manager} onChange={(is_manager) => setV((x) => ({ ...x, is_manager }))} label="Manager" disabled={locked} />
        <div>
          <Label htmlFor="dir-resp">Responsibilities</Label>
          <Textarea id="dir-resp" value={v.responsibilities ?? ""} onChange={set("responsibilities")} rows={2} disabled={locked} />
        </div>
        {admin && (
          <div>
            <Label htmlFor="dir-notes">Notes</Label>
            <Textarea id="dir-notes" value={v.notes ?? ""} onChange={set("notes")} rows={2} />
          </div>
        )}
        {admin && !isNew && (
          <>
            <div className="text-sm"><span className="text-muted">Access: </span>{entry.access}</div>
            {places.data && (
              <div className="grid gap-1 text-sm sm:grid-cols-2">
                {([["Projects", places.data.projects], ["Client accounts", places.data.clients], ["WhatsApp groups", places.data.groups], ["Slack channels", places.data.slack]] as const).map(([label, list]) => (
                  <div key={label}><span className="text-muted">{label}: </span>{list.length ? list.join(", ") : "none"}</div>
                ))}
              </div>
            )}
            {!!history.data?.length && (
              <details className="text-sm">
                <summary className="cursor-pointer text-muted">History ({history.data.length})</summary>
                <ul className="mt-2 space-y-1">
                  {history.data.map((h) => (
                    <li key={h.at + h.action}>
                      <span className="text-muted">{format(new Date(h.at), "d MMM yyyy, HH:mm")}</span> {h.action} by {h.actor_name ?? "someone"} ({h.via})
                      {h.action === "change" && h.changes ? `: ${Object.keys(h.changes).join(", ")}` : ""}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function ImportModal({ list, onClose, onChanged }: { list: ListRows; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const plan = useQuery({
    queryKey: ["directory-import", list],
    queryFn: async () => {
      const fresh: Fields[] = [];
      const known: { name: string; match: Match }[] = [];
      for (const f of list.rows) {
        const m = await fetchDupes(f);
        const twin = fresh.find((o) => nameLike(String(o.name), String(f.name)) || (f.phone && String(o.phone ?? "").slice(-9) === String(f.phone).slice(-9)) || (f.email && String(o.email ?? "").toLowerCase() === String(f.email).toLowerCase()));
        if (m.length) known.push({ name: String(f.name), match: m[0]! });
        else if (twin) known.push({ name: String(f.name), match: { ref: "", kind: "contact", name: String(twin.name), company: null, email: null, phone: null, status: "active", why: "too like it, in this list" } });
        else fresh.push(f);
      }
      return { fresh, known };
    },
  });

  const add = async () => {
    setBusy(true);
    let added = 0;
    const failed: string[] = [];
    for (const f of plan.data?.fresh ?? []) {
      try {
        const r = await saveRecord(null, f);
        if (r.status === "added") added += 1;
        else failed.push(`${f.name}: probably already here`);
      } catch (e) {
        failed.push(`${f.name}: ${(e as Error).message}`);
      }
    }
    setBusy(false);
    toast.push({ kind: failed.length ? "error" : "success", title: `Added ${added}`, description: failed.join("; ") || undefined });
    onChanged();
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Import a list"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !plan.data?.fresh.length} onClick={() => void add()}>
            {plan.data ? `Add ${plan.data.fresh.length} new` : "Checking..."}
          </Button>
        </>
      }
    >
      {plan.isLoading ? (
        <PageSpinner />
      ) : (
        <div className="space-y-2 text-sm">
          <p>{plan.data?.fresh.length ?? 0} new. Nobody gets any access by this.</p>
          {!!plan.data?.known.length && (
            <div>
              <p className="font-medium">Probably already here, left alone:</p>
              <ul className="list-disc pl-5">
                {plan.data.known.map((k) => <li key={k.name}>{k.name}: {k.match.name} ({k.match.why})</li>)}
              </ul>
            </div>
          )}
          {!!list.bad.length && (
            <div>
              <p className="font-medium">Can't use:</p>
              <ul className="list-disc pl-5">{list.bad.map((b) => <li key={b}>{b}</li>)}</ul>
            </div>
          )}
          {!!list.ignored.length && <p className="text-muted">Columns left out: {list.ignored.join(", ")}.</p>}
        </div>
      )}
    </Modal>
  );
}
