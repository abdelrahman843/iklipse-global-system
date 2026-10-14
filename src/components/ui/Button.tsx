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
  primary: "bg-accent text-on-accent border border-transparent hover:bg-accent-hover shadow-sm disabled:bg-accent/60",
  secondary: "bg-surface text-muted hover:text-ink border border-rule hover:bg-inset",
  ghost: "bg-transparent text-muted hover:text-ink border border-transparent hover:bg-inset",
  subtle: "bg-inset text-ink border border-line hover:bg-accent-soft",
  danger: "bg-danger text-white border border-transparent hover:opacity-90",
};
const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-sm rounded-lg gap-1.5",
  md: "h-9 px-4 text-base rounded-lg gap-2",
  lg: "h-10 px-4 text-base rounded-lg gap-2",
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
        "inline-flex items-center justify-center font-semibold select-none whitespace-nowrap",
        "transition-[background-color,color,border-color,transform] duration-150 ease-out",
        "active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100",
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
