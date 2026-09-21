import { cn } from "@/lib/cn";

type Tone = "neutral" | "accent" | "success" | "warn" | "danger";

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
}) {
  const tones: Record<Tone, string> = {
    neutral: "bg-surface text-muted border-border",
    accent: "bg-accent-soft text-accent border-accent/20",
    success: "bg-success/10 text-success border-success/20",
    warn: "bg-warn/10 text-warn border-warn/20",
    danger: "bg-danger/10 text-danger border-danger/20",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
