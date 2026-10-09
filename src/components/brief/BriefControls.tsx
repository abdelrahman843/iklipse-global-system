import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { LOGO_PATH } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";
import { promiseSentence, type BriefImage, type BriefQuestion } from "@/lib/brief/forms";

// -----------------------------------------------------------------------------
// The pieces of a brief as the client fills it in (BriefFormPage): the
// iklipse mark, growing answer boxes, the voice scale, the brand-promise
// sentence, the competitor cards and the moodboard uploader.
// -----------------------------------------------------------------------------

/** The iklipse mark and wordmark, in the deck's white. */
export function BriefMark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5 text-ink", className)}>
      <svg viewBox="0 0 655.23 303.98" className="h-[15px] w-auto" aria-hidden>
        <path fill="currentColor" d={LOGO_PATH} />
      </svg>
      <span className="font-['Inter_Tight',Inter,sans-serif] font-semibold text-[17px] tracking-[-0.03em] leading-none">iklipse</span>
    </span>
  );
}

/** A textarea that grows with what's typed. */
export function AutoTextarea({
  value,
  onChange,
  invalid,
  className,
  ...rest
}: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> & {
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  };
  useLayoutEffect(fit, [value]);
  useEffect(() => {
    // Fonts arriving late change line heights.
    void document.fonts?.ready.then(fit);
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  return (
    <textarea
      ref={ref}
      dir="auto"
      rows={3}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-invalid={invalid || undefined}
      className={cn("brief-field", className)}
      {...rest}
    />
  );
}

export function BriefInput({
  value,
  onChange,
  invalid,
  className,
  ...rest
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> & { value: string; onChange: (v: string) => void; invalid?: boolean }) {
  return (
    <input
      dir="auto"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-invalid={invalid || undefined}
      className={cn("brief-field h-[52px] py-0", className)}
      {...rest}
    />
  );
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

// ----------------------------------------------------------- voice scale --
const POINTS = [1, 2, 3, 4, 5, 6, 7];

export function VoiceScale({
  q,
  value,
  onChange,
  showErrors,
}: {
  q: Extract<BriefQuestion, { type: "scale" }>;
  value: unknown;
  onChange: (v: Record<string, number>) => void;
  showErrors?: boolean;
}) {
  const v = obj(value) as Record<string, number>;
  return (
    <div className="border border-ink/15 rounded-[4px] divide-y divide-ink/10">
      {q.pairs.map((p, i) => {
        const picked = Number(v[p.key]) || 0;
        const missing = showErrors && !picked;
        return (
          <div
            key={p.key}
            role="radiogroup"
            aria-label={`${p.left} to ${p.right}`}
            className={cn(
              "px-3 sm:px-5 py-3 sm:py-2 grid gap-y-1 items-center transition-colors",
              "grid-cols-2 sm:grid-cols-[minmax(0,1fr)_minmax(250px,380px)_minmax(0,1fr)] sm:gap-x-4",
              missing && "bg-danger/[0.07]",
            )}
          >
            <span className={cn("brief-caps text-[12px] sm:text-[13px] sm:text-right", picked && picked <= 3 ? "text-ink" : "text-ink/60")}>{p.left}</span>
            <span className={cn("brief-caps text-[12px] sm:text-[13px] text-right sm:text-left sm:order-3", picked >= 5 ? "text-ink" : "text-ink/60")}>
              {p.right}
            </span>
            <div className="col-span-2 sm:col-span-1 sm:order-2 grid grid-cols-7">
              {POINTS.map((n) => (
                <label key={n} className="brief-dot" title={scaleWord(p, n)}>
                  <input
                    type="radio"
                    className="sr-only"
                    name={`${q.key}-${p.key}`}
                    value={n}
                    checked={picked === n}
                    onChange={() => onChange({ ...v, [p.key]: n })}
                    aria-label={scaleWord(p, n)}
                    data-first={i === 0 && n === 1 ? "" : undefined}
                  />
                  <span />
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** "Mostly casual", "Both equally"... for a point on the scale. */
export function scaleWord(p: { left: string; right: string }, n: number) {
  const l = p.left.toLowerCase();
  const r = p.right.toLowerCase();
  return n === 1 ? `Fully ${l}` : n === 2 ? `Mostly ${l}` : n === 3 ? `A bit ${l}` : n === 4 ? "Both equally"
    : n === 5 ? `A bit ${r}` : n === 6 ? `Mostly ${r}` : `Fully ${r}`;
}

// --------------------------------------------------------- brand promise --
export function PromiseFields({
  q,
  value,
  onChange,
  showErrors,
}: {
  q: Extract<BriefQuestion, { type: "fields" }>;
  value: unknown;
  onChange: (v: Record<string, string>) => void;
  showErrors?: boolean;
}) {
  const v = obj(value) as Record<string, string>;
  const sentence = promiseSentence(v);
  return (
    <div className="space-y-5">
      <div className="space-y-3">
        {q.fields.map((f) => (
          <div key={f.key} className="grid sm:grid-cols-[132px_minmax(0,1fr)] gap-x-4 gap-y-1.5 items-start">
            <label htmlFor={`${q.key}-${f.key}`} className="brief-serif text-[26px] sm:text-[28px] tracking-[0.005em] sm:pt-2 sm:text-right text-ink">
              {f.label}
            </label>
            <div>
              <BriefInput
                id={`${q.key}-${f.key}`}
                value={str(v[f.key])}
                onChange={(t) => onChange({ ...v, [f.key]: t })}
                invalid={showErrors && !str(v[f.key]).trim()}
                placeholder="..."
              />
              {f.hint && <p className="mt-1.5 text-[13px] text-subtle">{f.hint}</p>}
            </div>
          </div>
        ))}
      </div>
      {q.kind === "promise" && (
        <div className="relative overflow-hidden rounded-[4px] border border-ink/15 px-5 py-5 sm:px-7 sm:py-6 bg-gradient-to-br from-accent/[0.14] via-transparent to-transparent">
          <div className="brief-caps text-[11px] text-accent mb-2">Your promise</div>
          <p className={cn("brief-serif text-[26px] sm:text-[34px] leading-[1.1] transition-opacity", sentence ? "text-ink" : "text-ink/35")} dir="auto">
            {sentence || "The only ... that ... for ... in ... in an era of ..."}
          </p>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------- competitors --
export function RepeatFields({
  q,
  value,
  onChange,
  showErrors,
}: {
  q: Extract<BriefQuestion, { type: "repeat" }>;
  value: unknown;
  onChange: (v: Record<string, string>[]) => void;
  showErrors?: boolean;
}) {
  const arr = Array.isArray(value) ? (value as Record<string, string>[]) : [];
  const set = (i: number, k: string, t: string) => {
    const next = Array.from({ length: Math.max(q.count, arr.length) }, (_, j) => ({ ...(arr[j] ?? {}) }));
    next[i][k] = t;
    onChange(next);
  };
  const short = q.fields.filter((f) => !f.long);
  const long = q.fields.filter((f) => f.long);
  return (
    <div className="space-y-5">
      {Array.from({ length: q.count }, (_, i) => {
        const it = arr[i] ?? {};
        return (
          <fieldset key={i} className="rounded-[4px] border border-ink/15 p-4 sm:p-5">
            <legend className="px-2 -ml-2 brief-caps text-[12px] text-accent">
              {q.item} {i + 1}
              {str(it.name).trim() && <span className="text-ink/70 normal-case tracking-normal"> · {str(it.name).trim()}</span>}
            </legend>
            <div className="grid sm:grid-cols-2 gap-3">
              {short.map((f) => (
                <div key={f.key}>
                  <label htmlFor={`${q.key}-${i}-${f.key}`} className="block brief-label text-[14px] mb-1.5">
                    {f.label}
                  </label>
                  <BriefInput
                    id={`${q.key}-${i}-${f.key}`}
                    value={str(it[f.key])}
                    onChange={(t) => set(i, f.key, t)}
                    invalid={showErrors && !str(it[f.key]).trim()}
                  />
                </div>
              ))}
            </div>
            <div className="mt-3 space-y-3">
              {long.map((f) => (
                <div key={f.key}>
                  <label htmlFor={`${q.key}-${i}-${f.key}`} className="block brief-label text-[14px] mb-1.5">
                    {f.label}
                  </label>
                  <AutoTextarea
                    id={`${q.key}-${i}-${f.key}`}
                    value={str(it[f.key])}
                    onChange={(t) => set(i, f.key, t)}
                    invalid={showErrors && !str(it[f.key]).trim()}
                    className="!min-h-[84px]"
                    rows={2}
                  />
                </div>
              ))}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------- moodboard --
export interface UploadingImage {
  id: string;
  preview: string;
  error?: string;
}

/**
 * The moodboard: drop or pick images, see them as a wall, remove any.
 * Uploading is the page's job (`onFiles`); this only shows what's there.
 */
export function MoodboardField({
  q,
  images,
  urls,
  uploading,
  onFiles,
  onRemove,
  showErrors,
}: {
  q: Extract<BriefQuestion, { type: "images" }>;
  images: BriefImage[];
  urls: Record<string, string>;
  uploading: UploadingImage[];
  onFiles: (files: File[]) => void;
  onRemove: (img: BriefImage) => void;
  showErrors?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const room = q.max - images.length - uploading.filter((u) => !u.error).length;
  const pick = (list: FileList | null) => {
    const files = Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length) onFiles(files.slice(0, Math.max(0, room)));
  };
  return (
    <div>
      {room > 0 && (
        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            pick(e.dataTransfer.files);
          }}
          aria-invalid={(showErrors && images.length < q.min) || undefined}
          className={cn(
            "w-full rounded-[4px] border border-dashed px-5 py-8 sm:py-10 flex flex-col items-center gap-2 text-center transition-colors",
            over ? "border-accent bg-accent/10" : "border-ink/25 hover:border-ink/45 hover:bg-ink/[0.03]",
            showErrors && images.length < q.min && "border-danger/80 bg-danger/[0.06]",
          )}
        >
          <span className="h-11 w-11 rounded-full grid place-items-center bg-accent/15 text-accent">
            <ImagePlus size={20} />
          </span>
          <span className="brief-label text-[15px]">
            <span className="hidden sm:inline">Drop images here or </span>
            <span className="text-accent sm:underline sm:underline-offset-4">choose images</span>
          </span>
          <span className="text-[13px] text-subtle">
            PNG, JPG, GIF or WebP · up to {q.max} · {room} more
          </span>
        </button>
      )}
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        className="hidden"
        onChange={(e) => {
          pick(e.target.files);
          e.target.value = "";
        }}
      />
      {(images.length > 0 || uploading.length > 0) && (
        <div className="mt-4 columns-2 sm:columns-3 gap-3 [&>*]:mb-3">
          {images.map((img, i) => (
            <figure key={img.path} className="group relative break-inside-avoid overflow-hidden rounded-[4px] border border-ink/10 bg-ink/[0.04] brief-rise" style={{ ["--i" as string]: i % 6 }}>
              {urls[img.path] ? (
                <img src={urls[img.path]} alt={img.name ?? "Moodboard image"} className="block w-full h-auto" loading="lazy" />
              ) : (
                <div className="aspect-[4/3] animate-pulse" />
              )}
              <button
                type="button"
                onClick={() => onRemove(img)}
                aria-label="Remove image"
                title="Remove"
                className="absolute top-2 right-2 h-8 w-8 grid place-items-center rounded-full bg-black/60 text-white backdrop-blur-sm opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 hover:bg-accent"
              >
                <X size={15} />
              </button>
            </figure>
          ))}
          {uploading.map((u) => (
            <figure key={u.id} className="relative break-inside-avoid overflow-hidden rounded-[4px] border border-ink/10">
              <img src={u.preview} alt="" className={cn("block w-full h-auto", u.error ? "opacity-30" : "opacity-50")} />
              <figcaption className="absolute inset-0 grid place-items-center p-3 text-center">
                {u.error ? (
                  <span className="text-[13px] text-ink bg-black/70 rounded px-2 py-1">{u.error}</span>
                ) : (
                  <span className="h-6 w-6 rounded-full border-2 border-white border-r-transparent animate-spin" aria-label="Uploading" />
                )}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}

/** Large photos are scaled down before upload (faster on phones, under the 10 MB cap). */
export async function shrinkImage(file: File): Promise<File> {
  if (file.type === "image/gif" || file.size < 3.5 * 1024 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2560 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.88));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}
