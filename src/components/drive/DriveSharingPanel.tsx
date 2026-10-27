import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, FolderOpen, HardDrive, Pencil, Plus, Unplug, UserMinus, Users, X } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Toggle } from "@/components/ui/Controls";
import { EmptyState } from "@/components/ui/EmptyState";
import { Label } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Section } from "@/components/ui/Section";
import { Select } from "@/components/ui/Select";
import { PageSpinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/format";
import {
  DRIVE_ACCESS,
  FOLDER_MIME,
  driveCapsText,
  fetchDriveSharedWithMe,
  fetchMyDriveShares,
  removeDriveShare,
  setDriveShare,
  unshareDriveItem,
  type DriveAccess,
  type MyDriveShare,
  type MyDriveShares,
} from "@/lib/driveApi";
import { useWbPeople } from "@/lib/wb/people";

// -----------------------------------------------------------------------------
// Connected accounts, Sharing, Drive: who can use each of my Drive accounts
// and how, what they did with it lately, and the Drives others shared with me.
// -----------------------------------------------------------------------------

/** openFor: an account's Share was pressed above: its share window opens (then onOpened). */
export function DriveSharingPanel({ openFor, onOpened }: { openFor?: string | null; onOpened?: () => void } = {}) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const mine = useQuery({ queryKey: ["drive-shares"], queryFn: fetchMyDriveShares });
  const withMe = useQuery({ queryKey: ["drive-shared-with-me"], queryFn: fetchDriveSharedWithMe });
  const [editing, setEditing] = useState<{ account: MyDriveShares; share?: MyDriveShare } | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["drive-shares"] });
    void qc.invalidateQueries({ queryKey: ["drive-shared-with-me"] });
  };

  const drop = useMutation({
    mutationFn: (id: string) => removeDriveShare(id),
    onSuccess: refresh,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't remove the access", description: e.message }),
  });
  const unpick = useMutation({
    mutationFn: (v: { share: string; file: string }) => unshareDriveItem(v.share, v.file),
    onSuccess: refresh,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't stop sharing it", description: e.message }),
  });

  useEffect(() => {
    if (!openFor || !mine.data) return;
    const acc = mine.data.find((a) => a.account_id === openFor);
    if (acc) setEditing({ account: acc });
    onOpened?.();
  }, [openFor, mine.data, onOpened]);

  if (mine.isLoading) return <PageSpinner />;
  if (mine.error) return <EmptyState title="Couldn't load sharing" description={(mine.error as Error).message} />;
  const accounts = mine.data ?? [];
  const others = withMe.data ?? [];

  return (
    <div className="space-y-8">
      {accounts.length === 0 && (
        <div className="text-sm text-muted">
          Connect a Google Drive above, then share it here.
        </div>
      )}

      {accounts.map((acc) => (
        <Section
          key={acc.account_id}
          title={<PanelTitle icon={<HardDrive size={12} />}>{acc.email}</PanelTitle>}
          action={
            <Button variant="secondary" size="sm" iconLeft={<Plus size={14} />} className="max-sm:h-10" onClick={() => setEditing({ account: acc })}>
              Share
            </Button>
          }
        >
          <div className="divide-y divide-line border-b border-line">
            {acc.shares.length === 0 && <div className="py-3 text-sm text-muted">Only you use this Drive.</div>}
            {acc.shares.map((s) => (
              <div key={s.id} className="py-3">
                <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <Avatar src={s.avatar_url} name={s.name} size={32} />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-ink truncate">{s.name}</div>
                      <div className="mt-0.5">
                        <Badge tone={s.access === "full" ? "accent" : "neutral"}>{driveCapsText(s.access, s.can_edit)}</Badge>
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" iconLeft={<Pencil size={14} />} className="max-sm:h-10" onClick={() => setEditing({ account: acc, share: s })}>
                      Change
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      iconLeft={<UserMinus size={14} />}
                      className="max-sm:h-10"
                      loading={drop.isPending && drop.variables === s.id}
                      onClick={async () => {
                        const ok = await confirm({
                          title: `Stop sharing with ${s.name}?`,
                          message: `${s.name} loses access to the Drive ${acc.email} in iklipse, including the files you picked for them.`,
                          confirmLabel: "Stop sharing",
                          danger: true,
                        });
                        if (ok) drop.mutate(s.id);
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
                {s.items.length > 0 && (
                  <div className="mt-3 sm:ml-11">
                    <div className="text-xs text-subtle mb-1">Files and folders you picked for {s.name}</div>
                    <ul className="flex flex-wrap gap-1.5">
                      {s.items.map((t) => (
                        <li key={t.file_id} className="inline-flex items-center gap-1 max-w-full rounded-md border border-line bg-inset pl-2 pr-1 h-7 text-xs text-ink">
                          {t.mime === FOLDER_MIME && <FolderOpen size={12} className="text-warn shrink-0" />}
                          <span className="truncate max-w-[16rem]">{t.name || "(no name)"}</span>
                          <button
                            type="button"
                            aria-label={`Stop sharing ${t.name || "this file"}`}
                            className="h-5 w-5 grid place-items-center rounded text-subtle hover:text-ink hover:bg-border/60"
                            onClick={async () => {
                              const ok = await confirm({
                                title: `Stop sharing ${t.name || "this file"}?`,
                                message: `${s.name} won't be able to open ${t.mime === FOLDER_MIME ? "this folder or anything in it" : "this file"} in iklipse anymore.`,
                                confirmLabel: "Stop sharing",
                                danger: true,
                              });
                              if (ok) unpick.mutate({ share: s.id, file: t.file_id });
                            }}
                          >
                            <X size={12} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ))}
          </div>

          {acc.log.length > 0 && (
            <details className="mt-2 group">
              <summary className="cursor-pointer select-none text-xs text-muted hover:text-ink inline-flex items-center gap-1.5">
                <Activity size={12} /> What others did with it ({acc.log.length})
              </summary>
              <ul className="mt-2 divide-y divide-line border-y border-line">
                {acc.log.map((l, i) => (
                  <li key={i} className="py-2 text-xs text-muted flex gap-2">
                    <span className="min-w-0 flex-1 break-words">
                      <span className="text-ink font-medium">{l.actor_name}</span> {l.action}
                      {l.detail && <span className="text-ink"> {l.detail}</span>}
                    </span>
                    <span className="text-subtle shrink-0 whitespace-nowrap">{relativeTime(l.at)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Section>
      ))}

      <Section
        title={<PanelTitle icon={<Users size={12} />}>Shared with you</PanelTitle>}
        action={
          others.length > 0 && (
            <Link to="/shared?tab=drive" className="text-sm font-medium text-accent hover:underline underline-offset-2 inline-flex items-center gap-1">
              <FolderOpen size={14} /> Open Shared
            </Link>
          )
        }
      >
        <div className="divide-y divide-line border-b border-line">
          {others.length === 0 && <div className="py-3 text-sm text-muted">Nobody shared a Drive, a file or a folder with you yet.</div>}
          {others.map((o) => (
            <div key={o.share_id} className="py-3 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <Avatar src={o.owner_avatar} name={o.owner_name} size={32} />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-ink truncate">{o.email}</div>
                  <div className="text-xs text-muted">
                    From {o.owner_name} · {driveCapsText(o.access, o.can_edit)}
                    {o.items > 0 && ` · ${o.items} picked`}
                  </div>
                </div>
              </div>
              <Button
                variant="secondary"
                size="sm"
                iconLeft={<Unplug size={14} />}
                className="max-sm:h-10"
                loading={drop.isPending && drop.variables === o.share_id}
                onClick={async () => {
                  const ok = await confirm({
                    title: `Give back access to ${o.email}?`,
                    message: `It leaves your Shared page. ${o.owner_name} can share it again.`,
                    confirmLabel: "Give back",
                    danger: true,
                  });
                  if (ok) drop.mutate(o.share_id);
                }}
              >
                Give back
              </Button>
            </div>
          ))}
        </div>
      </Section>

      {editing && (
        <DriveShareModal
          account={editing.account}
          share={editing.share}
          onClose={() => setEditing(null)}
          onSaved={() => {
            refresh();
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

/** Give someone access to a Drive, or change theirs. */
function DriveShareModal({ account, share, onClose, onSaved }: { account: MyDriveShares; share?: MyDriveShare; onClose: () => void; onSaved: () => void }) {
  const { user } = useAuth();
  const toast = useToast();
  const people = useWbPeople();
  const [who, setWho] = useState(share?.grantee_id ?? "");
  const [access, setAccess] = useState<DriveAccess>(share?.access ?? "read");
  const [canEdit, setCanEdit] = useState(share?.can_edit ?? false);
  const taken = new Set(account.shares.map((s) => s.grantee_id));
  const list = (people.data?.list ?? []).filter((p) => p.is_active && p.id !== user?.id && (p.id === share?.grantee_id || !taken.has(p.id)));
  const name = list.find((p) => p.id === who)?.display_name ?? share?.name ?? "They";

  const save = useMutation({
    mutationFn: () => setDriveShare({ account: account.account_id, grantee: who, access, canEdit: access === "custom" && canEdit }),
    onSuccess: () => {
      toast.push({ kind: "success", title: share ? `${name}'s access changed` : `Shared with ${name}`, description: share ? undefined : "It's on their Shared page." });
      onSaved();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't save", description: e.message }),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={share ? `${share.name}'s access` : `Share ${account.email}`}
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!who} loading={save.isPending} onClick={() => save.mutate()}>
            {share ? "Save" : "Share"}
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        {!share && (
          <div>
            <Label>With</Label>
            <Select
              value={who}
              onChange={setWho}
              placeholder={people.isLoading ? "Loading…" : "Pick someone"}
              options={list.map((p) => ({ value: p.id, label: p.display_name, icon: <Avatar src={p.avatar_url} name={p.display_name} size={18} /> }))}
              searchable
              className="w-full"
            />
          </div>
        )}

        <fieldset>
          <legend className="block text-sm font-medium text-ink mb-1.5">What they can do</legend>
          <div className="space-y-1.5">
            {DRIVE_ACCESS.map((o) => (
              <label
                key={o.value}
                className={cn(
                  "flex items-start gap-3 rounded-md border px-3 py-2.5 cursor-pointer transition-colors",
                  access === o.value ? "border-accent bg-accent-soft" : "border-border hover:bg-hover",
                )}
              >
                <input
                  type="radio"
                  name="drive-share-access"
                  value={o.value}
                  checked={access === o.value}
                  onChange={() => setAccess(o.value)}
                  className="mt-1 h-4 w-4 accent-[rgb(var(--c-accent))]"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-ink">{o.label}</span>
                  <span className="block text-xs text-muted">{o.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {access === "custom" && (
          <>
            <p className="text-xs text-muted">To pick files and folders, open Drive, press the dots next to one, then Share in iklipse.</p>
            <Toggle
              checked={canEdit}
              onChange={setCanEdit}
              label="They can add and rename"
              info="Upload files, make folders and rename, only inside the folders you picked."
            />
          </>
        )}
      </div>
    </Modal>
  );
}

function PanelTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 max-w-full min-w-0 align-bottom">
      <span className="grid place-items-center h-5 w-5 rounded bg-accent-soft text-accent shrink-0">{icon}</span>
      <span className="truncate">{children}</span>
    </span>
  );
}
