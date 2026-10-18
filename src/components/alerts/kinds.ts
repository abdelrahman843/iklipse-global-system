import { CalendarClock, Handshake, Hourglass, Megaphone, MessageSquareWarning, type LucideIcon } from "lucide-react";
import type { AlertKind } from "@/lib/watchApi";

/** Each kind of alert's icon (the Alerts page, the home page). */
export const KIND_ICON: Record<AlertKind, LucideIcon> = {
  unanswered: MessageSquareWarning,
  promise: Handshake,
  follow_up: Hourglass,
  deadline: CalendarClock,
  ads: Megaphone,
};
