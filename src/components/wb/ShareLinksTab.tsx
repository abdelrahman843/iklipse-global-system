import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Laptop, Link2, Plus, Power, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Hint, Input, Label } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Controls";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/format";
import {
  createShareLink,
  deleteShareLink,
  fetchShareLinks,
  removeShareDevice,
  shareUrl,
  updateShareLink,
  type ShareAccess,
  type ShareDevice,
  type ShareLink,
} from "@/lib/wb/share";

// -----------------------------------------------------------------------------
// Share dialog, "Client links" tab: links that open the board without an
// account (view or comment), with an optional expiry and device limit.
// -----------------------------------------------------------------------------

type Expiry = "never" | "1" | "7" | "30" | "date";
type Devices = "any" | "1" | "2" | "5" | "custom";

const DAY = 24 * 3600 * 1000;

function copy(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

function expiryText(l: ShareLink) {
  if (!l.expires_at) return "Never expires";
  const t = new Date(l.expires_at).getTime();
  return t <= Date.now() ? "Expired" : `Expires ${relativeTime(l.expires_at)}`;
}

export function ShareLinksTab({ boardId }: { boardId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const key = ["wb-share-links", boardId];
  const q = useQuery({ queryKey: key, queryFn: () => fetchShareLinks(boardId) });
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const fail = (title: string) => (e: Error) => toast.push({ kind: "error", title, description: e.message });

  // ---- new link form
  const [label, setLabel] = useState("");
  const [access, setAccess] = useState<ShareAccess>("view");
  const [expiry, setExpiry] = useState<Expiry>("7");
  const [date, setDate] = useState("");
  const [devices, setDevices] = useState<Devices>("any");
  const [custom, setCustom] = useState("3");

  const expiresAt = (): string | null | undefined => {
    if (expiry === "never") return null;
    if (expiry === "date") {
      if (!date) return undefined;
      // End of the chosen day, local time.
      const d = new Date(`${date}T23:59:59`);
      return isNaN(d.getTime()) || d.getTime() <= Date.now() ? undefined : d.toISOString();
    }
    return new Date(Date.now() + Number(expiry) * DAY).toISOString();
  };
  const maxDevices = (): number | null | undefined => {
    if (devices === "any") return null;
    const n = devices === "custom" ? parseInt(custom, 10) : Number(devices);
    return Number.isFinite(n) && n >= 1 && n <= 1000 ? n : undefined;
  };

  const create = useMutation({
    mutationFn: async () => {
      const e = expiresAt();
      const m = maxDevices();
      if (e === undefined) throw new Error("Pick a date in the future.");
      if (m === undefined) throw new Error("Devices must be a number from 1 to 1000.");
      return createShareLink({ board_id: boardId, label: label.trim() || null, access, expires_at: e, max_devices: m });
    },
    onSuccess: (l) => {
      copy(shareUrl(l.token));
      toast.push({ kind: "success", title: "Link created and copied", description: "Send it to your client. They don't need an account." });
      setLabel("");
      refresh();
    },
    onError: fail("Couldn't create the link"),
  });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof updateShareLink>[1] }) => updateShareLink(id, patch),
    onSuccess: refresh,
    onError: fail("Couldn't save"),
  });
  const remove = useMutation({ mutationFn: deleteShareLink, onSuccess: refresh, onError: fail("Couldn't delete the link") });
  const kick = useMutation({
    mutationFn: ({ link, device }: { link: string; device: string }) => removeShareDevice(link, device),
    onSuccess: refresh,
    onError: fail("Couldn't remove the device"),
  });

  const links = q.data?.links ?? [];
  const byLink = new Map<string, ShareDevice[]>();
  for (const d of q.data?.devices ?? []) byLink.set(d.link_id, [...(byLink.get(d.link_id) ?? []), d]);

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-border bg-surface p-3 sm:p-4 space-y-3">
        <div>
          <div className="text-sm font-semibold text-ink">New client link</div>
          <div className="text-xs text-muted">Opens this board without an account. You can turn it off any time.</div>
        </div>
        <div>
          <Label htmlFor="share-label">Who it's for</Label>
          <Input id="share-label" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder="Client or company name (optional)" />
        </div>
        <div className="grid gap-3">
          <Row name="Access">
            <Segmented<ShareAccess>
              value={access}
              onChange={setAccess}
              options={[
                { value: "view", label: "Can view" },
                { value: "comment", label: "Can comment" },
              ]}
            />
          </Row>
          <Row name="Expires">
            <Segmented<Expiry>
              value={expiry}
              onChange={setExpiry}
              options={[
                { value: "1", label: "1 day" },
                { value: "7", label: "7 days" },
                { value: "30", label: "30 days" },
                { value: "date", label: "Pick a date" },
                { value: "never", label: "Never" },
              ]}
            />
            {expiry === "date" && (
              <Input type="date" aria-label="Expiry date" value={date} onChange={(e) => setDate(e.target.value)} className="w-auto" />
            )}
          </Row>
          <Row name="Devices">
            <Segmented<Devices>
              value={devices}
              onChange={setDevices}
              options={[
                { value: "any", label: "Any number" },
                { value: "1", label: "1 device only" },
                { value: "2", label: "2" },
                { value: "5", label: "5" },
                { value: "custom", label: "Other" },
              ]}
            />
            {devices === "custom" && (
              <Input type="number" min={1} max={1000} aria-label="Number of devices" value={custom} onChange={(e) => setCustom(e.target.value)} className="w-24" />
            )}
          </Row>
        </div>
        <Hint>Each phone or computer that opens the link takes one place. Once the places are taken, new devices can't open it; you can free a place below.</Hint>
        <div className="flex justify-end">
          <Button variant="primary" size="sm" iconLeft={<Plus size={15} />} loading={create.isPending} onClick={() => create.mutate()}>
            Create link
          </Button>
        </div>
      </section>

      <section className="space-y-2">
        <div className="text-sm font-semibold text-ink">Links {links.length > 0 && <span className="text-subtle font-normal">({links.length})</span>}</div>
        {q.isLoading && <div className="text-sm text-subtle">Loading…</div>}
        {q.isError && <div className="text-sm text-danger">Couldn't load the links.</div>}
        {!q.isLoading && !links.length && <div className="text-sm text-subtle">No client links yet.</div>}
        <ul className="space-y-2">
          {links.map((l) => {
            const devs = byLink.get(l.id) ?? [];
            const off = !!l.revoked_at;
            const expired = !!l.expires_at && new Date(l.expires_at).getTime() <= Date.now();
            return (
              <li key={l.id} className={cn("rounded-lg border border-border bg-surface p-3", (off || expired) && "opacity-70")}>
                <div className="flex flex-wrap items-center gap-2">
                  <Link2 size={15} className="text-accent shrink-0" />
                  <span className="font-medium text-ink truncate max-w-[220px]">{l.label || "Client link"}</span>
                  <Badge tone={l.access === "comment" ? "accent" : "neutral"}>{l.access === "comment" ? "Can comment" : "Can view"}</Badge>
                  {off ? <Badge tone="danger">Off</Badge> : expired ? <Badge tone="warn">Expired</Badge> : <Badge tone="success">On</Badge>}
                  <div className="ml-auto flex items-center gap-1">
                    <IconBtn
                      title="Copy link"
                      onClick={() => {
                        copy(shareUrl(l.token));
                        toast.push({ kind: "success", title: "Link copied" });
                      }}
                    >
                      <Copy size={15} />
                    </IconBtn>
                    <IconBtn title={off ? "Turn the link back on" : "Turn the link off"} onClick={() => update.mutate({ id: l.id, patch: { revoked_at: off ? null : new Date().toISOString() } })}>
                      <Power size={15} className={off ? "text-success" : undefined} />
                    </IconBtn>
                    <IconBtn
                      title="Delete link"
                      onClick={async () => {
                        const ok = await confirm({
                          title: "Delete this link?",
                          message: "Anyone using it loses access. Their comments stay on the board.",
                          confirmLabel: "Delete",
                          danger: true,
                        });
                        if (ok) remove.mutate(l.id);
                      }}
                    >
                      <Trash2 size={15} />
                    </IconBtn>
                  </div>
                </div>
                <div className="mt-1.5 text-xs text-muted flex flex-wrap gap-x-3 gap-y-0.5">
                  <span>{expiryText(l)}</span>
                  <span>
                    {l.max_devices ? `${devs.length} of ${l.max_devices} device${l.max_devices === 1 ? "" : "s"}` : `${devs.length} device${devs.length === 1 ? "" : "s"} so far`}
                  </span>
                  <span>Made {relativeTime(l.created_at)}</span>
                </div>
                {devs.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {devs.map((d) => (
                      <li key={d.device_id} className="flex items-center gap-2 text-xs text-muted">
                        <Laptop size={13} className="shrink-0 text-subtle" />
                        <span className="text-ink truncate">{d.name || "Unnamed device"}</span>
                        <span className="truncate">last opened {relativeTime(d.last_seen)}</span>
                        <button
                          type="button"
                          title="Free this place"
                          aria-label="Remove this device"
                          className="ml-auto h-6 w-6 grid place-items-center rounded text-subtle hover:bg-inset hover:text-danger"
                          onClick={() => kick.mutate({ link: l.id, device: d.device_id })}
                        >
                          <X size={13} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function Row({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="w-16 text-sm font-medium text-ink">{name}</span>
      {children}
    </div>
  );
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick} className="h-8 w-8 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink">
      {children}
    </button>
  );
}
