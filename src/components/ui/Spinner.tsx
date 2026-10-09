import { useId } from "react";
import { cn } from "@/lib/cn";

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cn(
        "inline-block border-2 border-current border-r-transparent rounded-full animate-spin",
        className,
      )}
      style={{ width: size, height: size }}
      role="status"
      aria-label="Loading"
    />
  );
}

// -----------------------------------------------------------------------------
// LogoLoader — the Iklipse mark filling with water. A faint copy is always on
// so the shape reads from the first frame; the solid copy shows only under a
// water line that rises and recedes in a calm loop, its edge rippling from two
// waves at different speeds. Animation lives in index.css (.logofill*); the
// first-paint copy in index.html uses the same paths.
// -----------------------------------------------------------------------------

export const LOGO_PATH =
  "M503.23,0c83.88-.01,153.1,70.16,151.99,154.03-1.1,83-68.72,149.95-151.97,149.95-54.51,0-102.32-28.7-129.14-71.81-10.03-16.13-27.49-26.14-46.49-26.14h0c-18.7,0-36.26,9.5-46.05,25.44-27.24,44.32-76.59,73.6-132.69,72.48C68.39,302.34.65,233.72,0,153.23-.67,68.72,67.64,0,151.99,0c54.51,0,102.32,28.7,129.14,71.81,10.03,16.13,27.49,26.14,46.49,26.14h0c18.7,0,36.26-9.5,46.05-25.43C400.4,29.02,448.43,0,503.23,0Z";

/** A run of `n` half-waves from x0, closed far below so it fills downward. */
function wavePath(x0: number, half: number, amp: number, n: number) {
  let d = `M${x0} 0`;
  for (let i = 0; i < n; i++) {
    const s = i % 2 ? amp : -amp;
    d += `c${(half / 3).toFixed(2)} ${s} ${((2 * half) / 3).toFixed(2)} ${s} ${half} 0`;
  }
  return `${d}L${x0 + n * half} 700L${x0} 700Z`;
}
// Each wave slides by exactly one period (see .logofill__wave-*), so the loop is
// seamless, and both stay wider than the 655-unit logo the whole way.
const WAVE_A = wavePath(-768, 128, 14, 14);
const WAVE_B = wavePath(-576, 96, 10, 16);

export function LogoLoader({ width = 132, className }: { width?: number; className?: string }) {
  const maskId = `lf-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg
      viewBox="0 0 655.23 303.98"
      className={cn("logofill text-ink", className)}
      style={{ width, height: (width * 303.98) / 655.23 }}
      role="status"
      aria-label="Loading"
    >
      <defs>
        <mask id={maskId}>
          <g className="logofill__rise">
            <path className="logofill__wave-a" fill="#fff" d={WAVE_A} />
            <path className="logofill__wave-b" fill="#fff" d={WAVE_B} />
          </g>
        </mask>
      </defs>
      <path className="logofill__ghost" fill="currentColor" d={LOGO_PATH} />
      <path mask={`url(#${maskId})`} fill="currentColor" d={LOGO_PATH} />
    </svg>
  );
}

export function PageSpinner() {
  return (
    <div className="appear-late flex-1 min-h-[45vh] h-full flex items-center justify-center">
      <LogoLoader />
    </div>
  );
}
