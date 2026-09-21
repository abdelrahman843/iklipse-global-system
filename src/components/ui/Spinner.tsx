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
export function PageSpinner() {
  return (
    <div className="flex items-center justify-center py-16 text-subtle">
      <Spinner size={24} />
    </div>
  );
}
