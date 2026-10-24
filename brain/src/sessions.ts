// One Claude session per chat, carried on from message to message: the
// owner's private chat, each person's private chat, and in a team group one
// per person (so nobody's lookups reach someone else's answers). The session
// ids stay on this server (Claude Code keeps the sessions themselves next to
// them). After 12 hours of quiet a chat starts a fresh session, with a short
// summary of the last one.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Exchange {
  q: string;
  a: string;
  at: number;
}

export interface Chat {
  session?: string;
  /** Last answered. */
  at: number;
  /** What the session had cost by its last answer (a resumed session's cost goes on from it). */
  cost?: number;
  log: Exchange[];
}

/** Quiet this long: a new topic, a fresh session. */
export const QUIET_MS = 12 * 60 * 60_000;

/** The chat a run's session is: privately the chat; in a group the person in it. */
export const sessionKey = (m: { reply_chat: string; sender: { id: string } }) => (m.reply_chat.endsWith("@g.us") ? `${m.reply_chat}:${m.sender.id}` : m.reply_chat);

/** Carry on the session, or start fresh (with what was said last time, to sum up). */
export function pick(chat: Chat | undefined, now: number): { resume?: string; fresh: boolean; earlier: Exchange[] } {
  if (!chat?.session) return { fresh: true, earlier: chat?.log.slice(-6) ?? [] };
  if (now - chat.at > QUIET_MS) return { fresh: true, earlier: chat.log.slice(-6) };
  return { resume: chat.session, fresh: false, earlier: [] };
}

export class Sessions {
  private chats: Record<string, Chat> = {};

  constructor(private file: string | null) {
    if (file && existsSync(file)) {
      try {
        this.chats = JSON.parse(readFileSync(file, "utf8")) as Record<string, Chat>;
      } catch {
        this.chats = {};
      }
    }
  }

  get(key: string): Chat | undefined {
    return this.chats[key];
  }

  put(key: string, chat: Chat) {
    this.chats[key] = { ...chat, log: chat.log.slice(-10) };
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.chats), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
