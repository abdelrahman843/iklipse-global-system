import { useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText, Plus, Upload, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Label, Hint, Textarea } from "@/components/ui/Input";
import { DateField } from "@/components/ui/DateField";
import { Select } from "@/components/ui/Select";
import { Segmented, Toggle } from "@/components/ui/Controls";
import { Avatar } from "@/components/ui/Avatar";
import { useToast } from "@/components/ui/Toast";
import {
  PRIORITIES,
  STATUSES,
  addProjectLink,
  fromLocalInput,
  saveClient,
  saveDelivery,
  saveProject,
  saveProjectInvoice,
  setProjectMembers,
  toLocalInput,
  type Client,
  type ClientInput,
  type Delivery,
  type Person,
  type ProjectDetail,
  type ProjectInvoice,
  type ProjectMember,
  type ProjectPriority,
  type ProjectStatus,
} from "@/lib/projectsApi";

// -----------------------------------------------------------------------------
// The forms of the Projects pages (admins, apart from adding a link). Each is
// mounted only while open, so it starts from what's saved.
// -----------------------------------------------------------------------------

const CURRENCIES = ["USD", "EUR", "GBP", "EGP", "SAR", "AED"];
const currencyOptions = (current: string) =>
  [...new Set([...CURRENCIES, current].filter(Boolean))].map((c) => ({ value: c, label: c }));

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["projects"] });
    void qc.invalidateQueries({ queryKey: ["project"] });
    void qc.invalidateQueries({ queryKey: ["projects-count"] });
  };
}

function Footer({ onClose, busy, disabled, label, onSave }: { onClose: () => void; busy: boolean; disabled?: boolean; label: string; onSave: () => void }) {
  return (
    <>
      <Button variant="secondary" onClick={onClose} disabled={busy}>
        Cancel
      </Button>
      <Button variant="primary" loading={busy} disabled={disabled} onClick={onSave}>
        {label}
      </Button>
    </>
  );
}

// ------------------------------------------------------------------- client --
export function ClientModal({ client, onClose, onSaved }: { client: Client | null; onClose: () => void; onSaved?: (c: Client) => void }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [v, setV] = useState<ClientInput>({
    name: client?.name ?? "",
    company: client?.company ?? "",
    email: client?.email ?? "",
    phone: client?.phone ?? "",
    notes: client?.notes ?? "",
  });
  const set = (k: keyof ClientInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });
  const emailBad = !!v.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim());
  const save = useMutation({
    mutationFn: () => saveClient(client?.id ?? null, v),
    onSuccess: (id) => {
      invalidate();
      onSaved?.({
        id,
        name: v.name.trim(),
        company: v.company.trim() || null,
        email: v.email.trim() || null,
        phone: v.phone.trim() || null,
        notes: v.notes.trim() || null,
        created_at: client?.created_at ?? new Date().toISOString(),
      });
      onClose();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't save the client", description: e.message }),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={client ? `Edit ${client.name}` : "New client"}
      footer={<Footer onClose={onClose} busy={save.isPending} disabled={!v.name.trim() || emailBad} label="Save" onSave={() => save.mutate()} />}
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="cl-name">Name</Label>
          <Input id="cl-name" value={v.name} onChange={set("name")} autoFocus maxLength={200} />
        </div>
        <div>
          <Label htmlFor="cl-company">Company</Label>
          <Input id="cl-company" value={v.company} onChange={set("company")} maxLength={200} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="cl-email">Email</Label>
            <Input id="cl-email" type="email" value={v.email} onChange={set("email")} aria-invalid={emailBad} />
            {emailBad && <Hint>That doesn't look like an email.</Hint>}
          </div>
          <div>
            <Label htmlFor="cl-phone">Phone</Label>
            <Input id="cl-phone" type="tel" value={v.phone} onChange={set("phone")} placeholder="+20 100 000 0000" />
          </div>
        </div>
        <div>
          <Label htmlFor="cl-notes">Notes</Label>
          <Textarea id="cl-notes" value={v.notes} onChange={set("notes")} rows={3} placeholder="Anything to remember about them" />
        </div>
      </div>
    </Modal>
  );
}

// --------------------------------------------------------------------- team --
export interface TeamRow {
  user_id: string;
  role: string;
}

/** The people on a project and what each one does there. */
export function TeamPicker({ people, value, onChange }: { people: Person[]; value: TeamRow[]; onChange: (v: TeamRow[]) => void }) {
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const left = people.filter((p) => !value.some((r) => r.user_id === p.id));
  return (
    <div className="space-y-2">
      {value.map((r, i) => {
        const p = byId.get(r.user_id);
        return (
          <div key={r.user_id} className="flex items-center gap-2">
            <Avatar src={p?.avatar_url} name={p?.name ?? "?"} size={28} />
            <span className="min-w-0 flex-1 truncate text-sm text-ink">{p?.name ?? "Someone"}</span>
            <Input
              aria-label={`What ${p?.name ?? "they"} does`}
              value={r.role}
              placeholder="Role (Designer…)"
              maxLength={80}
              onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))}
              className="w-36 sm:w-44"
            />
            <button
              type="button"
              aria-label={`Take ${p?.name ?? "them"} off`}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
              className="h-9 w-9 shrink-0 grid place-items-center rounded-md text-subtle hover:text-danger hover:bg-inset"
            >
              <X size={15} />
            </button>
          </div>
        );
      })}
      {left.length > 0 && (
        <Select
          value=""
          placeholder="Add someone…"
          searchable
          onChange={(id) => onChange([...value, { user_id: id, role: "" }])}
          options={left.map((p) => ({ value: p.id, label: p.name, icon: <Avatar src={p.avatar_url} name={p.name} size={20} /> }))}
          aria-label="Add someone to the team"
        />
      )}
    </div>
  );
}

export function TeamModal({ project, people, onClose }: { project: ProjectDetail; people: Person[]; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [team, setTeam] = useState<TeamRow[]>(project.members.map((m) => ({ user_id: m.user_id, role: m.role ?? "" })));
  const save = useMutation({
    mutationFn: () => setProjectMembers(project.id, team.map((t) => ({ user_id: t.user_id, role: t.role.trim() || null }))),
    onSuccess: () => {
      invalidate();
      onClose();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't save the team", description: e.message }),
  });
  return (
    <Modal open onClose={onClose} title="The team" footer={<Footer onClose={onClose} busy={save.isPending} label="Save" onSave={() => save.mutate()} />}>
      <p className="text-sm text-muted mb-4">
        They see this project (not its money, invoices or the client's contacts), upload their work and hear about its dates. New people get a notification.
      </p>
      <TeamPicker people={people} value={team} onChange={setTeam} />
    </Modal>
  );
}

// ------------------------------------------------------------------ project --
export function ProjectModal({
  project,
  clients,
  people,
  onClose,
  onSaved,
}: {
  project: ProjectDetail | null;
  clients: Client[];
  people: Person[];
  onClose: () => void;
  onSaved?: (id: string) => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [title, setTitle] = useState(project?.title ?? "");
  const [clientId, setClientId] = useState<string>(project?.client_id ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [priority, setPriority] = useState<ProjectPriority>(project?.priority ?? "medium");
  const [status, setStatus] = useState<ProjectStatus>(project?.status ?? "active");
  const [startOn, setStartOn] = useState(project?.start_on ?? "");
  const [dueAt, setDueAt] = useState(toLocalInput(project?.due_at ?? null));
  const [cost, setCost] = useState(project?.cost != null ? String(project.cost) : "");
  const [currency, setCurrency] = useState(project?.currency ?? "USD");
  const [team, setTeam] = useState<TeamRow[]>([]);
  const [extra, setExtra] = useState<Client[]>([]);
  const [newClient, setNewClient] = useState(false);

  const allClients = [...clients, ...extra.filter((e) => !clients.some((c) => c.id === e.id))];
  const costBad = cost.trim() !== "" && !(Number(cost) >= 0);

  const save = useMutation({
    mutationFn: async () => {
      const id = await saveProject(project?.id ?? null, {
        client_id: clientId || null,
        title: title.trim(),
        description,
        status,
        priority,
        start_on: startOn || null,
        due_at: fromLocalInput(dueAt),
        cost: cost.trim() === "" ? null : Number(cost),
        currency,
      });
      if (!project && team.length) await setProjectMembers(id, team.map((t) => ({ user_id: t.user_id, role: t.role.trim() || null })));
      return id;
    },
    onSuccess: (id) => {
      invalidate();
      onSaved?.(id);
      onClose();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't save the project", description: e.message }),
  });

  return (
    <>
      <Modal
        open
        onClose={onClose}
        size="lg"
        title={project ? "Edit project" : "New project"}
        footer={
          <Footer
            onClose={onClose}
            busy={save.isPending}
            disabled={!title.trim() || costBad}
            label={project ? "Save" : "Create project"}
            onSave={() => save.mutate()}
          />
        }
      >
        <div className="space-y-5">
          <div>
            <Label htmlFor="pr-title">Project name</Label>
            <Input id="pr-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus maxLength={200} placeholder="Brand identity for…" />
          </div>
          <div>
            <Label>Client</Label>
            <div className="flex gap-2">
              <Select
                className="flex-1"
                value={clientId}
                onChange={setClientId}
                searchable
                aria-label="Client"
                options={[
                  { value: "", label: "No client" },
                  ...allClients.map((c) => ({ value: c.id, label: c.company ? `${c.name} · ${c.company}` : c.name })),
                ]}
              />
              <Button iconLeft={<Plus size={14} />} onClick={() => setNewClient(true)}>
                New
              </Button>
            </div>
          </div>
          <div>
            <Label htmlFor="pr-desc">What it is</Label>
            <Textarea id="pr-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={4} placeholder="The brief, what's included, links…" />
            <Hint>The whole team sees this.</Hint>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>How important</Label>
              <Segmented value={priority} onChange={setPriority} options={PRIORITIES} />
            </div>
            <div>
              <Label>Status</Label>
              <Select value={status} onChange={(v) => setStatus(v as ProjectStatus)} options={STATUSES} aria-label="Status" className="w-full" />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="pr-start">Starts</Label>
              <DateField id="pr-start" value={startOn} onChange={setStartOn} />
            </div>
            <div>
              <Label htmlFor="pr-due">Final delivery</Label>
              <DateField id="pr-due" withTime value={dueAt} onChange={setDueAt} />
            </div>
          </div>
          <div>
            <Label htmlFor="pr-cost">Cost</Label>
            <div className="flex gap-2">
              <Input
                id="pr-cost"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
                aria-invalid={costBad}
                className="flex-1"
              />
              <Select value={currency} onChange={setCurrency} options={currencyOptions(currency)} className="w-28" aria-label="Currency" />
            </div>
            <Hint>Only admins see the cost and the invoices.</Hint>
          </div>
          {!project && (
            <div>
              <Label>The team</Label>
              <TeamPicker people={people} value={team} onChange={setTeam} />
            </div>
          )}
        </div>
      </Modal>
      {newClient && (
        <ClientModal
          client={null}
          onClose={() => setNewClient(false)}
          onSaved={(c) => {
            setExtra((x) => [...x, c]);
            setClientId(c.id);
          }}
        />
      )}
    </>
  );
}

// ----------------------------------------------------------------- delivery --
export function DeliveryModal({
  projectId,
  delivery,
  members,
  onClose,
}: {
  projectId: string;
  delivery: Delivery | null;
  members: ProjectMember[];
  onClose: () => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [title, setTitle] = useState(delivery?.title ?? "");
  const [due, setDue] = useState(toLocalInput(delivery?.due_at ?? null));
  const [assignee, setAssignee] = useState(delivery?.assignee_id ?? "");
  const save = useMutation({
    mutationFn: () => saveDelivery(delivery?.id ?? null, projectId, title.trim(), fromLocalInput(due)!, assignee || null),
    onSuccess: () => {
      invalidate();
      onClose();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't save the delivery", description: e.message }),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={delivery ? "Edit delivery" : "New delivery"}
      footer={<Footer onClose={onClose} busy={save.isPending} disabled={!title.trim() || !due} label="Save" onSave={() => save.mutate()} />}
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="dl-title">What's delivered</Label>
          <Input id="dl-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus maxLength={200} placeholder="First logo concepts" />
        </div>
        <div>
          <Label htmlFor="dl-due">When</Label>
          <DateField id="dl-due" withTime clearable={false} value={due} onChange={setDue} />
          <Hint>The team hears about it two days before, and if it's late.</Hint>
        </div>
        <div>
          <Label>Who's on it</Label>
          <Select
            className="w-full"
            value={assignee}
            onChange={setAssignee}
            aria-label="Who's on it"
            options={[
              { value: "", label: "The whole team" },
              ...members.map((m) => ({ value: m.user_id, label: m.name, icon: <Avatar src={m.avatar_url} name={m.name} size={20} /> })),
            ]}
          />
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ invoice --
export function InvoiceModal({
  projectId,
  invoice,
  currency,
  onClose,
}: {
  projectId: string;
  invoice: ProjectInvoice | null;
  currency: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const picker = useRef<HTMLInputElement>(null);
  const today = new Date().toISOString().slice(0, 10);
  const [number, setNumber] = useState(invoice?.number ?? "");
  const [amount, setAmount] = useState(invoice ? String(invoice.amount) : "");
  const [cur, setCur] = useState(invoice?.currency ?? currency);
  const [issued, setIssued] = useState(invoice?.issued_on ?? today);
  const [dueOn, setDueOn] = useState(invoice?.due_on ?? "");
  const [paid, setPaid] = useState(!!invoice?.paid_on);
  const [paidOn, setPaidOn] = useState(invoice?.paid_on ?? today);
  const [note, setNote] = useState(invoice?.note ?? "");
  const [file, setFile] = useState<File | null>(null);
  const amountBad = amount.trim() === "" || !(Number(amount) >= 0);
  const save = useMutation({
    mutationFn: () =>
      saveProjectInvoice(
        projectId,
        invoice,
        {
          number,
          amount: Number(amount),
          currency: cur,
          issued_on: issued || null,
          due_on: dueOn || null,
          paid_on: paid ? paidOn || today : null,
          note,
        },
        file,
      ),
    onSuccess: () => {
      invalidate();
      onClose();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't save the invoice", description: e.message }),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={invoice ? "Edit invoice" : "New invoice"}
      footer={<Footer onClose={onClose} busy={save.isPending} disabled={amountBad} label="Save" onSave={() => save.mutate()} />}
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="iv-no">Number</Label>
            <Input id="iv-no" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="INV-001" maxLength={80} />
          </div>
          <div>
            <Label htmlFor="iv-amount">Amount</Label>
            <div className="flex gap-2">
              <Input
                id="iv-amount"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="flex-1"
                autoFocus
              />
              <Select value={cur} onChange={setCur} options={currencyOptions(cur)} className="w-24" aria-label="Currency" />
            </div>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="iv-issued">Date</Label>
            <DateField id="iv-issued" value={issued} onChange={setIssued} />
          </div>
          <div>
            <Label htmlFor="iv-due">Pay by</Label>
            <DateField id="iv-due" value={dueOn} onChange={setDueOn} />
          </div>
        </div>
        <div className="space-y-2">
          <Toggle checked={paid} onChange={setPaid} label="Paid" />
          {paid && <DateField aria-label="Paid on" value={paidOn} onChange={setPaidOn} clearable={false} className="sm:w-64" />}
        </div>
        <div>
          <Label htmlFor="iv-note">Note</Label>
          <Input id="iv-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Deposit, 50%…" maxLength={300} />
        </div>
        <div>
          <Label>File</Label>
          <input
            ref={picker}
            type="file"
            hidden
            accept="application/pdf,image/*,.pdf"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) setFile(f);
            }}
          />
          <div className="flex items-center gap-2 min-w-0">
            <Button size="sm" iconLeft={<Upload size={14} />} onClick={() => picker.current?.click()}>
              {file || invoice?.file_name ? "Replace" : "Attach"}
            </Button>
            {(file?.name ?? invoice?.file_name) && (
              <span className="inline-flex items-center gap-1.5 text-sm text-muted min-w-0">
                <FileText size={14} className="shrink-0" /> <span className="truncate">{file?.name ?? invoice?.file_name}</span>
              </span>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// --------------------------------------------------------------------- link --
export function LinkModal({
  projectId,
  deliveries,
  onClose,
}: {
  projectId: string;
  deliveries: Delivery[];
  onClose: () => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [delivery, setDelivery] = useState("");
  const save = useMutation({
    mutationFn: () => addProjectLink(projectId, delivery || null, url, name),
    onSuccess: () => {
      invalidate();
      onClose();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't add the link", description: e.message }),
  });
  return (
    <Modal open onClose={onClose} title="Add a link" footer={<Footer onClose={onClose} busy={save.isPending} disabled={!url.trim()} label="Add" onSave={() => save.mutate()} />}>
      <div className="space-y-4">
        <div>
          <Label htmlFor="ln-url">Link</Label>
          <Input id="ln-url" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus placeholder="https://drive.google.com/…" />
          <Hint>For big videos and folders: Drive, WeTransfer, Dropbox, Frame.io…</Hint>
        </div>
        <div>
          <Label htmlFor="ln-name">Name</Label>
          <Input id="ln-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Final video, 4K" maxLength={300} />
        </div>
        {deliveries.length > 0 && (
          <div>
            <Label>For</Label>
            <Select
              value={delivery}
              onChange={setDelivery}
              aria-label="Delivery"
              options={[{ value: "", label: "The project" }, ...deliveries.map((d) => ({ value: d.id, label: d.title }))]}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}
