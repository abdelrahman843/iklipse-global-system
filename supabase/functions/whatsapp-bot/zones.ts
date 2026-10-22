// People's time zones (0101). The bot works one out from a WhatsApp number's
// country when the country has a single time zone; for one with several
// (the US and Canada, Russia, Australia, Brazil, Mexico, Indonesia...) it
// asks: the client privately, or whoever on the team is booking. What it's
// told is kept (client.timezone, profile_contact.timezone). The team is on
// Cairo time unless iklipse knows better. Times people get are in their own
// time zone, named ("3:00 PM Dubai time").

import { str, TZ, type Db } from "./kit.ts";

/** Countries with one time zone, by calling code. */
const BY_CODE: Record<string, string> = {
  "20": "Africa/Cairo", "211": "Africa/Juba", "212": "Africa/Casablanca", "213": "Africa/Algiers", "216": "Africa/Tunis", "218": "Africa/Tripoli",
  "220": "Africa/Banjul", "221": "Africa/Dakar", "225": "Africa/Abidjan", "233": "Africa/Accra", "234": "Africa/Lagos", "237": "Africa/Douala",
  "249": "Africa/Khartoum", "250": "Africa/Kigali", "251": "Africa/Addis_Ababa", "252": "Africa/Mogadishu", "253": "Africa/Djibouti",
  "254": "Africa/Nairobi", "255": "Africa/Dar_es_Salaam", "256": "Africa/Kampala", "260": "Africa/Lusaka", "263": "Africa/Harare", "27": "Africa/Johannesburg",
  "30": "Europe/Athens", "31": "Europe/Amsterdam", "32": "Europe/Brussels", "33": "Europe/Paris", "34": "Europe/Madrid", "350": "Europe/Gibraltar",
  "351": "Europe/Lisbon", "352": "Europe/Luxembourg", "353": "Europe/Dublin", "354": "Atlantic/Reykjavik", "355": "Europe/Tirane", "356": "Europe/Malta",
  "357": "Asia/Nicosia", "358": "Europe/Helsinki", "359": "Europe/Sofia", "36": "Europe/Budapest", "370": "Europe/Vilnius", "371": "Europe/Riga",
  "372": "Europe/Tallinn", "373": "Europe/Chisinau", "374": "Asia/Yerevan", "375": "Europe/Minsk", "380": "Europe/Kyiv", "381": "Europe/Belgrade",
  "382": "Europe/Podgorica", "385": "Europe/Zagreb", "386": "Europe/Ljubljana", "387": "Europe/Sarajevo", "389": "Europe/Skopje", "39": "Europe/Rome",
  "40": "Europe/Bucharest", "41": "Europe/Zurich", "420": "Europe/Prague", "421": "Europe/Bratislava", "43": "Europe/Vienna", "44": "Europe/London",
  "45": "Europe/Copenhagen", "46": "Europe/Stockholm", "47": "Europe/Oslo", "48": "Europe/Warsaw", "49": "Europe/Berlin",
  "502": "America/Guatemala", "503": "America/El_Salvador", "504": "America/Tegucigalpa", "505": "America/Managua", "506": "America/Costa_Rica",
  "507": "America/Panama", "51": "America/Lima", "53": "America/Havana", "54": "America/Argentina/Buenos_Aires", "56": "America/Santiago",
  "57": "America/Bogota", "58": "America/Caracas", "591": "America/La_Paz", "593": "America/Guayaquil", "595": "America/Asuncion", "598": "America/Montevideo",
  "60": "Asia/Kuala_Lumpur", "63": "Asia/Manila", "64": "Pacific/Auckland", "65": "Asia/Singapore", "66": "Asia/Bangkok", "81": "Asia/Tokyo",
  "82": "Asia/Seoul", "84": "Asia/Ho_Chi_Minh", "852": "Asia/Hong_Kong", "853": "Asia/Macau", "855": "Asia/Phnom_Penh", "856": "Asia/Vientiane",
  "86": "Asia/Shanghai", "880": "Asia/Dhaka", "886": "Asia/Taipei", "90": "Europe/Istanbul", "91": "Asia/Kolkata", "92": "Asia/Karachi",
  "93": "Asia/Kabul", "94": "Asia/Colombo", "95": "Asia/Yangon", "960": "Indian/Maldives", "961": "Asia/Beirut", "962": "Asia/Amman",
  "963": "Asia/Damascus", "964": "Asia/Baghdad", "965": "Asia/Kuwait", "966": "Asia/Riyadh", "967": "Asia/Aden", "968": "Asia/Muscat",
  "970": "Asia/Gaza", "971": "Asia/Dubai", "972": "Asia/Jerusalem", "973": "Asia/Bahrain", "974": "Asia/Qatar", "975": "Asia/Thimphu",
  "977": "Asia/Kathmandu", "98": "Asia/Tehran", "992": "Asia/Dushanbe", "994": "Asia/Baku", "995": "Asia/Tbilisi", "996": "Asia/Bishkek",
  "998": "Asia/Tashkent",
};

/** The time zone a number's country has, when it has only one (null: several, or not a number). */
export function zoneFromPhone(phone: unknown): string | null {
  const d = str(phone).replace(/\D/g, "");
  if (d.length < 8) return null;
  for (const n of [3, 2, 1]) {
    const z = BY_CODE[d.slice(0, n)];
    if (z) return z;
  }
  return null;
}

/** An IANA time zone as Intl knows it ("asia/dubai" -> "Asia/Dubai"), or null. */
export function validZone(z: unknown): string | null {
  const s = str(z);
  if (!s || !s.includes("/")) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: s }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** "Dubai", "New York", "Buenos Aires": what a time zone is called in a message. */
export const zoneName = (z: string) => (z.split("/").pop() ?? z).replace(/_/g, " ");

/** "+04:00": a time zone's offset from UTC at a moment. */
export function offsetIn(zone: string, d = new Date()) {
  const v = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
  return v === "GMT" ? "+00:00" : v.replace("GMT", "");
}

/** Days and times in one time zone. */
export interface Clock {
  zone: string;
  /** "Cairo time", "Dubai time" */
  label: string;
  /** The moment a day and time there ("2026-10-20", "15:00") starts. */
  at: (date: string, time: string) => number;
  /** "2026-10-20" there. */
  dayOf: (ms: number) => string;
  /** "15:00" there. */
  hm: (ms: number) => string;
  /** "25-12-2026" */
  dmy: (ms: number) => string;
  /** "3:00 PM" */
  time12: (ms: number) => string;
  /** "Sunday" */
  weekday: (ms: number) => string;
  /** A day's noon there. */
  noon: (date: string) => number;
}

const clocks = new Map<string, Clock>();

export function clockIn(zone: string = TZ): Clock {
  const hit = clocks.get(zone);
  if (hit) return hit;
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const clock = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit", hour12: true });
  const weekdayName = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "long" });
  const at = (date: string, time: string) => Date.parse(`${date}T${time}:00${offsetIn(zone, new Date(`${date}T12:00:00Z`))}`);
  const dayOf = (ms: number) => ymd.format(new Date(ms));
  const c: Clock = {
    zone,
    label: `${zoneName(zone)} time`,
    at,
    dayOf,
    hm: (ms) => hm.format(new Date(ms)),
    dmy: (ms) => dayOf(ms).split("-").reverse().join("-"),
    time12: (ms) => clock.format(new Date(ms)).replace(/[  ]/g, " "),
    weekday: (ms) => weekdayName.format(new Date(ms)),
    noon: (date) => at(date, "12:00"),
  };
  clocks.set(zone, c);
  return c;
}

/** "Sunday 25-12-2026, 3:00 PM Dubai time" */
export function whenIn(ms: number, zone: string | null | undefined) {
  const c = clockIn(zone || TZ);
  return `${c.weekday(ms)} ${c.dmy(ms)}, ${c.time12(ms)} ${c.label}`;
}

/** The same moment for the others on it: " (5:00 PM Dubai, 2:00 PM London)", nothing when they're all on Cairo time. */
export function alsoIn(ms: number, zones: (string | null | undefined)[], base: string = TZ) {
  const day = clockIn(base).dayOf(ms);
  const seen = new Set<string>([clockIn(base).hm(ms) + day]);
  const bits: string[] = [];
  for (const z of zones) {
    if (!z || z === base) continue;
    const c = clockIn(z);
    const key = c.hm(ms) + c.dayOf(ms);
    if (seen.has(key)) continue;
    seen.add(key);
    bits.push(`${c.time12(ms)}${c.dayOf(ms) !== day ? ` ${c.weekday(ms)}` : ""} ${zoneName(z)}`);
  }
  return bits.length ? ` (${bits.join(", ")})` : "";
}

/** Someone's time zone as iklipse knows it: what it was told, else their number's country; the team is on Cairo time otherwise. */
export function zoneOf(p: { kind?: string; zone?: string | null; phone?: string | null }): string | null {
  return validZone(p.zone) ?? zoneFromPhone(p.phone) ?? (p.kind === "team" ? TZ : null);
}

/** Keeps the time zone someone said they're in (a client's, a team member's). */
export async function saveZone(db: Db, p: { kind: string; id: string | null }, zone: string) {
  if (!p.id) return;
  if (p.kind === "client") await db.from("client").update({ timezone: zone }).eq("id", p.id);
  else if (p.kind === "team") await db.from("profile_contact").upsert({ user_id: p.id, timezone: zone }, { onConflict: "user_id" });
}
