import { initials } from "@/lib/format";
import { cn } from "@/lib/cn";

interface AvatarProps {
  src?: string | null;
  name: string;
  size?: number;
  className?: string;
}

/** Deterministic pastel from a string. */
function colorFor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}deg 55% 52%)`;
}

export function Avatar({ src, name, size = 28, className }: AvatarProps) {
  const style = {
    width: size,
    height: size,
    fontSize: Math.max(10, Math.round(size * 0.4)),
    background: src ? undefined : colorFor(name || "?"),
  };
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full text-white font-semibold overflow-hidden ring-2 ring-white",
        className,
      )}
      style={style}
      title={name}
    >
      {src ? (
        <img src={src} alt={name} className="w-full h-full object-cover" />
      ) : (
        initials(name || "?")
      )}
    </span>
  );
}
