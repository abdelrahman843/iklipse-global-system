import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Hint, Input, Label, Textarea } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { useRefreshDeliveries } from "./parts";
import {
  addDeliveryLinkItem,
  createDelivery,
  listDeliveries,
  updateDelivery,
  updateItem,
  type Delivery,
  type DeliveryItem,
  type ProjectOption,
} from "@/lib/deliveriesApi";

// -----------------------------------------------------------------------------
// The small forms of the Deliveries pages. Each is mounted only while open, so
// it starts from what's saved.
// -----------------------------------------------------------------------------

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

/** The projects a delivery can be filed under (managers only). */
function useProjectOptions() {
  return useQuery({ queryKey: ["deliveries"], queryFn: listDeliveries, staleTime: 30_000 });
}

const projectOptions = (projects: ProjectOption[]) => [
  { value: "", label: "No project" },
  ...projects.map((p) => ({ value: p.id, label: p.client ? `${p.title} · ${p.client}` : p.title })),
];

function ProjectPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const q = useProjectOptions();
  return (
    <Select
      value={value}
      onChange={onChange}
      className="w-full"
      aria-label="Project"
      placeholder={q.isLoading ? "Loading projects…" : "No project"}
      options={projectOptions(q.data?.projects ?? [])}
    />
  );
}

// --------------------------------------------------------------------- new --
export function NewDeliveryModal({ projectId, onClose }: { projectId?: string | null; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const refresh = useRefreshDeliveries();
  const [title, setTitle] = useState("");
  const [project, setProject] = useState(projectId ?? "");
  const [note, setNote] = useState("");
  const save = useMutation({
    mutationFn: () => createDelivery({ title, note, project_id: project || null }),
    onSuccess: (id) => {
      refresh();
      onClose();
      nav(`/deliveries/${id}`);
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't make the delivery", description: e.message }),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="New delivery"
      footer={<Footer onClose={onClose} busy={save.isPending} disabled={!title.trim()} label="Create" onSave={() => save.mutate()} />}
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="dl-title">Title</Label>
          <Input
            id="dl-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            maxLength={120}
            placeholder="Launch video, first cut"
            onKeyDown={(e) => e.key === "Enter" && title.trim() && save.mutate()}
          />
        </div>
        <div>
          <Label>Project</Label>
          <ProjectPicker value={project} onChange={setProject} />
          <Hint>Everyone on the project sees what was sent and the client's feedback.</Hint>
        </div>
        <div>
          <Label htmlFor="dl-note">Note for the client</Label>
          <Textarea id="dl-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} placeholder="Optional. Shown at the top of their link." />
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------- move, note --
export function MoveDeliveryModal({ delivery, onClose }: { delivery: Delivery; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefreshDeliveries();
  const [project, setProject] = useState(delivery.project_id ?? "");
  const save = useMutation({
    mutationFn: () => updateDelivery(delivery.id, { project_id: project || null }),
    onSuccess: () => {
      refresh();
      onClose();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't move it", description: e.message }),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Move to a project"
      footer={<Footer onClose={onClose} busy={save.isPending} label="Move" onSave={() => save.mutate()} />}
    >
      <ProjectPicker value={project} onChange={setProject} />
      <Hint>Everyone on the project sees this delivery and its feedback.</Hint>
    </Modal>
  );
}

export function NoteModal({ delivery, onClose }: { delivery: Delivery; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefreshDeliveries();
  const [note, setNote] = useState(delivery.note ?? "");
  const save = useMutation({
    mutationFn: () => updateDelivery(delivery.id, { note: note.trim() || null }),
    onSuccess: () => {
      refresh();
      onClose();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't save the note", description: e.message }),
  });
  return (
    <Modal open onClose={onClose} title="Note for the client" footer={<Footer onClose={onClose} busy={save.isPending} label="Save" onSave={() => save.mutate()} />}>
      <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={5} maxLength={2000} autoFocus aria-label="Note" placeholder="What's in it, what to look at" />
      <Hint>Shown at the top of the client's link.</Hint>
    </Modal>
  );
}

// ------------------------------------------------------------------- items --
export function RenameItemModal({ item, onClose }: { item: DeliveryItem; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefreshDeliveries();
  const [name, setName] = useState(item.name);
  const save = useMutation({
    mutationFn: () => updateItem(item.id, { name: name.trim() }),
    onSuccess: () => {
      refresh();
      onClose();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't rename it", description: e.message }),
  });
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title="Rename"
      footer={<Footer onClose={onClose} busy={save.isPending} disabled={!name.trim()} label="Save" onSave={() => save.mutate()} />}
    >
      <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={200} aria-label="Name" onKeyDown={(e) => e.key === "Enter" && name.trim() && save.mutate()} />
    </Modal>
  );
}

export function AddLinkItemModal({ folder, onClose }: { folder: string; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefreshDeliveries();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const save = useMutation({
    mutationFn: () => addDeliveryLinkItem(folder, url, name),
    onSuccess: () => {
      refresh();
      onClose();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't add the link", description: e.message === "Invalid URL" ? "That doesn't look like a link." : e.message }),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Add a link"
      footer={<Footer onClose={onClose} busy={save.isPending} disabled={!url.trim()} label="Add" onSave={() => save.mutate()} />}
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="dl-url">Link</Label>
          <Input id="dl-url" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus placeholder="https://drive.google.com/…" inputMode="url" />
          <Hint>A Drive folder, a Figma file, a website. The client opens it in a new tab.</Hint>
        </div>
        <div>
          <Label htmlFor="dl-url-name">Name</Label>
          <Input id="dl-url-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="Optional" />
        </div>
      </div>
    </Modal>
  );
}
