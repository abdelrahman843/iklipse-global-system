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
  primary: "bg-accent text-white hover:bg-accent-hover disabled:bg-accent/60",
  secondary: "bg-white text-ink border border-border hover:bg-surface",
  ghost: "bg-transparent text-ink hover:bg-surface",
  subtle: "bg-surface text-ink hover:bg-border/70",
  danger: "bg-danger text-white hover:bg-red-700",
};
const sizes: Record<Size, string> = {
  sm: "h-8 px-2.5 text-sm rounded-md gap-1.5",
  md: "h-9 px-3 text-base rounded-md gap-2",
  lg: "h-10 px-4 text-base rounded-md gap-2",
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
