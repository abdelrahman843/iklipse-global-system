import {
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
  Type,
  type LucideIcon,
} from "lucide-react";
import type { VisitorComment } from "@/lib/deliveriesApi";

export function fileSize(n: number | null | undefined): string {
  if (n == null || n < 0) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

export function extOf(name: string): string {
  const m = name.match(/\.([a-zA-Z0-9]{1,8})$/);
  return m ? m[1].toUpperCase() : "";
}

export function hostOf(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A lucide icon that says what kind of file it is. */
export function fileIcon(name: string, mime: string | null): LucideIcon {
  const ext = extOf(name).toLowerCase();
  const m = mime ?? "";
  if (m.startsWith("image/")) return FileImage;
  if (m.startsWith("video/")) return FileVideo;
  if (m.startsWith("audio/") || ["mp3", "wav", "aac", "flac", "m4a", "ogg"].includes(ext)) return FileAudio;
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext) || /zip|compressed|archive/.test(m)) return FileArchive;
  if (["xls", "xlsx", "csv", "numbers", "ods"].includes(ext)) return FileSpreadsheet;
  if (["ppt", "pptx", "key", "odp"].includes(ext)) return Presentation;
  if (["ttf", "otf", "woff", "woff2"].includes(ext)) return Type;
  if (["json", "html", "css", "js", "ts", "svg", "xml"].includes(ext)) return FileCode;
  if (["pdf", "doc", "docx", "txt", "rtf", "md", "pages", "odt"].includes(ext) || m.startsWith("text/")) return FileText;
  return FileIcon;
}

/** Videos: by the second they point at (timeless last), then oldest first. */
export function sortComments(list: VisitorComment[], video: boolean): VisitorComment[] {
  return [...list].sort((a, b) => {
    if (video) {
      const x = a.at_seconds ?? Number.POSITIVE_INFINITY;
      const y = b.at_seconds ?? Number.POSITIVE_INFINITY;
      if (x !== y) return x - y;
    }
    return a.created_at.localeCompare(b.created_at);
  });
}

export const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && !!t.closest("input, textarea, select, [contenteditable='true']");
