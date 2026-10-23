// How the bot writes, wherever people read its words: replies to clients
// (dm.ts), answers and messages to the team (orders.ts, look.ts), the agent's
// tasks, meetings (book.ts) and the alert calls (index.ts). One block, in each
// of those prompts, so they all sound like the same sharp person on the team:
// the answer first, short, every fact kept. voiceIssues() is the same rules in
// code, for the tests and the eval set (scripts/bot/evals).

/** The rules, as Claude reads them. Stable text: it stays in the cached part of each prompt. */
export const VOICE = `How you write (every word someone reads):
- The answer first. No greeting (a first message to someone may open with "Hi <first name>,"), no recap of what they said, no "let me", no "I'll pass it to the team", no sign-off, no offer of more help.
- Short words, short sentences, one idea each. One to three lines, like a text.
- Keep every fact: names, dates, times with their time zone, numbers, links. Never drop "not", "no" or "only".
- Sound like a sharp person on the team: not a bot, not a company, and not broken grammar either. At most one emoji, only when they're casual. No em dashes.
- A list only for 3 or more things to scan.
- Only the message: your reasoning stays out of it.
For example, not "Hello Sara! Thanks for reaching out. Let me check on your project. It looks like the logo is in final review and should be ready on Sunday. Let me know if you need anything else!" but "The logo's in final review. You'll have it Sunday."`;

/** What a message breaks of the rules above, by name; empty when it reads right. */
export type VoiceIssue = "greeting" | "filler" | "sign-off" | "reasoning" | "dash" | "emoji" | "long";

/** Words that say the bot is a bot or a company, not a person on the team. */
const FILLER = [
  /\bthank(s| you)( so much)? for (reaching out|your (message|patience|time))/i,
  /\bi hope (this|you)\b/i,
  /\blet me (check|see|look|find|get|pass|confirm|know if)\b/i,
  /\bpass (it|this|that)( on)? to the team\b/i,
  /\b(don't|do not) hesitate\b/i,
  /\bfeel free\b/i,
  /\banything else\b/i,
  /\b(happy|glad) to (help|assist)\b/i,
  /\bhow (may|can) i (help|assist)\b/i,
  /\b(great news|successfully)\b/i,
  /\bwelcome to iklipse\b/i,
];
const SIGN_OFF = /\b(best|kind|warm) regards\b|\bsincerely\b|^\s*cheers[,!.]?\s*$/im;
const GREETING = /^\s*(dear|hello|greetings|good (morning|afternoon|evening))\b/i;
const REASONING = /\b(based on (the|what|this)|it seems that|i should|as an ai|according to the (chat|data|messages))\b/i;
const EMOJI = /\p{Extended_Pictographic}/gu;

/**
 * Checks a message against the voice: a greeting, bot or company words, a
 * sign-off, reasoning left in, dashes, more than one emoji, or longer than
 * lines (default 3) or words (default 60).
 */
export function voiceIssues(text: string, o: { lines?: number; words?: number } = {}): VoiceIssue[] {
  const out: VoiceIssue[] = [];
  if (GREETING.test(text)) out.push("greeting");
  if (FILLER.some((r) => r.test(text))) out.push("filler");
  if (SIGN_OFF.test(text)) out.push("sign-off");
  if (REASONING.test(text)) out.push("reasoning");
  if (/[—–]/.test(text)) out.push("dash");
  if ((text.match(EMOJI) ?? []).length > 1) out.push("emoji");
  const lines = text.split("\n").filter((l) => l.trim()).length;
  const words = text.split(/\s+/).filter(Boolean).length;
  if (lines > (o.lines ?? 3) || words > (o.words ?? 60)) out.push("long");
  return out;
}
