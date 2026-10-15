import { useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  Eye,
  HardDrive,
  Link2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Menu, MenuDivider, MenuItem } from "@/components/ui/Menu";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Heading, Thumb, fileSize, hostOf, useTeamUrls } from "./parts";
import { AddDriveModal, AddLinkItemModal, RenameItemModal } from "./DeliveryModals";
import { ItemViewer } from "./ItemViewer";
import { fileKey, previewable, removeItem, restoreItem, teamDownloadUrl, updateItem, uploadDeliveryFiles, type Delivery, type DeliveryItem } from "@/lib/deliveriesApi";

// -----------------------------------------------------------------------------
// A delivery's files: what the client sees, in order, as previews. Managers
// drop files in, add links, rename, reorder and remove things (removed files
// stay for the feedback history and can be restored).
// -----------------------------------------------------------------------------

interface Upload {
  name: string;
  size: number;
  fraction: number;
}

export function FilesTab({ delivery, onChanged }: { delivery: Delivery; onChanged: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const manage = delivery.manage;
  const picker = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [uploads, setUploads] = useState<Upload[] | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [driveOpen, setDriveOpen] = useState(false);
  const [renaming, setRenaming] = useState<DeliveryItem | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);

  const active = useMemo(() => delivery.items.filter((i) => !i.removed_at).sort((a, b) => a.position - b.position), [delivery.items]);
  const removed = useMemo(() => delivery.items.filter((i) => i.removed_at), [delivery.items]);
  // What the viewer steps through: pictures, videos and the Drive files Google previews.
  const media = useMemo(() => active.filter(previewable), [active]);
  const { urls, drive } = useTeamUrls(useMemo(() => delivery.items.filter(previewable).map((i) => fileKey(i)), [delivery.items]));

  // This round's comments per file, and how many from the client are still open.
  const counts = useMemo(() => {
    const m = new Map<string, { all: number; open: number }>();
    for (const c of delivery.comments) {
      if (c.round !== delivery.round || !c.item_id) continue;
      const v = m.get(c.item_id) ?? { all: 0, open: 0 };
      v.all++;
      if (c.guest && !c.resolved_at) v.open++;
      m.set(c.item_id, v);
    }
    return m;
  }, [delivery.comments, delivery.round]);

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      setUploads(files.map((f) => ({ name: f.name, size: f.size, fraction: 0 })));
      await uploadDeliveryFiles(delivery.id, files, (i, fraction) =>
        setUploads((list) => list && list.map((u, j) => (j === i ? { ...u, fraction } : u))),
      );
    },
    onSuccess: (_, files) => toast.push({ kind: "success", title: files.length === 1 ? `${files[0].name} uploaded` : `${files.length} files uploaded` }),
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't upload", description: e.message }),
    // Files before a failed one are in: show them either way.
    onSettled: () => {
      setUploads(null);
      onChanged();
    },
  });
  const take = (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (files.length && !upload.isPending) upload.mutate(files);
  };

  const change = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: onChanged,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't update it", description: e.message }),
  });
  const download = useMutation({
    mutationFn: (i: DeliveryItem) => teamDownloadUrl(fileKey(i)!, i.name),
    onSuccess: (href) => (window.location.href = href),
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't get the file", description: e.message }),
  });

  /** Swap places with the neighbour above (-1) or below (+1). */
  const move = (i: number, dir: -1 | 1) => {
    const a = active[i];
    const b = active[i + dir];
    if (!a || !b) return;
    // Equal positions (added in the same instant) would swap to nothing: nudge.
    const pa = a.position === b.position ? b.position + dir * 0.001 : b.position;
    change.mutate(() => Promise.all([updateItem(a.id, { position: pa }), updateItem(b.id, { position: a.position })]));
  };

  const open = (i: DeliveryItem) => {
    if (i.kind === "link") window.open(i.external_url ?? undefined, "_blank", "noopener");
    else if (!previewable(i)) download.mutate(i);
    else setViewing(media.findIndex((m) => m.id === i.id));
  };

  const uploading = uploads && (
    <ul className="mt-3 space-y-2">
      {uploads.map((u, i) => (
        <li key={i} className="text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="truncate text-ink">{u.name}</span>
            <span className="shrink-0 text-xs text-muted tabular-nums">{u.fraction >= 1 ? "Done" : `${Math.round(u.fraction * 100)}% of ${fileSize(u.size)}`}</span>
          </div>
          <div className="mt-1 h-1.5 rounded-full bg-inset overflow-hidden">
            <div className={cn("h-full rounded-full transition-[width] duration-300", u.fraction >= 1 ? "bg-success" : "bg-accent")} style={{ width: `${Math.round(u.fraction * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );

  return (
    <div
      className="space-y-8"
      onDragOver={(e) => {
        if (!manage || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        if (!manage) return;
        e.preventDefault();
        setOver(false);
        take(e.dataTransfer.files);
      }}
    >
      {manage && (
        <div className={cn("rounded-xl border-2 border-dashed px-4 py-5 transition-colors", over ? "border-accent bg-accent/5" : "border-border")}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="text-base font-medium text-ink">
                {uploads ? `Uploading ${uploads.length === 1 ? "1 file" : `${uploads.length} files`}…` : "Drop pictures, videos and files here"}
              </div>
              <div className="text-sm text-muted">Big videos: add them from Google Drive instead, so they don't fill the storage.</div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
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
                Add link
              </Button>
              <Button size="sm" iconLeft={<HardDrive size={14} />} onClick={() => setDriveOpen(true)}>
                From Google Drive
              </Button>
              <Button size="sm" variant="primary" iconLeft={<Upload size={14} />} loading={upload.isPending} onClick={() => picker.current?.click()}>
                Upload files
              </Button>
            </div>
          </div>
          {uploading}
        </div>
      )}

      {!active.length ? (
        <EmptyState
          icon={<Upload size={20} />}
          title="Nothing in it yet"
          description={manage ? "Upload the work, or add links. The client sees them in this order." : "The files sent to the client show up here."}
        />
      ) : (
        <section>
          <Heading title="What the client sees" count={active.length} />
          <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 xl:grid-cols-4">
            {active.map((i, n) => {
              const c = counts.get(i.id);
              return (
                <li key={i.id} className="group min-w-0">
                  <button type="button" onClick={() => open(i)} className="block w-full text-left" aria-label={`Open ${i.name}`}>
                    <Thumb
                      item={i}
                      url={urls[fileKey(i) ?? ""] ?? null}
                      drive={drive[fileKey(i) ?? ""]}
                      className="aspect-video w-full transition-opacity group-hover:opacity-90"
                      iconSize={28}
                    />
                  </button>
                  <div className="mt-2 flex items-start gap-1">
                    <div className="min-w-0 flex-1">
                      <button type="button" onClick={() => open(i)} className="block max-w-full truncate text-base font-medium text-ink hover:text-accent" title={i.name}>
                        {i.name}
                      </button>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
                        <span>{i.kind === "link" ? hostOf(i.external_url) : fileSize(i.size)}</span>
                        {i.drive_file_id && (
                          <span className="inline-flex items-center gap-1" title={i.drive_email ? `In Google Drive (${i.drive_email})` : "In Google Drive"}>
                            <HardDrive size={11} /> Drive
                          </span>
                        )}
                        {i.added_round > 1 && <span className="rounded-full bg-accent-soft px-1.5 text-accent font-medium">Round {i.added_round}</span>}
                        {!!c?.all && (
                          <span className={cn("inline-flex items-center gap-1", c.open ? "text-warn font-medium" : "")}>
                            <MessageSquare size={11} /> {c.all}
                          </span>
                        )}
                      </div>
                    </div>
                    <ItemMenu
                      item={i}
                      manage={manage}
                      first={n === 0}
                      last={n === active.length - 1}
                      onOpen={() => open(i)}
                      onDownload={() => download.mutate(i)}
                      onRename={() => setRenaming(i)}
                      onMove={(dir) => move(n, dir)}
                      onRemove={async () => {
                        const ok = await confirm({
                          title: `Remove ${i.name}?`,
                          message: "The client won't see it any more. It stays in the feedback history, and you can restore it.",
                          confirmLabel: "Remove",
                        });
                        if (ok) change.mutate(() => removeItem(i.id));
                      }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {manage && removed.length > 0 && (
        <section>
          <button
            type="button"
            onClick={() => setShowRemoved(!showRemoved)}
            aria-expanded={showRemoved}
            className="w-full flex items-center gap-2 pb-2 border-b border-rule text-left text-base font-semibold text-ink hover:text-accent"
          >
            {showRemoved ? <ChevronDown size={16} /> : <ChevronRight size={16} />} Removed
            <span className="text-sm font-medium text-subtle tabular-nums">{removed.length}</span>
          </button>
          {showRemoved && (
            <ul className="divide-y divide-line">
              {removed.map((i) => (
                <li key={i.id} className="-mx-2 px-2 py-3 flex items-center gap-3 rounded-md hover:bg-inset transition-colors">
                  <Thumb item={i} url={urls[fileKey(i) ?? ""] ?? null} drive={drive[fileKey(i) ?? ""]} className="h-10 w-14 shrink-0 opacity-70" iconSize={16} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-base text-ink">{i.name}</div>
                    <div className="text-xs text-muted">Removed {relativeTime(i.removed_at!)}</div>
                  </div>
                  <Button size="sm" variant="ghost" iconLeft={<RotateCcw size={14} />} onClick={() => change.mutate(() => restoreItem(i.id))}>
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {over && manage && (
        <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-accent/10">
          <div className="rounded-xl bg-surface px-6 py-4 text-base font-semibold text-ink shadow-pop">Drop to upload</div>
        </div>
      )}

      {linkOpen && <AddLinkItemModal folder={delivery.id} onClose={() => setLinkOpen(false)} />}
      {driveOpen && <AddDriveModal folder={delivery.id} onClose={() => setDriveOpen(false)} />}
      {renaming && <RenameItemModal item={renaming} onClose={() => setRenaming(null)} />}
      {viewing != null && viewing >= 0 && (
        <ItemViewer delivery={delivery} items={media} index={Math.min(viewing, media.length - 1)} urls={urls} drive={drive} onIndex={setViewing} onClose={() => setViewing(null)} onChanged={onChanged} />
      )}
    </div>
  );
}

function ItemMenu({
  item,
  manage,
  first,
  last,
  onOpen,
  onDownload,
  onRename,
  onMove,
  onRemove,
}: {
  item: DeliveryItem;
  manage: boolean;
  first: boolean;
  last: boolean;
  onOpen: () => void;
  onDownload: () => void;
  onRename: () => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const row = (icon: React.ReactNode, label: string) => (
    <span className="inline-flex items-center gap-2">
      {icon} {label}
    </span>
  );
  return (
    <Menu
      align="right"
      trigger={
        <button type="button" aria-label={`Actions for ${item.name}`} className="-mr-1 h-8 w-8 shrink-0 grid place-items-center rounded-md text-subtle hover:text-ink hover:bg-inset">
          <MoreHorizontal size={16} />
        </button>
      }
    >
      {(close) => (
        <>
          <MenuItem onClick={() => (close(), onOpen())}>
            {item.kind === "link"
              ? row(<ExternalLink size={14} />, "Open link")
              : !previewable(item)
                ? row(<Download size={14} />, "Download")
                : item.kind === "file"
                  ? row(<Eye size={14} />, "Preview")
                  : row(<Eye size={14} />, "View and comments")}
          </MenuItem>
          {fileKey(item) && previewable(item) && <MenuItem onClick={() => (close(), onDownload())}>{row(<Download size={14} />, "Download")}</MenuItem>}
          {manage && (
            <>
              <MenuItem onClick={() => (close(), onRename())}>{row(<Pencil size={14} />, "Rename")}</MenuItem>
              <MenuItem disabled={first} onClick={() => (close(), onMove(-1))}>{row(<ArrowUp size={14} />, "Move up")}</MenuItem>
              <MenuItem disabled={last} onClick={() => (close(), onMove(1))}>{row(<ArrowDown size={14} />, "Move down")}</MenuItem>
              <MenuDivider />
              <MenuItem destructive onClick={() => (close(), onRemove())}>{row(<Trash2 size={14} />, "Remove")}</MenuItem>
            </>
          )}
        </>
      )}
    </Menu>
  );
}

