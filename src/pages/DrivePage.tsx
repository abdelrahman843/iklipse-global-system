import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, isThisYear, isToday } from "date-fns";
import {
  AlertTriangle,
  ChevronRight,
  Download,
  ExternalLink,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  FolderPlus,
  HardDrive,
  Link2,
  MoreHorizontal,
  Presentation,
  RefreshCw,
  Share2,
  Star,
  Upload,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Controls";
import { EmptyState } from "@/components/ui/EmptyState";
import { Hint, Input, Label } from "@/components/ui/Input";
import { Menu, MenuDivider, MenuItem } from "@/components/ui/Menu";
import { Modal } from "@/components/ui/Modal";
import { SearchField } from "@/components/ui/SearchField";
import { Select } from "@/components/ui/Select";
import { PageSpinner, Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { ShareDriveModal } from "@/components/drive/ShareDriveModal";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { fetchConnections } from "@/lib/connectionsApi";
import { useWbPeople } from "@/lib/wb/people";
import {
  DRIVE_OWNER_CAPS,
  MAX_UPLOAD,
  downloadDriveFile,
  driveCapsOf,
  driveCapsText,
  driveSummary,
  fetchDriveFile,
  fetchDriveSharedWithMe,
  fetchFileAccess,
  fileAccessKey,
  fileSize,
  googleOnly,
  isGoogleDoc,
  listDrive,
  makeFolder,
  renameDriveFile,
  shareDriveItem,
  starDriveFile,
  trashDriveFiles,
  uploadDriveFile,
  type DriveCaps,
  type DriveFile,
  type DriveView as View,
} from "@/lib/driveApi";

// -----------------------------------------------------------------------------
// Drive: the Google Drive accounts this person connected (Connected accounts),
// one at a time. The shared view (on the Shared page) is the same browser over
// the Drives, files and folders others shared with them, limited to what each
// owner allows. Folders open in place with a path above; files open in a
// preview (Google Docs, Sheets and Slides as PDF), or download.
// -----------------------------------------------------------------------------

export interface DriveBox {
  /** The Drive account's id. */
  id: string;
  email: string;
  /** In the account picker. */
  label: string;
  caps: DriveCaps;
  /** Shared: whose Drive it is and what I may do. */
  sharedBy?: string;
  capsText?: string;
}

type Crumb = { id: string; name: string };

const VIEWS: { value: View; label: string }[] = [
  { value: "folder", label: "My Drive" },
  { value: "recent", label: "Recent" },
  { value: "starred", label: "Starred" },
];

const when = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return isToday(d) ? format(d, "p") : isThisYear(d) ? format(d, "MMM d") : format(d, "MMM d, yyyy");
};

/** My own Drive accounts (Connected accounts). */
export default function DrivePage() {
  const conns = useQuery({ queryKey: ["connections"], queryFn: fetchConnections });
  const accounts = useMemo(() => conns.data?.drive ?? [], [conns.data]);
  const boxes = useMemo<DriveBox[]>(() => accounts.map((a) => ({ id: a.id, email: a.email, label: a.email, caps: DRIVE_OWNER_CAPS })), [accounts]);
  if (conns.isLoading) return <PageSpinner />;
  if (!accounts.length)
    return (
      <div className="p-6">
        <EmptyState
          icon={<HardDrive size={28} />}
          title="No Google Drive connected yet"
          description="Connect one or more Google Drive accounts and their files show up here."
          action={
            <Link to="/connections">
              <Button variant="primary">Connect Drive</Button>
            </Link>
          }
        />
      </div>
    );
  return <DriveBrowser boxes={boxes} title="Drive" />;
}

/** Drives, files and folders other people shared with me (0054), for the Shared page. */
export function SharedDriveView() {
  const shared = useQuery({ queryKey: ["drive-shared-with-me"], queryFn: fetchDriveSharedWithMe, refetchOnWindowFocus: true, refetchInterval: 60_000 });
  const boxes = useMemo<DriveBox[]>(
    () =>
      (shared.data ?? []).map((s) => ({
        id: s.account_id,
        email: s.email,
        label: `${s.email} · ${s.owner_name}`,
        caps: driveCapsOf(s.access, s.can_edit),
        sharedBy: s.owner_name,
        capsText: driveCapsText(s.access, s.can_edit),
      })),
    [shared.data],
  );
  if (shared.isLoading) return <PageSpinner />;
  if (!boxes.length)
    return (
      <EmptyState
        icon={<Users size={28} />}
        title="No files shared with you yet"
        description="When someone shares their Google Drive, or a file or folder from it, with you, it shows up here."
      />
    );
  return <DriveBrowser boxes={boxes} shared />;
}

function DriveBrowser({ boxes, shared = false, title }: { boxes: DriveBox[]; shared?: boolean; title?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [account, setAccount] = useState(boxes[0]!.id);
  const box = boxes.find((b) => b.id === account) ?? boxes[0]!;
  const { caps } = box;
  const rootName = caps.readAll ? (shared ? `${box.sharedBy ?? "Their"}'s Drive` : "My Drive") : "Shared with you";
  const [view, setView] = useState<View>("folder");
  const [path, setPath] = useState<Crumb[]>([{ id: "root", name: rootName }]);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [preview, setPreview] = useState<DriveFile | null>(null);
  const [naming, setNaming] = useState<{ kind: "folder" } | { kind: "rename"; file: DriveFile } | null>(null);
  const [sharing, setSharing] = useState<DriveFile | null>(null);
  // Google Drive's own Share screen (a file, a folder, or the open folder).
  const [googleShare, setGoogleShare] = useState<{ id: string; name: string } | null>(null);
  const [uploads, setUploads] = useState<{ total: number; done: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // An account that was disconnected (or stopped being shared) meanwhile.
  useEffect(() => {
    if (!boxes.some((b) => b.id === account)) setAccount(boxes[0]!.id);
  }, [account, boxes]);

  // Another account starts at its top.
  useEffect(() => {
    setPath([{ id: "root", name: rootName }]);
    setView("folder");
    setQ("");
    setSearch("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  const folder = path[path.length - 1]!;
  const inFolder = view === "folder";
  // The open folder can be shared (not the top, not Recent or Starred).
  const inSubfolder = inFolder && folder.id !== "root";
  // Only-some-files: nothing can be added at the top (it's the picked list).
  const canAdd = caps.write && inFolder && (caps.readAll || folder.id !== "root");

  const listKey = ["drive", shared ? "shared" : "own", account, view, inFolder ? folder.id : "", search] as const;
  const list = useInfiniteQuery({
    queryKey: listKey,
    queryFn: ({ pageParam }) => listDrive({ account, folder: inFolder ? folder.id : undefined, view, q: search || undefined, page: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next ?? undefined,
    // Changes made in Google Drive itself, or by the people it's shared with.
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });
  const files = useMemo(() => {
    const seen = new Set<string>();
    return (list.data?.pages ?? []).flatMap((p) => p.files).filter((f) => (seen.has(f.ref) ? false : (seen.add(f.ref), true)));
  }, [list.data]);

  const summary = useQuery({ queryKey: ["drive-summary"], queryFn: driveSummary, enabled: !shared, staleTime: 5 * 60_000 });
  const quota = !shared ? summary.data?.find((s) => s.id === account) : undefined;

  const refresh = () => void qc.invalidateQueries({ queryKey: ["drive"] });

  const open = (f: DriveFile) => {
    if (f.folder) {
      setView("folder");
      setSearch("");
      setQ("");
      // From Recent, Starred or a whole-Drive search the folder could be
      // anywhere: its path starts again from the top.
      const anywhere = !inFolder || (search !== "" && folder.id === "root" && caps.readAll);
      setPath((p) => (anywhere ? [p[0]!, { id: f.id, name: f.name }] : [...p, { id: f.id, name: f.name }]));
    } else setPreview(f);
  };

  const star = useMutation({
    mutationFn: (f: DriveFile) => starDriveFile(account, f.ref, !f.starred),
    onSuccess: refresh,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't star it", description: e.message }),
  });
  const trash = useMutation({
    mutationFn: (f: DriveFile) => trashDriveFiles(account, [f.ref]),
    onSuccess: (_d, f) => {
      toast.push({ kind: "success", title: `${f.name} moved to the trash`, description: "It can be restored from Google Drive's trash." });
      refresh();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't delete it", description: e.message }),
  });
  const download = useMutation({
    mutationFn: (f: DriveFile) => downloadDriveFile(account, f),
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't download it", description: e.message }),
  });
  // Google Drive's link, without the Share screen. The list has it for files
  // and folders; the open folder (and a shortcut's target) asks for it.
  const copyLink = useMutation({
    mutationFn: async (t: { id: string; link?: string | null }) =>
      t.link || (await qc.fetchQuery({ queryKey: fileAccessKey(account, t.id), queryFn: () => fetchFileAccess(account, t.id), staleTime: 60_000 })).link,
    onSuccess: (link) => {
      if (!link) return void toast.push({ kind: "error", title: "Google Drive has no link for it" });
      navigator.clipboard.writeText(link).then(
        () => toast.push({ kind: "success", title: "Link copied" }),
        () => toast.push({ kind: "error", title: "Couldn't copy", description: link }),
      );
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't get the link", description: e.message }),
  });

  const uploadAll = async (list: FileList | File[]) => {
    const picked = [...list];
    if (!picked.length || !canAdd) return;
    const tooBig = picked.filter((f) => f.size > MAX_UPLOAD);
    for (const f of tooBig) toast.push({ kind: "error", title: `${f.name} is too big`, description: "Files up to 50 MB can be uploaded here." });
    const ok = picked.filter((f) => f.size <= MAX_UPLOAD);
    if (!ok.length) return;
    setUploads({ total: ok.length, done: 0 });
    let failed = 0;
    for (const f of ok) {
      try {
        await uploadDriveFile(account, folder.id, f);
      } catch (e) {
        failed++;
        toast.push({ kind: "error", title: `Couldn't upload ${f.name}`, description: (e as Error).message });
      }
      setUploads((u) => (u ? { ...u, done: u.done + 1 } : u));
    }
    setUploads(null);
    if (ok.length - failed > 0) toast.push({ kind: "success", title: ok.length - failed === 1 ? "Uploaded" : `${ok.length - failed} files uploaded` });
    refresh();
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) void uploadAll(e.dataTransfer.files);
  };

  const errMsg = (list.error as Error | null)?.message ?? "";

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Top bar */}
      <div className="shrink-0 border-b border-border bg-surface px-3 sm:px-4 py-2.5 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          {title ? (
            <div className="mr-auto min-w-0">
              <h1 className="text-lg sm:text-xl font-bold text-ink tracking-[-0.02em]">{title}</h1>
              {quota && quota.limit != null && (
                <div className="text-xs text-subtle">
                  {fileSize(quota.used)} of {fileSize(quota.limit)} used
                </div>
              )}
            </div>
          ) : (
            <div className="mr-auto min-w-0 text-xs text-muted flex flex-wrap items-center gap-x-2 gap-y-1">
              {box.sharedBy && (
                <>
                  <span className="truncate">
                    <span className="text-ink font-medium">{box.email}</span>, shared by {box.sharedBy}
                  </span>
                  {box.capsText && <Badge tone="neutral">{box.capsText}</Badge>}
                </>
              )}
            </div>
          )}
          <Button variant="ghost" size="sm" aria-label="Refresh" title="Refresh" onClick={() => void list.refetch()} className="max-sm:h-10 max-sm:w-10">
            <RefreshCw size={14} className={cn(list.isFetching && "animate-spin")} />
          </Button>
          {inSubfolder && (
            <>
              <Button
                variant="ghost"
                size="sm"
                iconLeft={<Link2 size={14} />}
                loading={copyLink.isPending && copyLink.variables?.id === folder.id}
                className="max-sm:h-10"
                title="Copy link"
                onClick={() => copyLink.mutate({ id: folder.id })}
              >
                <span className="max-sm:sr-only">Copy link</span>
              </Button>
              <Button
                variant="secondary"
                size="sm"
                iconLeft={<UserPlus size={14} />}
                className="max-sm:h-10"
                onClick={() => setGoogleShare({ id: folder.id, name: folder.name })}
              >
                <span className="max-sm:sr-only">Share</span>
              </Button>
            </>
          )}
          {canAdd && (
            <>
              <Button variant="secondary" size="sm" iconLeft={<FolderPlus size={14} />} className="max-sm:h-10" onClick={() => setNaming({ kind: "folder" })}>
                <span className="max-sm:sr-only">New folder</span>
              </Button>
              <Button
                variant="primary"
                size="sm"
                iconLeft={<Upload size={14} />}
                loading={!!uploads}
                className="max-sm:h-10"
                onClick={() => fileInput.current?.click()}
              >
                {uploads ? `${uploads.done} of ${uploads.total}` : "Upload"}
              </Button>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) void uploadAll(e.target.files);
                  e.target.value = "";
                }}
              />
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {boxes.length > 1 && (
            <Select value={account} onChange={setAccount} options={boxes.map((b) => ({ value: b.id, label: b.label }))} aria-label="Account" className="w-full sm:w-72" />
          )}
          {caps.readAll && (
            <div className="overflow-x-auto max-w-full">
              <Segmented
                value={view}
                options={VIEWS.map((v) => (v.value === "folder" ? { ...v, label: rootName } : v))}
                onChange={(v) => {
                  setView(v);
                  setPath([{ id: "root", name: rootName }]);
                }}
              />
            </div>
          )}
          <form
            className="flex-1 min-w-[12rem]"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(q.trim());
            }}
          >
            <SearchField
              value={q}
              onChange={(v) => (setQ(v), v === "" && setSearch(""))}
              placeholder={inFolder && folder.id !== "root" ? `Search in ${folder.name}` : "Search files"}
              aria-label="Search files"
            />
          </form>
        </div>
      </div>

      {/* Where I am */}
      {inFolder && (
        <nav aria-label="Folder path" className="shrink-0 px-3 sm:px-4 py-2 border-b border-line bg-bg flex items-center gap-1 overflow-x-auto text-sm">
          {path.map((c, i) => (
            <span key={`${c.id}:${i}`} className="flex items-center gap-1 shrink-0">
              {i > 0 && <ChevronRight size={14} className="text-subtle" />}
              {i === path.length - 1 ? (
                <span className="px-1.5 py-0.5 font-medium text-ink truncate max-w-[14rem]" aria-current="page">
                  {c.name}
                </span>
              ) : (
                <button type="button" onClick={() => setPath((p) => p.slice(0, i + 1))} className="px-1.5 py-0.5 rounded-md text-muted hover:text-ink hover:bg-inset truncate max-w-[14rem]">
                  {c.name}
                </button>
              )}
            </span>
          ))}
          {search && <span className="ml-2 shrink-0 text-xs text-subtle">Results for "{search}"</span>}
        </nav>
      )}

      {/* Files */}
      <div
        className={cn("relative flex-1 min-h-0 overflow-y-auto", dragging && "ring-2 ring-inset ring-accent bg-accent-soft/40")}
        onDragOver={(e) => {
          if (!canAdd || !e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={canAdd ? onDrop : undefined}
      >
        {list.isLoading ? (
          <div className="py-14">
            <PageSpinner />
          </div>
        ) : list.error && !files.length ? (
          <EmptyState
            icon={<AlertTriangle size={26} />}
            title="Couldn't load the files"
            description={errMsg}
            action={
              !shared && /connected again/i.test(errMsg) ? (
                <Link to="/connections">
                  <Button variant="primary">Connect it again</Button>
                </Link>
              ) : undefined
            }
          />
        ) : !files.length ? (
          <EmptyState
            icon={<Folder size={26} />}
            title={search ? "Nothing matches" : view === "starred" ? "Nothing starred" : "Nothing here yet"}
            description={canAdd && !search ? "Drop files here, or press Upload." : undefined}
          />
        ) : (
          // Keyed on where you are, so opening a folder brings its files in fresh.
          <div key={`${account}:${view}:${inFolder ? folder.id : ""}`} role="table" aria-label="Files" className="view-enter min-w-0">
            <div role="row" className="hidden sm:grid grid-cols-[minmax(0,1fr)_7rem_6rem_2.5rem] gap-3 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-subtle border-b border-line">
              <span role="columnheader">Name</span>
              <span role="columnheader">Modified</span>
              <span role="columnheader" className="text-right">
                Size
              </span>
              <span role="columnheader" className="sr-only">
                Actions
              </span>
            </div>
            <ul className="divide-y divide-line">
              {files.map((f, i) => (
                <li key={f.ref} role="row" style={{ "--i": Math.min(i, 12) } as React.CSSProperties} className="rise group grid grid-cols-[minmax(0,1fr)_2.5rem] sm:grid-cols-[minmax(0,1fr)_7rem_6rem_2.5rem] gap-3 items-center px-3 sm:px-4 hover:bg-inset transition-colors">
                  <button type="button" role="cell" onClick={() => open(f)} className="flex items-center gap-3 min-w-0 py-2.5 text-left">
                    <KindIcon f={f} />
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span className="truncate text-sm text-ink">{f.name}</span>
                        {f.starred && <Star size={12} className="shrink-0 text-warn fill-current" aria-label="Starred" />}
                      </span>
                      <span className="sm:hidden block text-xs text-subtle truncate">
                        {[when(f.modified), fileSize(f.size)].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                  </button>
                  <span role="cell" className="hidden sm:block text-xs text-muted">
                    {when(f.modified)}
                  </span>
                  <span role="cell" className="hidden sm:block text-xs text-muted text-right tabular-nums">
                    {f.folder ? "" : fileSize(f.size)}
                  </span>
                  <span role="cell" className="flex justify-end">
                    <Menu
                      align="right"
                      trigger={
                        <button
                          type="button"
                          aria-label={`Actions for ${f.name}`}
                          className="h-9 w-9 grid place-items-center rounded-md text-subtle hover:text-ink hover:bg-surface sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                        >
                          <MoreHorizontal size={16} />
                        </button>
                      }
                    >
                      {(close) => (
                        <>
                          <MenuItem onClick={() => (close(), open(f))}>{f.folder ? "Open" : "Preview"}</MenuItem>
                          {!f.folder && !googleOnly(f) && <MenuItem onClick={() => (close(), download.mutate(f))}>Download</MenuItem>}
                          {!shared && f.link && (
                            <MenuItem onClick={() => (close(), window.open(f.link!, "_blank", "noopener"))}>Open in Google Drive</MenuItem>
                          )}
                          <MenuDivider />
                          <MenuItem onClick={() => (close(), setGoogleShare({ id: f.id, name: f.name }))}>Share</MenuItem>
                          <MenuItem onClick={() => (close(), copyLink.mutate({ id: f.id, link: f.shortcut ? null : f.link }))}>Copy link</MenuItem>
                          {!shared && <MenuItem onClick={() => (close(), setSharing(f))}>Share in iklipse</MenuItem>}
                          {(caps.write || caps.manage) && <MenuDivider />}
                          {caps.write && <MenuItem onClick={() => (close(), setNaming({ kind: "rename", file: f }))}>Rename</MenuItem>}
                          {caps.manage && <MenuItem onClick={() => (close(), star.mutate(f))}>{f.starred ? "Remove star" : "Star"}</MenuItem>}
                          {caps.manage && (
                            <MenuItem
                              destructive
                              onClick={async () => {
                                close();
                                const ok = await confirm({
                                  title: `Delete ${f.name}?`,
                                  message: f.folder
                                    ? "The folder and everything in it go to Google Drive's trash, where they can be restored."
                                    : "It goes to Google Drive's trash, where it can be restored.",
                                  confirmLabel: "Delete",
                                  danger: true,
                                });
                                if (ok) trash.mutate(f);
                              }}
                            >
                              Delete
                            </MenuItem>
                          )}
                        </>
                      )}
                    </Menu>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {list.hasNextPage && (
          <div className="p-3 flex justify-center">
            <Button variant="secondary" size="sm" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              Load more
            </Button>
          </div>
        )}
      </div>

      {preview && (
        <PreviewModal
          account={account}
          file={preview}
          email={shared ? undefined : box.email}
          ownLink={!shared}
          onDownload={() => download.mutate(preview)}
          downloading={download.isPending}
          onClose={() => setPreview(null)}
        />
      )}
      {naming && (
        <NameModal
          title={naming.kind === "folder" ? "New folder" : "Rename"}
          initial={naming.kind === "rename" ? naming.file.name : ""}
          action={naming.kind === "folder" ? "Make folder" : "Rename"}
          onSave={async (name) => {
            if (naming.kind === "folder") await makeFolder(account, folder.id, name);
            else await renameDriveFile(account, naming.file.ref, name);
            refresh();
          }}
          onClose={() => setNaming(null)}
        />
      )}
      {sharing && <ShareItemModal account={account} file={sharing} onClose={() => setSharing(null)} />}
      {googleShare && <ShareDriveModal account={account} id={googleShare.id} name={googleShare.name} onClose={() => setGoogleShare(null)} />}
    </div>
  );
}

/** An icon for the kind of file. */
function kindOf(f: DriveFile): { Icon: LucideIcon; tone: string } {
  const m = f.mime;
  if (f.folder) return { Icon: Folder, tone: "text-warn" };
  if (m === "application/vnd.google-apps.spreadsheet" || /spreadsheet|excel|csv/.test(m)) return { Icon: FileSpreadsheet, tone: "text-success" };
  if (m === "application/vnd.google-apps.presentation" || /presentation|powerpoint/.test(m)) return { Icon: Presentation, tone: "text-warn" };
  if (m === "application/pdf") return { Icon: FileText, tone: "text-danger" };
  if (m.startsWith("image/") || m === "application/vnd.google-apps.drawing") return { Icon: FileImage, tone: "text-accent" };
  if (m.startsWith("video/")) return { Icon: FileVideo, tone: "text-accent" };
  if (m.startsWith("audio/")) return { Icon: FileAudio, tone: "text-accent" };
  if (/zip|compressed|tar|rar|7z/.test(m)) return { Icon: FileArchive, tone: "text-muted" };
  if (/json|javascript|xml|html|x-python|x-sh/.test(m)) return { Icon: FileCode, tone: "text-muted" };
  if (m === "application/vnd.google-apps.document" || /word|text\//.test(m)) return { Icon: FileText, tone: "text-accent" };
  return { Icon: FileIcon, tone: "text-muted" };
}

function KindIcon({ f }: { f: DriveFile }) {
  const { Icon, tone } = kindOf(f);
  return (
    <span className="h-8 w-8 shrink-0 grid place-items-center rounded-md bg-inset border border-line">
      <Icon size={16} className={tone} />
    </span>
  );
}

const PREVIEW_MAX = 30 * 1024 * 1024;

type Shown = { kind: "image" | "pdf" | "video" | "audio"; url: string } | { kind: "text"; text: string } | { kind: "none"; why: string };

/** How a file shows when loaded here (Google files as PDF); null: no preview here. */
function hereKind(f: DriveFile): "image" | "pdf" | "video" | "audio" | "text" | null {
  const m = f.mime;
  return isGoogleDoc(f)
    ? "pdf"
    : m.startsWith("image/")
      ? "image"
      : m === "application/pdf"
        ? "pdf"
        : m.startsWith("video/")
          ? "video"
          : m.startsWith("audio/")
            ? "audio"
            : m.startsWith("text/") || /json|xml|javascript|csv/.test(m)
              ? "text"
              : null;
}

/**
 * A file opened in place. Google shows it (Drive's own preview page in a
 * frame), so no bytes go through our server; the browser needs a Google
 * account that can open the file. "Load here instead" fetches the file through
 * the drive function as before: images, PDFs (and Google files as PDF), video,
 * audio, text, up to PREVIEW_MAX.
 */
function PreviewModal({
  account,
  file,
  email,
  ownLink,
  onDownload,
  downloading,
  onClose,
}: {
  account: string;
  file: DriveFile;
  /** The Drive account's email, when it's mine (sign in to Google as it). */
  email?: string;
  ownLink: boolean;
  onDownload: () => void;
  downloading: boolean;
  onClose: () => void;
}) {
  const [here, setHere] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const canHere = !googleOnly(file) && !!hereKind(file);
  const dark = /^(image|video|audio)\//.test(file.mime);

  return (
    <Modal
      open
      onClose={onClose}
      title={<span className="block truncate">{file.name}</span>}
      size="xl"
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          {ownLink && file.link && (
            <a href={file.link} target="_blank" rel="noopener noreferrer">
              <Button variant="ghost" iconLeft={<ExternalLink size={14} />}>
                Open in Google Drive
              </Button>
            </a>
          )}
          {!googleOnly(file) && (
            <Button variant="primary" iconLeft={<Download size={14} />} loading={downloading} onClick={onDownload}>
              Download
            </Button>
          )}
        </div>
      }
    >
      {here ? (
        <>
          <HerePreview account={account} file={file} />
          <div className="mt-2 flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => (setLoaded(false), setHere(false))}>
              Use Google's preview
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className={cn("relative rounded-md border border-line overflow-hidden", dark ? "bg-black" : "bg-inset")}>
            <iframe
              src={`https://drive.google.com/file/d/${encodeURIComponent(file.id)}/preview`}
              title={file.name}
              allow="autoplay; fullscreen"
              allowFullScreen
              onLoad={() => setLoaded(true)}
              className="block w-full h-[70vh]"
            />
            {!loaded && (
              <div className="absolute inset-0 grid place-items-center text-subtle pointer-events-none">
                <Spinner size={20} />
              </div>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-start gap-x-3 gap-y-2">
            <p className="flex-1 min-w-[14rem] text-xs text-subtle">
              Google shows this preview. If it asks for access, sign in{" "}
              {email ? (
                <>
                  to Google as <span className="text-muted">{email}</span>
                </>
              ) : (
                "to the right Google account"
              )}{" "}
              in this browser, or share the file with Anyone with the link.
            </p>
            {canHere && (
              <Button variant="secondary" size="sm" onClick={() => setHere(true)}>
                Load here instead
              </Button>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

/** The file's bytes through the drive function, shown here (only on demand). */
function HerePreview({ account, file }: { account: string; file: DriveFile }) {
  const kind = hereKind(file);
  const tooBig = !isGoogleDoc(file) && (file.size ?? 0) > (kind === "text" ? 1024 * 1024 : PREVIEW_MAX);
  const q = useQuery({
    queryKey: ["drive-preview", account, file.id],
    enabled: !!kind && !tooBig && !googleOnly(file),
    staleTime: 60_000,
    gcTime: 0,
    queryFn: async (): Promise<Shown> => {
      const blob = await fetchDriveFile(account, file, isGoogleDoc(file) ? "pdf" : undefined);
      if (kind === "text") return { kind: "text", text: (await blob.text()).slice(0, 200_000) };
      return { kind: kind as "image" | "pdf" | "video" | "audio", url: URL.createObjectURL(blob) };
    },
  });
  // Blob URLs are freed when the preview closes.
  useEffect(() => {
    const d = q.data;
    return () => {
      if (d && "url" in d) URL.revokeObjectURL(d.url);
    };
  }, [q.data]);

  const shown: Shown | undefined = googleOnly(file)
    ? { kind: "none", why: "This kind of Google file only opens in Google Drive." }
    : !kind
      ? { kind: "none", why: "There's no preview for this kind of file." }
      : tooBig
        ? { kind: "none", why: "Too big to preview here." }
        : q.data;

  return (
    <div className="min-h-[50vh] grid place-items-center rounded-md bg-inset border border-line overflow-hidden">
      {q.isLoading && !shown ? (
        <PageSpinner />
      ) : q.error ? (
        <EmptyState title="Couldn't open it" description={(q.error as Error).message} />
      ) : !shown ? null : shown.kind === "image" ? (
        <img src={shown.url} alt={file.name} className="max-h-[70vh] max-w-full object-contain" />
      ) : shown.kind === "pdf" ? (
        <iframe src={shown.url} title={file.name} className="w-full h-[70vh] bg-white" />
      ) : shown.kind === "video" ? (
        <video src={shown.url} controls className="max-h-[70vh] max-w-full" />
      ) : shown.kind === "audio" ? (
        <audio src={shown.url} controls className="w-full max-w-md" />
      ) : shown.kind === "text" ? (
        <pre className="w-full h-[70vh] overflow-auto p-4 text-xs text-ink whitespace-pre-wrap break-words self-start">{shown.text}</pre>
      ) : shown.kind === "none" ? (
        <EmptyState icon={<FileIcon size={26} />} title="No preview" description={shown.why} />
      ) : null}
    </div>
  );
}

/** New folder / rename. */
function NameModal({
  title,
  initial,
  action,
  onSave,
  onClose,
}: {
  title: string;
  initial: string;
  action: string;
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(initial);
  const save = useMutation({
    mutationFn: () => onSave(name.trim()),
    onSuccess: onClose,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't save", description: e.message }),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="drive-name" disabled={!name.trim() || name.trim() === initial} loading={save.isPending}>
            {action}
          </Button>
        </div>
      }
    >
      <form
        id="drive-name"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && name.trim() !== initial) save.mutate();
        }}
      >
        <Label htmlFor="drive-name-input">Name</Label>
        <Input id="drive-name-input" autoFocus value={name} maxLength={255} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
      </form>
    </Modal>
  );
}

/** Share one file or folder of my Drive with someone (the Shared page on their side). */
function ShareItemModal({ account, file, onClose }: { account: string; file: DriveFile; onClose: () => void }) {
  const { user } = useAuth();
  const people = useWbPeople();
  const qc = useQueryClient();
  const toast = useToast();
  const [who, setWho] = useState("");
  const list = (people.data?.list ?? []).filter((p) => p.is_active && p.id !== user?.id);
  const name = list.find((p) => p.id === who)?.display_name ?? "They";
  const share = useMutation({
    mutationFn: () => shareDriveItem({ account, grantee: who, file }),
    onSuccess: (r) => {
      toast.push(
        r === "added"
          ? { kind: "success", title: `Shared with ${name}`, description: "It's on their Shared page." }
          : { kind: "success", title: `${name} can already open it` },
      );
      void qc.invalidateQueries({ queryKey: ["drive-shares"] });
      onClose();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't share", description: e.message }),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={`Share ${file.folder ? "this folder" : "this file"}`}
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" iconLeft={<Share2 size={14} />} disabled={!who} loading={share.isPending} onClick={() => share.mutate()}>
            Share
          </Button>
        </div>
      }
    >
      <div className="mb-4 flex items-center gap-2 rounded-md border border-line bg-inset px-3 py-2 text-sm text-ink">
        <KindIcon f={file} />
        <span className="truncate">{file.name}</span>
      </div>
      <p className="text-sm text-muted mb-4">
        {file.folder
          ? "They see this folder and everything in it on their Shared page. Nothing else from this Drive."
          : "They see this file on their Shared page. Nothing else from this Drive."}
      </p>
      <Label>With</Label>
      <Select
        value={who}
        onChange={setWho}
        placeholder={people.isLoading ? "Loading…" : "Pick someone"}
        options={list.map((p) => ({ value: p.id, label: p.display_name, icon: <Avatar src={p.avatar_url} name={p.display_name} size={18} /> }))}
        searchable
        className="w-full"
      />
      <Hint>To let them upload into it, or to share the whole Drive, use Connected accounts, Sharing.</Hint>
    </Modal>
  );
}
