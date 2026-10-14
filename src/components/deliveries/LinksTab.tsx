import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, Copy, Link2, MoreHorizontal, Pencil, Plus, Power, Trash2, UserX } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Hint, Input, Label } from "@/components/ui/Input";
import { DateField } from "@/components/ui/DateField";
import { Select } from "@/components/ui/Select";
import { Segmented, Toggle } from "@/components/ui/Controls";
import { Menu, MenuDivider, MenuItem } from "@/components/ui/Menu";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { relativeTime } from "@/lib/format";
import { Heading, day } from "./parts";
import { createLink, deleteLink, deliveryUrl, linkLive, removeViewer, updateLink, type Delivery, type DeliveryLink, type LinkInput } from "@/lib/deliveriesApi";

// -----------------------------------------------------------------------------
// The links a delivery goes out on (managers). Each can expire, cap how many
// devices and people open it, and allow downloads. Every device that opened a
// link is listed; freeing one makes it say who it is again.
// -----------------------------------------------------------------------------

export function LinksTab({ delivery, onChanged }: { delivery: Delivery; onChanged: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [form, setForm] = useState<DeliveryLink | "new" | null>(null);
  const [made, setMade] = useState<DeliveryLink | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const change = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: onChanged,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't update the link", description: e.message }),
  });
  const toggle = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const live = delivery.links.filter((l) => linkLive(l)).length;

  return (
    <div className="max-w-4xl">
      <Heading
        title="Links for the client"
        count={delivery.links.length}
        action={
          <Button size="sm" variant="primary" iconLeft={<Plus size={14} />} onClick={() => setForm("new")}>
            New link
          </Button>
        }
      />
      <p className="mt-2 text-sm text-muted">
        {live
          ? `${live === 1 ? "1 link is" : `${live} links are`} live. The client opens it without an account, says who they are once, comments and sends their feedback.`
          : "Make a link and send it to the client. They open it without an account, comment and send their feedback."}
      </p>

      {!delivery.links.length ? (
        <EmptyState
          icon={<Link2 size={20} />}
          title="No links yet"
          description="One link per person, or one for the whole client team: you choose how many people and devices can open it."
          action={
            <Button variant="primary" iconLeft={<Plus size={14} />} onClick={() => setForm("new")}>
              New link
            </Button>
          }
        />
      ) : (
        <ul className="mt-4 divide-y divide-line border-b border-line">
          {delivery.links.map((l) => (
            <LinkRow
              key={l.id}
              l={l}
              open={expanded.has(l.id)}
              onToggle={() => toggle(l.id)}
              onEdit={() => setForm(l)}
              onPower={() => change.mutate(() => updateLink(l.id, { revoked_at: l.revoked_at ? null : new Date().toISOString() }))}
              onDelete={async () => {
                const ok = await confirm({
                  title: "Delete this link?",
                  message: "It stops working at once. The client's comments stay.",
                  confirmLabel: "Delete",
                  danger: true,
                });
                if (ok) change.mutate(() => deleteLink(l.id));
              }}
              onFree={async (device, name) => {
                const ok = await confirm({
                  title: `Free ${name}'s device?`,
                  message: "Their place on this link opens up. If they open it again on that device, they're asked who they are.",
                  confirmLabel: "Free it",
                });
                if (ok) change.mutate(() => removeViewer(l.id, device));
              }}
            />
          ))}
        </ul>
      )}

      {form && (
        <LinkFormModal
          folder={delivery.id}
          link={form === "new" ? null : form}
          onClose={() => setForm(null)}
          onSaved={(l) => {
            onChanged();
            setForm(null);
            if (l) setMade(l);
          }}
        />
      )}
      {made && <MadeModal link={made} onClose={() => setMade(null)} />}
    </div>
  );
}

function copy(text: string, toast: ReturnType<typeof useToast>) {
  navigator.clipboard.writeText(text).then(
    () => toast.push({ kind: "success", title: "Link copied" }),
    () => toast.push({ kind: "error", title: "Couldn't copy", description: text }),
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 of 3 devices · 1 of 1 people", or plain counts when there's no cap. */
function limits(l: DeliveryLink): string {
  const devices = l.viewers.length;
  const people = new Set(l.viewers.map((v) => v.email.trim().toLowerCase())).size;
  return [
    l.max_devices ? `${devices} of ${l.max_devices} devices` : plural(devices, "device", "devices"),
    l.max_people ? `${people} of ${l.max_people} people` : plural(people, "person", "people"),
  ].join(" · ");
}

function LinkRow({
  l,
  open,
  onToggle,
  onEdit,
  onPower,
  onDelete,
  onFree,
}: {
  l: DeliveryLink;
  open: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onPower: () => void;
  onDelete: () => void;
  onFree: (device: string, name: string) => void;
}) {
  const toast = useToast();
  const url = deliveryUrl(l.token);
  const expired = !!l.expires_at && new Date(l.expires_at).getTime() <= Date.now();
  const status = l.revoked_at ? (
    <Badge>Turned off</Badge>
  ) : expired ? (
    <Badge tone="danger">Expired</Badge>
  ) : (
    <Badge tone="success">Live</Badge>
  );
  return (
    <li className="-mx-2 px-2 py-3 rounded-md hover:bg-inset/60 transition-colors">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold text-ink break-words">{l.label || "Link"}</span>
            {status}
            {l.allow_download && <span className="text-xs text-muted">Downloads on</span>}
          </div>
          <div className="mt-1 text-sm text-muted">
            {[
              limits(l),
              l.expires_at ? `${expired ? "Expired" : "Expires"} ${day(l.expires_at)}` : "Never expires",
              l.created_by_name && `Made by ${l.created_by_name}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
          <div className="mt-2 flex items-center gap-2 min-w-0">
            <code className="min-w-0 flex-1 truncate rounded-md bg-inset px-2 py-1 text-xs text-muted">{url}</code>
            <Button size="sm" iconLeft={<Copy size={13} />} onClick={() => copy(url, toast)}>
              Copy
            </Button>
          </div>
        </div>
        <Menu
          align="right"
          trigger={
            <button type="button" aria-label="Link actions" className="h-9 w-9 shrink-0 grid place-items-center rounded-md text-subtle hover:text-ink hover:bg-inset">
              <MoreHorizontal size={16} />
            </button>
          }
        >
          {(close) => (
            <>
              <MenuItem onClick={() => (close(), onPower())}>
                <span className="inline-flex items-center gap-2">
                  <Power size={14} /> {l.revoked_at ? "Turn on" : "Turn off"}
                </span>
              </MenuItem>
              <MenuItem onClick={() => (close(), onEdit())}>
                <span className="inline-flex items-center gap-2">
                  <Pencil size={14} /> Edit limits and expiry
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

      {l.viewers.length > 0 && (
        <button type="button" onClick={onToggle} aria-expanded={open} className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-ink">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          Who opened it · {l.viewers.length}
        </button>
      )}
      {open && (
        <ul className="mt-2 ml-5 divide-y divide-line border-t border-line">
          {l.viewers.map((v) => (
            <li key={v.device_id} className="-mx-2 px-2 py-2.5 flex items-start gap-3 rounded-md hover:bg-inset transition-colors">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-ink">
                  <span className="font-medium">{v.name}</span> <span className="text-muted break-all">{v.email}</span>
                </div>
                <div className="text-xs text-muted">
                  {[v.device_name, `First opened ${day(v.first_seen)}`, `last seen ${relativeTime(v.last_seen)}`, plural(v.opens, "open", "opens")].filter(Boolean).join(" · ")}
                </div>
              </div>
              <Button size="sm" variant="ghost" iconLeft={<UserX size={13} />} onClick={() => onFree(v.device_id, v.name)}>
                <span className="hidden sm:inline">Free this device</span>
                <span className="sm:hidden">Free</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

// ------------------------------------------------------------------- form --
type Expiry = "never" | "1" | "3" | "7" | "30" | "date";
const EXPIRY_OPTIONS: { value: Expiry; label: string }[] = [
  { value: "never", label: "Never" },
  { value: "1", label: "In 1 day" },
  { value: "3", label: "In 3 days" },
  { value: "7", label: "In 7 days" },
  { value: "30", label: "In 30 days" },
  { value: "date", label: "On a date" },
];

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** A cap: none, or a number from 1. */
function CapField({ label, hint, value, onChange }: { label: string; hint: string; value: number | null; onChange: (v: number | null) => void }) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<"none" | "cap">
          value={value == null ? "none" : "cap"}
          onChange={(v) => onChange(v === "none" ? null : 1)}
          options={[
            { value: "none", label: "Unlimited" },
            { value: "cap", label: "Up to" },
          ]}
        />
        {value != null && (
          <Input
            type="number"
            min={1}
            max={1000}
            value={value}
            onChange={(e) => onChange(Math.max(1, Math.min(1000, Math.floor(Number(e.target.value) || 1))))}
            className="w-24"
            aria-label={label}
          />
        )}
      </div>
      <Hint>{hint}</Hint>
    </div>
  );
}

function LinkFormModal({
  folder,
  link,
  onClose,
  onSaved,
}: {
  folder: string;
  link: DeliveryLink | null;
  onClose: () => void;
  /** The new link (null after an edit). */
  onSaved: (l: DeliveryLink | null) => void;
}) {
  const toast = useToast();
  const [label, setLabel] = useState(link?.label ?? "");
  const [expiry, setExpiry] = useState<Expiry>(link?.expires_at ? "date" : "never");
  const [date, setDate] = useState(link?.expires_at ? ymd(new Date(link.expires_at)) : "");
  const [devices, setDevices] = useState<number | null>(link ? link.max_devices : null);
  const [people, setPeople] = useState<number | null>(link ? link.max_people : null);
  const [download, setDownload] = useState(link?.allow_download ?? false);

  const expiresAt = (): string | null => {
    if (expiry === "never") return null;
    if (expiry === "date") {
      if (!date) return null;
      // The same day as saved: keep the exact moment.
      if (link?.expires_at && ymd(new Date(link.expires_at)) === date) return link.expires_at;
      const [y, m, d] = date.split("-").map(Number);
      // Works until the end of that day.
      return new Date(y, m - 1, d, 23, 59, 59).toISOString();
    }
    return new Date(Date.now() + Number(expiry) * 86_400_000).toISOString();
  };

  const save = useMutation({
    mutationFn: async () => {
      const v: LinkInput = { label: label.trim() || null, max_devices: devices, max_people: people, expires_at: expiresAt(), allow_download: download };
      if (link) {
        await updateLink(link.id, v);
        return null;
      }
      return createLink(folder, v);
    },
    onSuccess: onSaved,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't save the link", description: e.message }),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={link ? "Edit the link" : "New link"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={expiry === "date" && !date} onClick={() => save.mutate()}>
            {link ? "Save" : "Make the link"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div>
          <Label htmlFor="ln-label">Who it's for</Label>
          <Input id="ln-label" value={label} onChange={(e) => setLabel(e.target.value)} autoFocus maxLength={80} placeholder="Sara at Acme, or the marketing team" />
          <Hint>Only you and the team see this.</Hint>
        </div>
        <div>
          <Label>Expires</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select value={expiry} onChange={(v) => setExpiry(v as Expiry)} options={EXPIRY_OPTIONS} className="sm:w-44" aria-label="Expires" />
            {expiry === "date" && <DateField value={date} onChange={setDate} min={ymd(new Date())} className="sm:w-56" aria-label="Expiry date" />}
          </div>
          {link?.expires_at && expiry !== "date" && <Hint>Counts from now.</Hint>}
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <CapField label="Devices" hint="Phones and computers that can open it." value={devices} onChange={setDevices} />
          <CapField label="People" hint="Different emails that can open it." value={people} onChange={setPeople} />
        </div>
        <Toggle checked={download} onChange={setDownload} label="Allow downloads" hint="Off: they can watch and comment, not save the files." />
      </div>
    </Modal>
  );
}

/** Right after making a link: the address, ready to copy. */
function MadeModal({ link, onClose }: { link: DeliveryLink; onClose: () => void }) {
  const toast = useToast();
  const url = deliveryUrl(link.token);
  const [copied, setCopied] = useState(false);
  return (
    <Modal
      open
      onClose={onClose}
      title="The link is ready"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <p className="text-sm text-muted">Send it to {link.label || "the client"}. They open it without an account.</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input value={url} readOnly onFocus={(e) => e.currentTarget.select()} aria-label="Link" className="flex-1" />
        <Button
          variant={copied ? "secondary" : "primary"}
          iconLeft={copied ? <Check size={14} /> : <Copy size={14} />}
          onClick={() =>
            navigator.clipboard.writeText(url).then(
              () => setCopied(true),
              () => toast.push({ kind: "error", title: "Couldn't copy", description: "Select the link and copy it." }),
            )
          }
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </Modal>
  );
}
