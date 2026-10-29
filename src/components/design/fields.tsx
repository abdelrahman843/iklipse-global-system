import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

// -----------------------------------------------------------------------------
// Small inspector controls: number fields (type, arrows, drag the label to
// scrub), colour fields, selects, segmented buttons, section headers.
// -----------------------------------------------------------------------------

export const MIXED = "Mixed";

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-b border-border px-3 py-2.5">
      <div className="flex items-center justify-between h-6 mb-1.5">
        <h3 className="text-[11px] font-semibold text-ink">{title}</h3>
        {action}
      </div>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}

export function IconBtn({ title, onClick, active, children, disabled }: { title: string; onClick: () => void; active?: boolean; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "h-6 min-w-6 px-1 grid place-items-center rounded text-muted hover:bg-hover hover:text-ink disabled:opacity-40 disabled:pointer-events-none",
        active && "bg-accent-soft text-accent",
      )}
    >
      {children}
    </button>
  );
}

export function NumField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
  suffix,
  title,
}: {
  label?: ReactNode;
  value: number | typeof MIXED | undefined;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  suffix?: string;
  title?: string;
}) {
  const shown = value === MIXED ? MIXED : value === undefined ? "" : String(Math.round(value * 100) / 100);
  const [text, setText] = useState(shown);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(shown);
  }, [shown]);
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const commit = (raw: string) => {
    // Simple maths: "100/2", "40+8".
    let v = raw.trim() === "" ? NaN : Number(raw);
    const m = /^\s*(-?[\d.]+)\s*([+\-*/])\s*(-?[\d.]+)\s*$/.exec(raw);
    if (!Number.isFinite(v) && m) {
      const a = Number(m[1]);
      const b = Number(m[3]);
      v = m[2] === "+" ? a + b : m[2] === "-" ? a - b : m[2] === "*" ? a * b : b ? a / b : NaN;
    }
    if (Number.isFinite(v)) onChange(clamp(v));
    else setText(shown);
  };
  const scrub = (e: React.PointerEvent) => {
    if (disabled || value === MIXED || value === undefined) return;
    const x0 = e.clientX;
    const v0 = value;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => onChange(clamp(Math.round((v0 + ((ev.clientX - x0) / 2) * step) * 100) / 100));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  return (
    <label className={cn("flex items-center h-7 rounded border border-transparent bg-inset hover:border-border focus-within:border-accent min-w-0", disabled && "opacity-50")} title={title}>
      {label !== undefined && (
        <span className="w-6 shrink-0 text-center text-[11px] text-subtle cursor-ew-resize select-none" onPointerDown={scrub}>
          {label}
        </span>
      )}
      <input
        className="min-w-0 flex-1 bg-transparent outline-none text-xs text-ink px-1"
        value={text}
        disabled={disabled}
        onFocus={(e) => {
          focused.current = true;
          e.target.select();
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => {
          focused.current = false;
          if (e.target.value !== shown) commit(e.target.value);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setText(shown);
            (e.target as HTMLInputElement).blur();
          }
          if ((e.key === "ArrowUp" || e.key === "ArrowDown") && typeof value === "number") {
            e.preventDefault();
            const d = (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            onChange(clamp(value + d));
          }
        }}
      />
      {suffix && <span className="pr-1.5 text-[11px] text-subtle">{suffix}</span>}
    </label>
  );
}

export function TextField({ value, onChange, placeholder, className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      className={cn("h-7 w-full min-w-0 rounded border border-transparent bg-inset hover:border-border focus:border-accent outline-none text-xs text-ink px-2", className)}
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onChange(text)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

export function Select<T extends string | number>({ value, options, onChange, disabled, className }: { value: T | typeof MIXED; options: { value: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean; className?: string }) {
  return (
    <select
      className={cn("h-7 w-full min-w-0 rounded border border-transparent bg-inset hover:border-border focus:border-accent outline-none text-xs text-ink px-1.5", className)}
      value={value === MIXED ? "" : String(value)}
      disabled={disabled}
      onChange={(e) => {
        const o = options.find((x) => String(x.value) === e.target.value);
        if (o) onChange(o.value);
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {value === MIXED && <option value="">Mixed</option>}
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T | typeof MIXED; options: { value: T; label: ReactNode; title: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex h-7 rounded bg-inset p-0.5 gap-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          aria-label={o.title}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn("flex-1 grid place-items-center rounded text-xs text-muted hover:text-ink", value === o.value && "bg-surface text-ink shadow-sm")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Hex colour (#RRGGBB) with a swatch picker and an opacity percentage. */
export function ColorField({ color, opacity, onChange, label }: { color: string; opacity?: number; onChange: (color: string, opacity: number) => void; label?: ReactNode }) {
  const hex = toHex(color);
  const [text, setText] = useState(hex.slice(1).toUpperCase());
  useEffect(() => setText(hex.slice(1).toUpperCase()), [hex]);
  const op = opacity ?? 1;
  return (
    <div className="flex items-center gap-1 min-w-0 flex-1">
      <label className="relative h-6 w-6 shrink-0 rounded border border-border overflow-hidden cursor-pointer" style={{ background: hex }} title="Pick a colour">
        <input type="color" className="absolute inset-0 opacity-0 cursor-pointer" value={hex} onChange={(e) => onChange(e.target.value.toUpperCase(), op)} />
      </label>
      {label}
      <input
        className="min-w-0 flex-1 h-7 rounded border border-transparent bg-inset hover:border-border focus:border-accent outline-none text-xs text-ink px-1.5 font-mono"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const v = text.replace(/^#/, "");
          if (/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v)) onChange(toHex(`#${v}`).toUpperCase(), op);
          else setText(hex.slice(1).toUpperCase());
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      <div className="w-14 shrink-0">
        <NumField value={Math.round(op * 100)} min={0} max={100} suffix="%" onChange={(v) => onChange(hex.toUpperCase(), v / 100)} />
      </div>
    </div>
  );
}

export function toHex(c: string): string {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  if (/^#[0-9a-f]{3}$/i.test(c)) return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(c);
  if (m) return `#${[m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, "0")).join("")}`;
  if (/^#[0-9a-f]{8}$/i.test(c)) return c.slice(0, 7);
  return "#000000";
}

/** Same value on every item, or MIXED. */
export function common<T, V>(items: T[], get: (t: T) => V): V | typeof MIXED | undefined {
  if (!items.length) return undefined;
  const first = get(items[0]!);
  for (const it of items) if (JSON.stringify(get(it)) !== JSON.stringify(first)) return MIXED;
  return first;
}
