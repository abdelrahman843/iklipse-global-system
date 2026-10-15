import { cn } from "@/lib/cn";

/** The iklipse emblem (two joined discs), in the current text colour. A little
 *  room round the shape so its curves aren't shaved off at small sizes. */
export function Emblem({ className }: { className?: string }) {
  return (
    <svg viewBox="-8 -8 671.23 319.98" fill="currentColor" aria-hidden className={cn("shrink-0", className)}>
      <path d="M503.23,0c83.88-.01,153.1,70.16,151.99,154.03-1.1,83-68.72,149.95-151.97,149.95-54.51,0-102.32-28.7-129.14-71.81-10.03-16.13-27.49-26.14-46.49-26.14h0c-18.7,0-36.26,9.5-46.05,25.44-27.24,44.32-76.59,73.6-132.69,72.48C68.39,302.34.65,233.72,0,153.23-.67,68.72,67.64,0,151.99,0c54.51,0,102.32,28.7,129.14,71.81,10.03,16.13,27.49,26.14,46.49,26.14h0c18.7,0,36.26-9.5,46.05-25.43C400.4,29.02,448.43,0,503.23,0Z" />
    </svg>
  );
}

/** Emblem (in the accent) + wordmark, the one lockup used by the sign-in page and the shell. */
export function BrandMark({ size = "md", className }: { size?: "md" | "lg"; className?: string }) {
  return (
    <span className={cn("inline-flex items-center text-ink", size === "lg" ? "gap-3" : "gap-2.5", className)}>
      <Emblem className={cn("text-accent", size === "lg" ? "w-9" : "w-7")} />
      <span className={cn("font-semibold tracking-tight leading-tight pb-px", size === "lg" ? "text-[21px]" : "text-[16px]")}>iklipse</span>
    </span>
  );
}
