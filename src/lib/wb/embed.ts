// -----------------------------------------------------------------------------
// Embeds (Miro's "Embed" cards): a pasted link to a video or post becomes a
// card that plays right on the board. Only known players are framed (their
// official embed URLs); any other link becomes a plain link card, since most
// sites refuse to be shown inside another page.
// -----------------------------------------------------------------------------

export type EmbedProvider =
  | "youtube"
  | "instagram"
  | "tiktok"
  | "vimeo"
  | "facebook"
  | "loom"
  | "drive"
  | "gdocs"
  | "pinterest";

export interface EmbedInfo {
  provider: EmbedProvider;
  /** Shown in the card's header. */
  label: string;
  /** The player's URL (what goes in the iframe). */
  src: string;
  /** Portrait players (reels, shorts, TikTok) are tall. */
  portrait: boolean;
}

const LABEL: Record<EmbedProvider, string> = {
  youtube: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok",
  vimeo: "Vimeo",
  facebook: "Facebook",
  loom: "Loom",
  drive: "Google Drive",
  gdocs: "Google Docs",
  pinterest: "Pinterest",
};

const ID = /^[\w-]+$/;

/** A single http(s) link (what a paste must be to become an embed or link card). */
export function asLink(text: string): URL | null {
  const t = text.trim();
  if (!t || /\s/.test(t) || t.length > 2000) return null;
  try {
    const u = new URL(t);
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
}

export function parseEmbed(raw: string): EmbedInfo | null {
  const u = asLink(raw);
  if (!u) return null;
  const host = u.hostname.replace(/^(www|m|mobile)\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  const out = (provider: EmbedProvider, src: string, portrait = false): EmbedInfo => ({ provider, label: LABEL[provider], src, portrait });

  if (host === "youtube.com" || host === "youtu.be" || host === "youtube-nocookie.com") {
    let id: string | null = null;
    let portrait = false;
    if (host === "youtu.be") id = parts[0] ?? null;
    else if (parts[0] === "watch") id = u.searchParams.get("v");
    else if (parts[0] === "shorts") (id = parts[1] ?? null), (portrait = true);
    else if (parts[0] === "embed" || parts[0] === "live" || parts[0] === "v") id = parts[1] ?? null;
    if (!id || !ID.test(id)) return null;
    const t = parseInt(u.searchParams.get("t") ?? u.searchParams.get("start") ?? "", 10);
    return out("youtube", `https://www.youtube-nocookie.com/embed/${id}${t > 0 ? `?start=${t}` : ""}`, portrait);
  }
  if (host === "instagram.com") {
    const i = parts.findIndex((p) => p === "p" || p === "reel" || p === "reels" || p === "tv");
    const id = i >= 0 ? parts[i + 1] : undefined;
    if (!id || !ID.test(id)) return null;
    const kind = parts[i] === "p" ? "p" : parts[i] === "tv" ? "tv" : "reel";
    return out("instagram", `https://www.instagram.com/${kind}/${id}/embed/`, true);
  }
  if (host === "tiktok.com") {
    const i = parts.indexOf("video");
    const id = i >= 0 ? parts[i + 1] : undefined;
    if (!id || !/^\d+$/.test(id)) return null;
    return out("tiktok", `https://www.tiktok.com/player/v1/${id}`, true);
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const id = parts.find((p) => /^\d+$/.test(p));
    if (!id) return null;
    return out("vimeo", `https://player.vimeo.com/video/${id}`);
  }
  if (host === "facebook.com" || host === "fb.watch") {
    const video = host === "fb.watch" || parts.includes("videos") || parts[0] === "watch" || parts[0] === "reel" || parts[0] === "share";
    if (!video) return null;
    const portrait = parts[0] === "reel" || (parts[0] === "share" && parts[1] === "r");
    return out("facebook", `https://www.facebook.com/plugins/video.php?show_text=false&href=${encodeURIComponent(u.href)}`, portrait);
  }
  if (host === "loom.com") {
    const id = parts[0] === "share" || parts[0] === "embed" ? parts[1] : undefined;
    if (!id || !ID.test(id)) return null;
    return out("loom", `https://www.loom.com/embed/${id}`);
  }
  if (host === "drive.google.com") {
    const id = parts[0] === "file" && parts[1] === "d" ? parts[2] : u.searchParams.get("id");
    if (!id || !ID.test(id)) return null;
    return out("drive", `https://drive.google.com/file/d/${id}/preview`);
  }
  if (host === "docs.google.com") {
    const kind = parts[0];
    const id = parts[1] === "d" ? parts[2] : undefined;
    if (!id || !ID.test(id) || !["document", "spreadsheets", "presentation"].includes(kind ?? "")) return null;
    return out("gdocs", `https://docs.google.com/${kind}/d/${id}/preview`);
  }
  if (host === "pinterest.com" || /^[a-z]{2}\.pinterest\.com$/.test(host) || host.startsWith("pinterest.")) {
    const i = parts.indexOf("pin");
    const id = i >= 0 ? parts[i + 1] : undefined;
    if (!id || !/^\d+$/.test(id)) return null;
    return out("pinterest", `https://assets.pinterest.com/ext/embed.html?id=${id}`, true);
  }
  return null;
}

/** Card size on the board for a link. */
export function embedSize(url: string): { w: number; h: number } {
  const e = parseEmbed(url);
  if (!e) return { w: 360, h: 112 };
  if (e.portrait) return { w: 340, h: 640 };
  if (e.provider === "gdocs") return { w: 560, h: 720 };
  return { w: 560, h: 352 };
}

/** "instagram.com" from a link (for link cards). */
export function linkHost(url: string): string {
  return asLink(url)?.hostname.replace(/^www\./, "") ?? url;
}

/** The embed header's height (board units). */
export const EMBED_BAR = 36;
