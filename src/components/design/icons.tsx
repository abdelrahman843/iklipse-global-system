import { renderToStaticMarkup } from "react-dom/server";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Cloud,
  CreditCard,
  Download,
  Heart,
  Home,
  Image,
  Info,
  Lock,
  LogOut,
  Mail,
  MapPin,
  Menu,
  MessageCircle,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Play,
  Plus,
  Search,
  Send,
  Settings,
  Share2,
  ShoppingCart,
  Star,
  Trash2,
  Upload,
  User,
  Users,
  Volume2,
  X,
  type LucideIcon,
} from "lucide-react";
import { viewCenter } from "@/lib/design/actions";
import { importSvgText } from "./importers";

// -----------------------------------------------------------------------------
// Icon assets: the app's icon set (lucide) inserted as editable vectors.
// -----------------------------------------------------------------------------

export const ICONS: [string, LucideIcon][] = [
  ["Home", Home],
  ["Search", Search],
  ["Menu", Menu],
  ["Close", X],
  ["Plus", Plus],
  ["Check", Check],
  ["Arrow left", ArrowLeft],
  ["Arrow right", ArrowRight],
  ["Chevron left", ChevronLeft],
  ["Chevron right", ChevronRight],
  ["Chevron down", ChevronDown],
  ["User", User],
  ["Users", Users],
  ["Settings", Settings],
  ["Bell", Bell],
  ["Mail", Mail],
  ["Message", MessageCircle],
  ["Send", Send],
  ["Phone", Phone],
  ["Hang up", PhoneOff],
  ["Mic", Mic],
  ["Mic off", MicOff],
  ["Volume", Volume2],
  ["Play", Play],
  ["Heart", Heart],
  ["Star", Star],
  ["Share", Share2],
  ["Download", Download],
  ["Upload", Upload],
  ["Trash", Trash2],
  ["Calendar", Calendar],
  ["Clock", Clock],
  ["Map pin", MapPin],
  ["Cart", ShoppingCart],
  ["Card", CreditCard],
  ["Image", Image],
  ["Info", Info],
  ["Lock", Lock],
  ["Cloud", Cloud],
  ["Log out", LogOut],
];

export function insertIcon(name: string) {
  const Icon = ICONS.find(([n]) => n === name)?.[1];
  if (!Icon) return;
  const svg = renderToStaticMarkup(<Icon size={24} color="#1E1E1E" strokeWidth={2} />);
  const c = viewCenter();
  importSvgText(svg, { x: c.x - 12, y: c.y - 12 }, name);
}
