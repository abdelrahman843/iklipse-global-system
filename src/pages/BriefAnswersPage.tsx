import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ClipboardCopy, Copy, FileText, Printer, Smartphone } from "lucide-react";
import { BackButton } from "@/components/ui/BackButton";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSpinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { scaleWord } from "@/components/brief/BriefControls";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { loadBriefFonts } from "@/lib/brief/fonts";
import { answersAsText, promiseSentence, type BriefImage, type BriefQuestion } from "@/lib/brief/forms";
import { briefStatus, briefUrl, getBrief, signBriefImages } from "@/lib/brief/api";
import { STATUS, copyText, useBriefsRealtime, usePeopleNames } from "@/pages/BriefsPage";

// -----------------------------------------------------------------------------
// One brief's answers, laid out like the workshop deck: sections, the voice
// scale, the promise sentence, the competitors and the moodboard. Before the
// person sends it, this shows what they've written so far (live).
// -----------------------------------------------------------------------------

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

export function BriefAnswersPage() {
  const { id = "" } = useParams();
  const { briefRole } = useAuth();
  const toast = useToast();
  const people = usePeopleNames();
  useBriefsRealtime();
  useEffect(loadBriefFonts, []);

  const { data: link, isLoading, error } = useQuery({ queryKey: ["brief", id], queryFn: () => getBrief(id), refetchOnWindowFocus: true });
  const form = link?.questions;
  const imagesQ = form?.sections.flatMap((s) => s.questions).find((q) => q.type === "images");
  const images = (imagesQ && link && Array.isArray(link.answers[imagesQ.key]) ? link.answers[imagesQ.key] : []) as BriefImage[];
  const urls = useQuery({
    queryKey: ["brief-images", id, images.map((i) => i.path).join("|")],
    queryFn: () => signBriefImages(id, images),
    enabled: images.length > 0,
    staleTime: 50 * 60_000,
  });

  if (isLoading) return <PageSpinner />;
  if (error || !link || !form)
    return (
      <div className="p-6">
        <BackButton fallback="/briefs" />
        <EmptyState
          icon={<FileText size={28} />}
          title={error ? "Couldn't load this brief" : "This brief isn't here"}
          description={error ? (error as Error).message : "It may have been deleted."}
        />
      </div>
    );

  const st = briefStatus(link);
  const by = (link.created_by && people.data?.get(link.created_by)) || null;
  const hasAny = Object.keys(link.answers ?? {}).length > 0;

  return (
    <div className="h-full overflow-y-auto print-flow">
      <div className="p-3 sm:p-4 md:p-8 max-w-4xl mx-auto brief-print">
        <div className="flex items-start gap-3 mb-6">
          <BackButton fallback="/briefs" className="print:hidden" />
          <div className="flex-1 min-w-0">
            <div className="eyebrow text-subtle mb-1">Briefs · {form.title}</div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl sm:text-3xl font-semibold text-ink tracking-tight break-words">{link.label}</h1>
              <Badge tone={STATUS[st].tone}>{STATUS[st].label}</Badge>
            </div>
            <div className="mt-2 text-xs text-subtle flex flex-wrap gap-x-3 gap-y-1">
              <span>Made {when(link.created_at)}{by ? ` by ${by}` : ""}</span>
              {link.opened_at && (
                <span className="inline-flex items-center gap-1">
                  <Smartphone size={11} /> Opened {when(link.opened_at)}
                  {link.device_name ? ` on ${link.device_name}` : ""}
                </span>
              )}
              {link.submitted_at && <span className="text-success">Sent {when(link.submitted_at)}</span>}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mb-6 print:hidden">
          {hasAny && (
            <Button
              size="sm"
              iconLeft={<ClipboardCopy size={14} />}
              onClick={async () => {
                await copyText(answersAsText(form, link.answers, `${form.title}: ${link.label}`));
                toast.push({ kind: "success", title: "Answers copied", description: "Paste them anywhere as plain text." });
              }}
            >
              Copy answers
            </Button>
          )}
          {hasAny && (
            <Button size="sm" iconLeft={<Printer size={14} />} onClick={() => window.print()}>
              Print / save as PDF
            </Button>
          )}
          {briefRole === "create" && (st === "waiting" || st === "progress") && (
            <Button
              size="sm"
              iconLeft={<Copy size={14} />}
              onClick={async () => {
                await copyText(briefUrl(link.token));
                toast.push({ kind: "success", title: "Link copied" });
              }}
            >
              Copy link
            </Button>
          )}
        </div>

        {st !== "answered" && (
          <div className="mb-6 rounded-lg border border-warn/30 bg-warn/10 px-4 py-3 text-sm text-ink print:hidden">
            {st === "waiting"
              ? "Not opened yet. Their answers show up here as they write them."
              : st === "off"
                ? "This link is closed. Below is what they wrote before it closed."
                : `Not sent yet: ${link.progress}% answered. This is what they've written so far, and it updates as they type.`}
          </div>
        )}

        {hasAny &&
          form.sections.map((s, si) => (
            <section key={s.id} className="py-7 border-t border-line">
              <div className="eyebrow text-accent">
                {String(si + 1).padStart(2, "0")} · {s.about}
              </div>
              <h2 className="mt-1 text-xl sm:text-2xl font-semibold text-ink tracking-tight uppercase">{s.title}</h2>
              <div className="mt-5 space-y-6">
                {s.questions.map((q) => (
                  <div key={q.key}>
                    <div className="text-sm font-semibold text-ink">{q.label}</div>
                    <div className="mt-2">
                      <Answer q={q} value={link.answers[q.key]} urls={urls.data ?? {}} />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
      </div>
    </div>
  );
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const Missing = () => <span className="text-sm text-subtle italic">No answer yet</span>;

function Answer({ q, value, urls }: { q: BriefQuestion; value: unknown; urls: Record<string, string> }) {
  switch (q.type) {
    case "text":
    case "long":
      return str(value) ? (
        <p className="text-[15px] text-muted leading-relaxed whitespace-pre-wrap break-words" dir="auto">
          {str(value)}
        </p>
      ) : (
        <Missing />
      );

    case "scale": {
      const v = (value ?? {}) as Record<string, number>;
      return (
        <div className="rounded-lg border border-border divide-y divide-line overflow-hidden">
          {q.pairs.map((p) => {
            const n = Number(v[p.key]) || 0;
            return (
              <div key={p.key} className="px-3 py-2.5 grid grid-cols-2 sm:grid-cols-[minmax(0,1fr)_minmax(180px,260px)_minmax(0,1fr)] gap-x-3 gap-y-1.5 items-center">
                <span className={cn("text-xs font-medium uppercase sm:text-right", n && n <= 3 ? "text-ink" : "text-subtle")}>{p.left}</span>
                <span className={cn("text-xs font-medium uppercase text-right sm:text-left sm:order-3", n >= 5 ? "text-ink" : "text-subtle")}>{p.right}</span>
                <div className="col-span-2 sm:col-span-1 sm:order-2 grid grid-cols-7 place-items-center" title={n ? scaleWord(p, n) : "Not answered"}>
                  {[1, 2, 3, 4, 5, 6, 7].map((i) => (
                    <span
                      key={i}
                      className={cn("h-3.5 w-3.5 rounded-[3px] border", i === n ? "bg-accent border-accent shadow-[0_0_10px_rgb(var(--c-accent)/0.5)]" : "border-rule")}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      );
    }

    case "fields": {
      const v = (value ?? {}) as Record<string, string>;
      if (!q.fields.some((f) => str(v[f.key]))) return <Missing />;
      const sentence = q.kind === "promise" ? promiseSentence(v) : "";
      return (
        <div className="space-y-3">
          {sentence && (
            <p className="brief-serif text-[26px] sm:text-[32px] leading-[1.12] text-ink" dir="auto">
              {sentence}
            </p>
          )}
          <dl className="grid sm:grid-cols-[120px_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
            {q.fields.map((f) => (
              <div key={f.key} className="contents">
                <dt className="text-subtle">{f.label}</dt>
                <dd className="text-muted break-words" dir="auto">
                  {str(v[f.key]) || "-"}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      );
    }

    case "repeat": {
      const arr = Array.isArray(value) ? (value as Record<string, string>[]) : [];
      if (!arr.some((it) => q.fields.some((f) => str(it?.[f.key])))) return <Missing />;
      return (
        <div className="grid md:grid-cols-3 gap-3">
          {Array.from({ length: q.count }, (_, i) => arr[i] ?? {}).map((it, i) => (
            <div key={i} className="rounded-lg border border-border bg-surface p-3.5">
              <div className="eyebrow text-accent text-[11px]">
                {q.item} {i + 1}
              </div>
              <div className="mt-1 font-semibold text-ink break-words" dir="auto">
                {str(it.name) || "-"}
              </div>
              {q.fields
                .filter((f) => f.key !== "name")
                .map((f) => (
                  <div key={f.key} className="mt-2.5">
                    <div className="text-[11px] uppercase tracking-wide text-subtle">{f.label}</div>
                    <div className="text-sm text-muted whitespace-pre-wrap break-words" dir="auto">
                      {str(it[f.key]) || "-"}
                    </div>
                  </div>
                ))}
            </div>
          ))}
        </div>
      );
    }

    case "images": {
      const list = Array.isArray(value) ? (value as BriefImage[]) : [];
      if (!list.length) return <Missing />;
      return (
        <div className="columns-2 sm:columns-3 gap-3 [&>*]:mb-3">
          {list.map((img) => (
            <a
              key={img.path}
              href={urls[img.path]}
              target="_blank"
              rel="noreferrer"
              className="block break-inside-avoid overflow-hidden rounded-lg border border-border bg-inset hover:border-accent transition-colors"
              title={img.name ?? "Open full size"}
            >
              {urls[img.path] ? <img src={urls[img.path]} alt={img.name ?? "Moodboard image"} className="block w-full h-auto" loading="lazy" /> : <div className="aspect-[4/3] animate-pulse" />}
            </a>
          ))}
        </div>
      );
    }
  }
}
