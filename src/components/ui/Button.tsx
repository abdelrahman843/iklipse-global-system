import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type Size = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
}

const variants: Record<Variant, string> = {
  primary: "bg-accent text-white hover:bg-accent-hover disabled:bg-accent/60 shadow-[0_8px_28px_-10px_rgb(var(--c-accent)/0.8)] disabled:shadow-none",
  secondary: "bg-surface text-ink border border-border hover:bg-inset",
  ghost: "bg-transparent text-ink hover:bg-inset",
  subtle: "bg-inset text-ink hover:bg-border/70",
  danger: "bg-danger text-white hover:bg-accent-hover",
};
// Phones get thumb-sized buttons (40 / 44 / 48px); sm+ keeps the compact ones.
const sizes: Record<Size, string> = {
  sm: "h-10 px-3 text-base sm:h-8 sm:px-2.5 sm:text-sm rounded-md gap-1.5",
  md: "h-11 px-4 text-base sm:h-9 sm:px-3 rounded-md gap-2",
  lg: "h-12 px-5 text-lg sm:h-10 sm:px-4 sm:text-base rounded-md gap-2",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, iconLeft, iconRight, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center font-medium select-none whitespace-nowrap",
        "transition-[background-color,color,border-color,transform] duration-150 ease-out",
        "active:scale-[0.97] disabled:opacity-60 disabled:cursor-not-allowed disabled:active:scale-100",
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <span className="inline-block h-3.5 w-3.5 border-2 border-current border-r-transparent rounded-full animate-spin" />
      ) : (
        iconLeft
      )}
      {children}
      {!loading && iconRight}
    </button>
  );
});
