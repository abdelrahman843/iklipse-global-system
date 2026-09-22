import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

const base =
  "block w-full min-w-0 bg-white border border-border rounded-md px-3 py-2 text-base text-ink placeholder:text-subtle focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:outline-none disabled:bg-surface disabled:cursor-not-allowed transition-[border-color,box-shadow] duration-150";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cn(base, "h-9", className)} {...rest} />;
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, rows = 4, ...rest }, ref) {
  return <textarea ref={ref} rows={rows} className={cn(base, "leading-normal", className)} {...rest} />;
});

export function Label({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-medium text-ink mb-1">
      {children}
    </label>
  );
}

export function FieldError({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return <p className="mt-1 text-xs text-danger">{children}</p>;
}

export function Hint({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-xs text-subtle">{children}</p>;
}
