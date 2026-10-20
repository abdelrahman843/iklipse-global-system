import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Input } from "./Input";
import { Switch } from "./Controls";
import { InfoTip } from "./InfoTip";
import { Section } from "./Section";

// -----------------------------------------------------------------------------
// Settings as rows: the name (with an (i) holding the explanation) on the left,
// the control on the right, rows split by hairlines under a section heading.
// -----------------------------------------------------------------------------

/** "240" -> "4 hours", "1440" -> "1 day": next to a field counted in minutes. */
function spellMinutes(v: number) {
  if (!Number.isFinite(v) || v < 60) return null;
  if (v % 1440 === 0) return v === 1440 ? "1 day" : `${v / 1440} days`;
  const h = Math.round((v / 60) * 10) / 10;
  return h === 1 ? "1 hour" : `${h} hours`;
}

/**
 * One setting: its name (and an (i) with the explanation) on the left, the
 * control on the right. Wide controls (`stack`) go under the name. `dim`: the
 * switch it depends on is off.
 */
export function SettingRow({
  label,
  info,
  htmlFor,
  stack,
  dim,
  children,
}: {
  label: string;
  info?: string;
  htmlFor?: string;
  stack?: boolean;
  dim?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn("py-3 flex gap-x-6 gap-y-2 transition-opacity", stack ? "flex-col" : "flex-wrap items-center justify-between", dim && "opacity-50")}>
      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        <label htmlFor={htmlFor} className="text-sm text-ink">
          {label}
        </label>
        {info && <InfoTip text={info} />}
      </div>
      <div className={cn("min-w-0", !stack && "shrink-0")}>{children}</div>
    </div>
  );
}

export function SwitchRow({
  id,
  label,
  info,
  checked,
  onChange,
  dim,
  disabled,
}: {
  id: string;
  label: string;
  info?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  dim?: boolean;
  disabled?: boolean;
}) {
  return (
    <SettingRow label={label} info={info} htmlFor={id} dim={dim}>
      <Switch id={id} checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </SettingRow>
  );
}

export function NumberRow({
  id,
  label,
  info,
  value,
  onChange,
  min,
  max,
  unit,
  dim,
}: {
  id: string;
  label: string;
  info?: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  unit: string;
  dim?: boolean;
}) {
  const spelled = unit === "minutes" ? spellMinutes(value) : null;
  return (
    <SettingRow label={label} info={info} htmlFor={id} dim={dim}>
      <div className="flex items-center gap-2">
        <div className="w-20 shrink-0">
          <Input
            id={id}
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            value={Number.isFinite(value) ? value : ""}
            onChange={(e) => onChange(e.target.value === "" ? NaN : Math.round(Number(e.target.value)))}
          />
        </div>
        <span className="text-sm text-muted sm:w-28">
          {unit}
          {spelled && <span className="block text-xs text-subtle">{spelled}</span>}
        </span>
      </div>
    </SettingRow>
  );
}

/** A titled group of settings rows, split by hairlines. */
export function SettingGroup({ title, hint, info, children }: { title: ReactNode; hint?: ReactNode; info?: string; children: ReactNode }) {
  return (
    <Section title={title} hint={hint} info={info}>
      <div className="divide-y divide-line">{children}</div>
    </Section>
  );
}
