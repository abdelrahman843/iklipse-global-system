import { useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  HardDrive,
  Mail,
  MoreHorizontal,
  Receipt,
  RefreshCw,
  Settings,
  Sheet,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input, Label, Hint } from "@/components/ui/Input";
import { DateField } from "@/components/ui/DateField";
import { Modal } from "@/components/ui/Modal";
import { Menu, MenuDivider, MenuItem } from "@/components/ui/Menu";
import { LineTabs, type LineTab } from "@/components/ui/LineTabs";
import { SearchField } from "@/components/ui/SearchField";
import { Select } from "@/components/ui/Select";
import { Toggle } from "@/components/ui/Controls";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSpinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { ROWS, Section, Stat, StatStrip } from "@/components/ui/Section";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import {
  addInvoiceSource,
  addInvoiceTarget,
  dismissInvoice,
  exportInvoices,
  fetchInvoicesMonth,
  fetchInvoicesNeedingFiles,
  fetchInvoicesOverview,
  gmailLink,
  invoicesCsv,
  money,
  monthLabel,
  removeInvoiceSource,
  removeInvoiceTarget,
  rereadInvoice,
  runInvoices,
  saveInvoiceSettings,
  shiftMonth,
  thisMonth,
  totals,
  uploadInvoiceFile,
  type Invoice,
  type InvoicesOverview,
} from "@/lib/invoicesApi";

// -----------------------------------------------------------------------------
// Invoices (admins): the invoice and refund emails read from the Gmail
// accounts picked in Settings, a month at a time (this month first, back
// through earlier ones). Each one says which mailbox it came to, who sent it,
// who bought it, its date, amount and currency, and opens its files in Drive.
// The month goes out as a Google Sheet (in that month's Drive folder) or CSV.
// Invoices that came as a link wait in "Need a file" (every month together)
// until someone downloads the file and uploads it here.
// ?month=2026-07 opens a month, ?tab=files the waiting ones (notifications
// link there).
// -----------------------------------------------------------------------------

type Tab = "invoices" | "refunds" | "files" | "other";
const TABS: Tab[] = ["invoices", "refunds", "files", "other"];
const ACCEPT = "application/pdf,image/png,image/jpeg,image/webp,.pdf";
const MAX_UPLOAD = 10 * 1024 * 1024;

const day = (d: string | null) =>
  d ? new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "No date";

export default function InvoicesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const now = thisMonth();
  const asked = params.get("month");
  const month = asked && /^\d{4}-\d{2}$/.test(asked) && asked <= now ? asked : now;
  const askedTab = params.get("tab") as Tab | null;
  const tab: Tab = askedTab && TABS.includes(askedTab) ? askedTab : "invoices";
  const go = (m: string, t: Tab) => {
    const next: Record<string, string> = {};
    if (m !== now) next.month = m;
    if (t !== "invoices") next.tab = t;
    setParams(next, { replace: true });
  };
  const setMonth = (m: string) => go(m, tab);
  const setTab = (t: Tab) => go(month, t);
  const [q, setQ] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const overview = useQuery({ queryKey: ["invoices-overview"], queryFn: fetchInvoicesOverview, refetchInterval: 30_000 });
  const list = useQuery({ queryKey: ["invoices-month", month], queryFn: () => fetchInvoicesMonth(month), refetchInterval: 30_000 });
  const waiting = useQuery({ queryKey: ["invoices-needing-files"], queryFn: fetchInvoicesNeedingFiles, refetchInterval: 30_000 });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["invoices-month"] });
    void qc.invalidateQueries({ queryKey: ["invoices-overview"] });
    void qc.invalidateQueries({ queryKey: ["invoices-needing-files"] });
  };

  const run = useMutation({
    mutationFn: runInvoices,
    onSuccess: (r) => {
      refresh();
      if (r.stop && !r.done && !r.skipped && !r.failed) toast.push({ kind: "error", title: "Didn't read anything", description: r.stop });
      else
        toast.push({
          kind: r.failed ? "error" : "success",
          title: r.done ? `${r.done} new ${r.done === 1 ? "one" : "ones"} filed` : "Nothing new",
          description:
            [r.waiting && `${r.waiting} came as a link (Need a file)`, r.skipped && `${r.skipped} weren't invoices`, r.failed && `${r.failed} couldn't be read`, r.stop]
              .filter(Boolean)
              .join(". ") || undefined,
        });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't check the email", description: e.message }),
  });

  const exportSheet = useMutation({
    mutationFn: (account?: string) => exportInvoices(month, account),
    onSuccess: (link) => {
      window.open(link, "_blank", "noopener");
      toast.push({ kind: "success", title: "The Google Sheet is ready", description: `In the ${monthLabel(month)} folder in Drive.` });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't make the sheet", description: e.message }),
  });

  const reread = useMutation({
    mutationFn: rereadInvoice,
    onSuccess: () => {
      refresh();
      toast.push({ kind: "success", title: "It'll be read again in the next run", description: "Within a couple of minutes." });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't do that", description: e.message }),
  });

  const upload = useMutation({
    mutationFn: ({ r, file }: { r: Invoice; file: File }) => {
      if (file.size > MAX_UPLOAD) throw new Error("Files up to 10 MB");
      return uploadInvoiceFile(r.id, file);
    },
    onSuccess: (res, { r }) => {
      refresh();
      toast.push({
        kind: "success",
        title: `${r.provider ?? "The invoice"} was filed`,
        description: `Under ${monthLabel(res.month)}, with its file in Drive.`,
        actionLabel: res.month !== month ? "Open the month" : undefined,
        onAction: res.month !== month ? () => go(res.month, r.is_refund ? "refunds" : "invoices") : undefined,
      });
    },
    onError: (e: Error, { r }) => toast.push({ kind: "error", title: `Couldn't file ${r.provider ?? "it"}`, description: e.message }),
  });
  const uploading = upload.isPending ? upload.variables?.r.id : null;

  const dismiss = useMutation({
    mutationFn: dismissInvoice,
    onSuccess: refresh,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't remove it", description: e.message }),
  });

  const rows = list.data ?? [];
  const done = rows.filter((r) => r.status === "done");
  const byTab: Record<Tab, Invoice[]> = {
    invoices: done.filter((r) => !r.is_refund),
    refunds: done.filter((r) => r.is_refund),
    files: waiting.data ?? [],
    other: rows.filter((r) => r.status !== "done"),
  };
  const needle = q.trim().toLowerCase();
  const shown = useMemo(
    () =>
      byTab[tab].filter(
        (r) =>
          !needle ||
          [r.provider, r.description, r.invoice_number, r.purchaser_email, r.mailbox, r.sender_email, r.sender_name, r.subject, r.currency]
            .filter(Boolean)
            .some((x) => x!.toLowerCase().includes(needle)),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, waiting.data, tab, needle],
  );

  const tabs: LineTab<Tab>[] = [
    { value: "invoices", label: "Invoices", count: byTab.invoices.length },
    { value: "refunds", label: "Refunds", count: byTab.refunds.length },
    { value: "files", label: "Need a file", count: byTab.files.length },
    { value: "other", label: "Not filed", count: byTab.other.length },
  ];

  const ov = overview.data;
  const targets = ov?.targets ?? [];

  const downloadCsv = () => {
    const blob = new Blob([invoicesCsv(done)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `invoices-${month}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-3 sm:p-4 md:p-6">
        <div className="flex flex-wrap items-start sm:items-center gap-3 mb-4">
          <div className="flex-1 min-w-[12rem]">
            <div className="eyebrow text-subtle mb-1">Administration</div>
            <h1 className="text-2xl sm:text-3xl font-semibold text-ink tracking-tight">Invoices</h1>
            <p className="text-sm text-muted mt-1 hidden sm:block">Invoices and refunds read from email and filed in Drive, a month at a time.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <Button size="sm" iconLeft={<RefreshCw size={14} />} loading={run.isPending} onClick={() => run.mutate()} disabled={!ov?.settings.enabled || !ov.sources.length}>
              Check now
            </Button>
            <Menu
              align="right"
              trigger={
                <Button size="sm" iconLeft={<Download size={14} />} loading={exportSheet.isPending} disabled={!done.length}>
                  Export
                </Button>
              }
            >
              {(close) => (
                <>
                  {targets.length <= 1 ? (
                    <MenuItem disabled={!targets.length} onClick={() => (close(), exportSheet.mutate(targets[0]?.account_id))}>
                      <span className="inline-flex items-center gap-2">
                        <Sheet size={14} /> Google Sheet{targets.length ? "" : " (pick a Drive first)"}
                      </span>
                    </MenuItem>
                  ) : (
                    targets.map((t) => (
                      <MenuItem key={t.account_id} onClick={() => (close(), exportSheet.mutate(t.account_id))}>
                        <span className="inline-flex items-center gap-2">
                          <Sheet size={14} /> Google Sheet in {t.email}
                        </span>
                      </MenuItem>
                    ))
                  )}
                  <MenuDivider />
                  <MenuItem onClick={() => (close(), downloadCsv())}>
                    <span className="inline-flex items-center gap-2">
                      <FileText size={14} /> Download CSV
                    </span>
                  </MenuItem>
                </>
              )}
            </Menu>
            <Button size="sm" iconLeft={<Settings size={14} />} onClick={() => setSettingsOpen(true)}>
              Settings
            </Button>
          </div>
        </div>

        <div className="mb-5 flex flex-col-reverse gap-3 lg:flex-row lg:items-end border-b border-border">
          <LineTabs value={tab} tabs={tabs} onChange={setTab} label="Kinds" bare />
          <SearchField value={q} onChange={setQ} placeholder="Search" className="lg:ml-auto lg:mb-2 lg:w-56" />
        </div>

        <div className="mb-5">
          {tab === "files" ? (
            <div className="text-sm text-muted">Invoices that came as a link, from every month: download each one and upload it here.</div>
          ) : (
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Month before"
              onClick={() => setMonth(shiftMonth(month, -1))}
              className="h-9 w-9 grid place-items-center rounded-md border border-border bg-surface text-muted hover:text-ink hover:bg-inset"
            >
              <ChevronLeft size={16} />
            </button>
            <div className="min-w-[9.5rem] text-center text-sm font-semibold text-ink tabular-nums">{monthLabel(month)}</div>
            <button
              type="button"
              aria-label="Month after"
              disabled={month >= now}
              onClick={() => setMonth(shiftMonth(month, 1))}
              className="h-9 w-9 grid place-items-center rounded-md border border-border bg-surface text-muted hover:text-ink hover:bg-inset disabled:opacity-40 disabled:pointer-events-none"
            >
              <ChevronRight size={16} />
            </button>
            {month !== now && (
              <Button size="sm" variant="ghost" onClick={() => setMonth(now)}>
                This month
              </Button>
            )}
          </div>
          )}
        </div>

        <div key={`${tab}:${month}`} className="view-enter space-y-8">
        {ov && <StatusNote ov={ov} onSettings={() => setSettingsOpen(true)} />}

        {(tab === "invoices" || tab === "refunds") && byTab[tab].length > 0 && (
          <StatStrip>
            {totals(byTab[tab]).map((t, i) => (
              <Stat
                key={t.currency}
                className="rise"
                style={{ "--i": Math.min(i, 12) } as React.CSSProperties}
                label={`${tab === "refunds" ? "Refunded" : "Spent"}${t.currency ? ` in ${t.currency}` : ""}`}
                value={money(t.amount, t.currency || null)}
              />
            ))}
            <Stat
              className="rise"
              style={{ "--i": Math.min(totals(byTab[tab]).length, 12) } as React.CSSProperties}
              label={tab === "refunds" ? "Refunds" : "Invoices"}
              value={byTab[tab].length}
            />
          </StatStrip>
        )}

        {(tab === "files" ? waiting : list).isLoading ? (
          <PageSpinner />
        ) : !(tab === "files" ? waiting : list).data && (tab === "files" ? waiting : list).error ? (
          <EmptyState
            icon={<AlertTriangle size={20} />}
            title="Couldn't load the invoices"
            description={((tab === "files" ? waiting : list).error as Error).message}
          />
        ) : !shown.length ? (
          <EmptyState
            icon={<Receipt size={20} />}
            title={
              needle
                ? "Nothing matches"
                : tab === "refunds"
                  ? "No refunds this month"
                  : tab === "files"
                    ? "Nothing to download"
                    : tab === "other"
                      ? "Everything was filed"
                      : "No invoices this month"
            }
            description={
              needle
                ? undefined
                : tab === "files"
                  ? "Invoices that come as a download link, with no file in the email, wait here until someone uploads the file."
                  : tab === "other"
                  ? "Emails that weren't invoices, or couldn't be read, show up here."
                  : "New ones show up here a couple of minutes after they arrive."
            }
          />
        ) : tab === "files" ? (
          <Section title="Need a file" count={shown.length}>
          <div className={ROWS}>
            {shown.map((r, i) => (
              <WaitingRow
                key={r.id}
                i={i}
                r={r}
                busy={uploading === r.id}
                onFile={(file) => upload.mutate({ r, file })}
                onReread={() => reread.mutate(r.id)}
                onDismiss={async () => {
                  if (await confirm({ title: `Not an invoice?`, message: "It goes to Not filed.", confirmLabel: "Remove", danger: true })) dismiss.mutate(r.id);
                }}
              />
            ))}
          </div>
          </Section>
        ) : tab === "other" ? (
          <Section title="Not filed" count={shown.length}>
          <div className={ROWS}>
            {shown.map((r, i) => (
              <OtherRow key={r.id} i={i} r={r} onReread={() => reread.mutate(r.id)} />
            ))}
          </div>
          </Section>
        ) : (
          <Section title={tab === "refunds" ? "Refunds" : "Invoices"} count={shown.length}>
          <div role="table" aria-label={tab === "refunds" ? "Refunds" : "Invoices"}>
            <div
              role="row"
              className="hidden lg:grid grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1.5fr)_minmax(0,1.5fr)_auto] gap-3 py-2 border-b border-line text-sm text-muted"
            >
              <span role="columnheader">Provider</span>
              <span role="columnheader" className="text-right">Amount</span>
              <span role="columnheader">Date</span>
              <span role="columnheader">Bought by</span>
              <span role="columnheader">Came to</span>
              <span role="columnheader" className="w-[4.5rem]" />
            </div>
            <div className="divide-y divide-line">
              {shown.map((r, i) => (
                <InvoiceRow
                  key={r.id}
                  i={i}
                  r={r}
                  busy={uploading === r.id}
                  onFile={(file) => upload.mutate({ r, file })}
                  onReread={async () => {
                    const ok = await confirm({
                      title: `Read ${r.provider ?? "this invoice"} again?`,
                      message: "It leaves the list and its email is read again in the next run, which may file it again with different details.",
                      confirmLabel: "Read it again",
                    });
                    if (ok) reread.mutate(r.id);
                  }}
                  onDismiss={async () => {
                    const ok = await confirm({
                      title: `Remove ${r.provider ?? "this"}?`,
                      message: "It goes to Not filed and leaves the totals. Its files stay in Drive.",
                      confirmLabel: "Remove",
                      danger: true,
                    });
                    if (ok) dismiss.mutate(r.id);
                  }}
                />
              ))}
            </div>
          </div>
          </Section>
        )}
        </div>
      </div>

      {/* Mounted while open, so it starts from the saved settings each time. */}
      {ov && settingsOpen && <SettingsModal open onClose={() => setSettingsOpen(false)} ov={ov} />}
    </div>
  );
}

function StatusNote({ ov, onSettings }: { ov: InvoicesOverview; onSettings: () => void }) {
  const problem = ov.sources.find((s) => s.last_error) ?? null;
  const driveProblem = ov.targets.find((t) => t.last_error) ?? null;
  let text: string | null = null;
  if (!ov.settings.enabled) text = "Reading invoices from email is off.";
  else if (!ov.sources.length) text = "No Gmail account is picked to read invoices from.";
  else if (!ov.targets.length) text = "No Drive is picked: invoices are listed here, but their files aren't saved anywhere.";
  else if (problem) text = `${problem.email}: ${problem.last_error}`;
  else if (driveProblem) text = `${driveProblem.email}: ${driveProblem.last_error}`;
  if (!text) {
    return ov.pending > 0 ? (
      <div className="text-sm text-muted inline-flex items-center gap-2">
        <RefreshCw size={14} className="animate-spin" /> Reading {ov.pending} {ov.pending === 1 ? "email" : "emails"}…
      </div>
    ) : null;
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2.5 text-sm text-ink sm:flex-row sm:items-center sm:justify-between">
      <span className="inline-flex items-start gap-2 min-w-0">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" />
        <span className="break-words">{text}</span>
      </span>
      <Button size="sm" variant="secondary" onClick={onSettings} className="shrink-0 self-start sm:self-auto">
        Open settings
      </Button>
    </div>
  );
}

function FilesLinks({ r }: { r: Invoice }) {
  if (!r.files.length) return <span className="text-xs text-subtle">No file</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {r.files.map((f) =>
        f.link ? (
          <a
            key={`${f.account}-${f.id}`}
            href={f.link}
            target="_blank"
            rel="noopener noreferrer"
            title={`${f.name} in ${f.email}`}
            className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs text-muted hover:text-ink hover:bg-inset"
          >
            <HardDrive size={12} /> File
          </a>
        ) : null,
      )}
    </span>
  );
}

function InvoiceRow({
  r,
  i,
  busy,
  onFile,
  onReread,
  onDismiss,
}: {
  r: Invoice;
  i: number;
  busy: boolean;
  onFile: (f: File) => void;
  onReread: () => void;
  onDismiss: () => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const actions = (
    <Menu
      align="right"
      trigger={
        <button type="button" aria-label={`Actions for ${r.provider ?? "invoice"}`} className="h-9 w-9 grid place-items-center rounded-md text-subtle hover:text-ink hover:bg-inset">
          <MoreHorizontal size={16} />
        </button>
      }
    >
      {(close) => (
        <>
          <MenuItem onClick={() => (close(), window.open(gmailLink(r), "_blank", "noopener"))}>
            <span className="inline-flex items-center gap-2">
              <Mail size={14} /> Open the email in Gmail
            </span>
          </MenuItem>
          {r.files.map((f) =>
            f.link ? (
              <MenuItem key={`${f.account}-${f.id}`} onClick={() => (close(), window.open(f.link!, "_blank", "noopener"))}>
                <span className="inline-flex items-center gap-2 min-w-0">
                  <ExternalLink size={14} className="shrink-0" /> <span className="truncate">Open in {f.email}'s Drive</span>
                </span>
              </MenuItem>
            ) : null,
          )}
          {!r.files.length && (
            <MenuItem disabled={busy} onClick={() => (close(), picker.current?.click())}>
              <span className="inline-flex items-center gap-2">
                <Upload size={14} /> Add the file
              </span>
            </MenuItem>
          )}
          <MenuDivider />
          <MenuItem onClick={() => (close(), onReread())}>
            <span className="inline-flex items-center gap-2">
              <RefreshCw size={14} /> Read it again
            </span>
          </MenuItem>
          <MenuItem destructive onClick={() => (close(), onDismiss())}>
            <span className="inline-flex items-center gap-2">
              <X size={14} /> Not an invoice
            </span>
          </MenuItem>
        </>
      )}
    </Menu>
  );
  const from = r.sender_name || r.sender_email || "Unknown sender";
  return (
    <div role="row" style={{ "--i": Math.min(i, 12) } as React.CSSProperties} className="rise py-3 lg:grid lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1.5fr)_minmax(0,1.5fr)_auto] lg:gap-3 lg:items-center">
      <div role="cell" className="flex items-start justify-between gap-3 min-w-0">
        <div className="min-w-0">
          <div className="font-medium text-ink truncate">{r.provider ?? "Unknown"}</div>
          <div className="text-xs text-muted truncate">{[r.description, r.invoice_number && `No. ${r.invoice_number}`].filter(Boolean).join(" · ") || r.subject}</div>
          <div className="text-xs text-subtle truncate" title={r.sender_email ?? undefined}>
            From {from}
          </div>
        </div>
        <div className="lg:hidden text-right shrink-0">
          <div className="font-semibold text-ink tabular-nums">{money(r.amount, r.currency)}</div>
          <div className="text-xs text-muted">{day(r.invoice_date)}</div>
        </div>
      </div>
      <div role="cell" className="hidden lg:block text-right font-semibold text-ink tabular-nums">
        {money(r.amount, r.currency)}
      </div>
      <div role="cell" className="hidden lg:block text-sm text-muted">
        {day(r.invoice_date)}
      </div>
      <div role="cell" className="mt-2 lg:mt-0 text-sm min-w-0">
        <span className="lg:hidden text-xs text-subtle">Bought by </span>
        <span className="text-ink break-all lg:truncate lg:block">{r.purchaser_email ?? "Not written"}</span>
      </div>
      <div role="cell" className="text-sm min-w-0">
        <span className="lg:hidden text-xs text-subtle">Came to </span>
        <span className="text-muted break-all lg:truncate lg:block">{r.mailbox}</span>
      </div>
      <div role="cell" className="mt-2 lg:mt-0 flex items-center justify-between gap-2 lg:justify-end lg:w-[4.5rem]">
        <span className="lg:hidden">
          <FilesLinks r={r} />
        </span>
        <span className="hidden lg:inline-flex">{r.files.length ? <FilesLinks r={r} /> : null}</span>
        <FilePicker inputRef={picker} onFile={onFile} />
        {busy ? <RefreshCw size={16} className="animate-spin text-muted" aria-label="Uploading" /> : actions}
      </div>
      {r.error && (
        <div className="lg:col-span-6 mt-2 text-xs text-warn inline-flex items-start gap-1.5">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {r.error}
        </div>
      )}
    </div>
  );
}

/** A hidden file input (PDF or picture) that hands over the file picked. */
function FilePicker({ inputRef, onFile }: { inputRef: React.RefObject<HTMLInputElement>; onFile: (f: File) => void }) {
  return (
    <input
      ref={inputRef}
      type="file"
      accept={ACCEPT}
      hidden
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (f) onFile(f);
      }}
    />
  );
}

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "the link";
  }
};

/** An invoice that came as a link: open the link, download it, upload it here (or drop it on the row). */
function WaitingRow({
  r,
  i,
  busy,
  onFile,
  onReread,
  onDismiss,
}: {
  r: Invoice;
  i: number;
  busy: boolean;
  onFile: (f: File) => void;
  onReread: () => void;
  onDismiss: () => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const known: ReactNode[] = [];
  if (r.amount !== null) known.push(money(r.amount, r.currency));
  if (r.invoice_date) known.push(day(r.invoice_date));
  if (r.description) known.push(r.description);
  return (
    <div
      style={{ "--i": Math.min(i, 12) } as React.CSSProperties}
      className={cn("rise py-3 flex flex-col gap-3 sm:flex-row sm:items-center transition-colors", over && "bg-accent/10")}
      onDragOver={(e) => {
        if (busy || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f && !busy) onFile(f);
      }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-ink truncate">{r.provider ?? r.subject ?? "Invoice"}</span>
          {r.is_refund && <span className="shrink-0 rounded-full bg-warn/15 px-2 text-[11px] font-medium text-warn">Refund</span>}
        </div>
        <div className="text-xs text-muted truncate">{known.length ? known.join(" · ") : r.subject}</div>
        <div className="text-xs text-subtle truncate">
          From {r.sender_name || r.sender_email || "unknown"} · to {r.mailbox}
          {r.received_at && ` · ${relativeTime(r.received_at)}`}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 shrink-0">
        {r.download_url ? (
          <a
            href={r.download_url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            title={r.download_url}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-sm text-ink hover:bg-inset"
          >
            <ExternalLink size={14} /> Download from {host(r.download_url)}
          </a>
        ) : (
          <span className="text-xs text-subtle">No link found: open the email</span>
        )}
        <a
          href={gmailLink(r)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open the email in Gmail"
          className="h-8 w-8 grid place-items-center rounded-md border border-border text-muted hover:text-ink hover:bg-inset"
        >
          <Mail size={15} />
        </a>
        <FilePicker inputRef={picker} onFile={onFile} />
        <Button size="sm" variant="primary" iconLeft={<Upload size={14} />} loading={busy} onClick={() => picker.current?.click()}>
          Upload file
        </Button>
        <Menu
          align="right"
          trigger={
            <button type="button" aria-label="More" className="h-8 w-8 grid place-items-center rounded-md text-subtle hover:text-ink hover:bg-inset">
              <MoreHorizontal size={16} />
            </button>
          }
        >
          {(close) => (
            <>
              <MenuItem onClick={() => (close(), onReread())}>
                <span className="inline-flex items-center gap-2">
                  <RefreshCw size={14} /> Read the email again
                </span>
              </MenuItem>
              <MenuItem destructive onClick={() => (close(), onDismiss())}>
                <span className="inline-flex items-center gap-2">
                  <X size={14} /> Not an invoice
                </span>
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
    </div>
  );
}

function OtherRow({ r, i, onReread }: { r: Invoice; i: number; onReread: () => void }) {
  const why = r.status === "failed" ? r.error ?? "Couldn't be read" : r.error ?? "Not an invoice";
  return (
    <div style={{ "--i": Math.min(i, 12) } as React.CSSProperties} className="rise py-3 flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-ink truncate">{r.subject || "(no subject)"}</div>
        <div className="text-xs text-muted truncate">
          From {r.sender_name || r.sender_email || "unknown"} · to {r.mailbox}
          {r.received_at && ` · ${relativeTime(r.received_at)}`}
        </div>
        <div className={cn("mt-1 text-xs", r.status === "failed" ? "text-danger" : "text-subtle")}>{why}</div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <a
          href={gmailLink(r)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open the email in Gmail"
          className="h-9 w-9 grid place-items-center rounded-md text-subtle hover:text-ink hover:bg-inset"
        >
          <Mail size={16} />
        </a>
        <Button size="sm" variant="secondary" iconLeft={<RefreshCw size={13} />} onClick={onReread}>
          Read again
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- settings --

function SettingsModal({ open, onClose, ov }: { open: boolean; onClose: () => void; ov: InvoicesOverview }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [enabled, setEnabled] = useState(ov.settings.enabled);
  const [start, setStart] = useState(ov.settings.start_date);
  const [gmail, setGmail] = useState("");
  const [drive, setDrive] = useState("");
  const [folder, setFolder] = useState("");
  const today = new Date().toISOString().slice(0, 10);
  const dirty = enabled !== ov.settings.enabled || start !== ov.settings.start_date;

  const after = () => void qc.invalidateQueries({ queryKey: ["invoices-overview"] });
  const fail = (title: string) => (e: Error) => toast.push({ kind: "error", title, description: e.message });

  const save = useMutation({
    mutationFn: () => saveInvoiceSettings(enabled, start),
    onSuccess: () => {
      after();
      toast.push({ kind: "success", title: enabled ? "Invoices are read every couple of minutes" : "Reading invoices is off" });
    },
    onError: fail("Couldn't save"),
  });
  const addSource = useMutation({ mutationFn: addInvoiceSource, onSuccess: () => (setGmail(""), after()), onError: fail("Couldn't add it") });
  const dropSource = useMutation({ mutationFn: removeInvoiceSource, onSuccess: after, onError: fail("Couldn't remove it") });
  const addTarget = useMutation({
    mutationFn: () => addInvoiceTarget(drive, folder),
    onSuccess: () => (setDrive(""), setFolder(""), after()),
    onError: fail("Couldn't add the Drive"),
  });
  const dropTarget = useMutation({ mutationFn: removeInvoiceTarget, onSuccess: after, onError: fail("Couldn't remove it") });

  return (
    <Modal open={open} onClose={onClose} title="Invoice settings" size="lg">
      <div className="space-y-6">
        <section className="space-y-3">
          <Toggle
            checked={enabled}
            onChange={setEnabled}
            label="Read invoices from email"
            hint="Every couple of minutes, new invoice, receipt and refund emails with a file are read and filed."
          />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Label htmlFor="inv-start">Read emails from</Label>
              <DateField id="inv-start" value={start} max={today} clearable={false} onChange={setStart} />
            </div>
            <Button variant="primary" disabled={!dirty || !start} loading={save.isPending} onClick={() => save.mutate()}>
              Save
            </Button>
          </div>
          <Hint>The first run reads back to this day, a few emails at a time. Only emails from the last 3 days send notifications.</Hint>
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-ink">Gmail accounts to read</h3>
          {ov.sources.length ? (
            <ul className="rounded-lg border border-border divide-y divide-line">
              {ov.sources.map((s) => (
                <li key={s.account_id} className="flex items-start gap-3 px-3 py-2">
                  <Mail size={16} className="mt-0.5 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-ink break-all">{s.email}</div>
                    <div className="text-xs text-subtle">
                      Connected by {s.mine ? "you" : s.owner ?? "someone"}
                      {s.last_run_at && ` · checked ${relativeTime(s.last_run_at)}`}
                    </div>
                    {s.last_error && <div className="text-xs text-danger break-words">{s.last_error}</div>}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      if (await confirm({ title: `Stop reading ${s.email}?`, message: "What was already filed stays.", confirmLabel: "Stop", danger: true })) {
                        dropSource.mutate(s.account_id);
                      }
                    }}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">None yet.</p>
          )}
          {ov.my_gmail.length ? (
            <div className="flex gap-2">
              <Select
                className="flex-1"
                value={gmail}
                onChange={setGmail}
                placeholder="Pick one of your Gmail accounts…"
                options={ov.my_gmail.map((g) => ({ value: g.id, label: g.email }))}
              />
              <Button disabled={!gmail} loading={addSource.isPending} onClick={() => addSource.mutate(gmail)}>
                Add
              </Button>
            </div>
          ) : (
            <Hint>To add a Gmail account, connect it on the Connected accounts page first (only your own accounts can be added).</Hint>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-ink">Drives to file into</h3>
          <Hint>Each month gets a folder (invoices-Jul-2026) with the invoices in it and a refunds folder inside.</Hint>
          {ov.targets.length ? (
            <ul className="rounded-lg border border-border divide-y divide-line">
              {ov.targets.map((t) => (
                <li key={t.account_id} className="flex items-start gap-3 px-3 py-2">
                  <HardDrive size={16} className="mt-0.5 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-ink break-all">{t.email}</div>
                    <div className="text-xs text-subtle">
                      {t.parent_name ? `In the folder ${t.parent_name}` : "At the top of the Drive"} · connected by {t.mine ? "you" : t.owner ?? "someone"}
                    </div>
                    {t.last_error && <div className="text-xs text-danger break-words">{t.last_error}</div>}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      if (await confirm({ title: `Stop filing into ${t.email}?`, message: "The files already there stay.", confirmLabel: "Stop", danger: true })) {
                        dropTarget.mutate(t.account_id);
                      }
                    }}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">None yet.</p>
          )}
          {ov.my_drive.length ? (
            <div className="space-y-2 rounded-lg border border-dashed border-border p-3">
              <Select
                className="w-full"
                value={drive}
                onChange={setDrive}
                placeholder="Pick one of your Drives…"
                options={ov.my_drive.map((d) => ({ value: d.id, label: d.email }))}
              />
              <Input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Folder link from Google Drive (optional)" aria-label="Folder link" />
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-subtle">Empty: the month folders go at the top of the Drive.</span>
                <Button disabled={!drive} loading={addTarget.isPending} onClick={() => addTarget.mutate()}>
                  Add
                </Button>
              </div>
            </div>
          ) : (
            <Hint>To add a Drive, connect it on the Connected accounts page first (only your own Drives can be added).</Hint>
          )}
        </section>
      </div>
    </Modal>
  );
}
