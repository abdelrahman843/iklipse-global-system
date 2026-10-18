import { useEffect, useState } from "react";
import { PushSettingsModal } from "@/components/PushSettings";
import { syncPush } from "@/lib/push";
import { InstallAppButton } from "@/components/InstallApp";
import { SearchField } from "@/components/ui/SearchField";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { BellRing, LogOut, Users, Kanban, Sun, Moon, ChevronLeft, Plus, Camera, Shapes, NotebookPen, Mail, Link2, Share2, HardDrive, Receipt, FolderKanban, AudioLines, Video, Check, UserPlus, X, MonitorSmartphone, History, LayoutDashboard, CalendarClock, type LucideIcon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { fetchConnections } from "@/lib/connectionsApi";
import { fetchSharedWithMe } from "@/lib/mailShareApi";
import { fetchDriveSharedWithMe } from "@/lib/driveApi";
import { fetchProjectsCount } from "@/lib/projectsApi";
import { fetchOpenAlertCount } from "@/lib/watchApi";
import { ZOOM_ON } from "@/lib/features";
import { fetchMeetingsSharedWithMe } from "@/lib/firefliesApi";
import { useAuth } from "@/lib/auth";
import { useSavedAccounts } from "@/lib/accounts";
import { useToast } from "@/components/ui/Toast";
import { useTheme } from "@/lib/theme";
import { Avatar } from "@/components/ui/Avatar";
import { Menu, MenuDivider, MenuItem } from "@/components/ui/Menu";
import { cn } from "@/lib/cn";
import { NotificationBell } from "@/components/pm/NotificationBell";
import { WatchAlarm } from "@/components/WatchAlarm";
import { AppBridge } from "@/components/AppBridge";
import { ChangeAvatarModal } from "@/components/ChangeAvatarModal";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { BrandMark, Emblem } from "@/components/Brand";
import { motion } from "motion/react";
import { SLIDE } from "@/lib/motion";

// Sidebar starts open; collapsing it to icons is remembered per browser.
const RAIL_KEY = "sidebar-open";
function readRail() {
  try {
    return localStorage.getItem(RAIL_KEY) !== "0";
  } catch {
    return true;
  }
}

type NavItem = { to: string; icon: LucideIcon; label: string; active?: boolean; badge?: number };

export function AppShell() {
  const { profile, isAdmin, signOut, switchAccount, forgetAccount, can, trelloRole, miroRole, briefRole } = useAuth();
  const toast = useToast();
  // Other accounts signed in on this device: one tap switches to them.
  const others = useSavedAccounts().filter((a) => a.id !== profile?.id);
  const { theme, toggle } = useTheme();
  const nav = useNavigate();
  const location = useLocation();
  const [searchQ, setSearchQ] = useState("");
  const [open, setOpenState] = useState(readRail);
  const setOpen = (v: boolean) => {
    setOpenState(v);
    try {
      localStorage.setItem(RAIL_KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  const confirm = useConfirm();
  const handleSignOut = async () => {
    const ok = await confirm({
      title: "Log out?",
      message: others.length
        ? `You'll need your username and password to sign in to this account again. ${others[0].name}'s account opens instead.`
        : "You'll need your username and password to sign in again on this device.",
      confirmLabel: "Log out",
      danger: true,
    });
    if (!ok) return;
    const switched = await signOut();
    nav(switched ? "/" : "/login", { replace: true });
  };
  const switchTo = async (id: string) => {
    try {
      await switchAccount(id);
      nav("/", { replace: true });
    } catch (e) {
      toast.push({ kind: "error", title: "Couldn't switch", description: (e as Error).message });
    }
  };

  // A new picture shows at once; the profile itself catches up through the
  // auth context's live profile subscription, which clears this override.
  const [avatarOverride, setAvatarOverride] = useState<string | null | undefined>(undefined);
  useEffect(() => setAvatarOverride(undefined), [profile?.avatar_url]);
  const avatarSrc = avatarOverride !== undefined ? avatarOverride : profile?.avatar_url;
  // Mail / Drive show once a Gmail / Drive account is connected (Connected accounts).
  const conns = useQuery({ queryKey: ["connections"], queryFn: fetchConnections, enabled: !!profile, staleTime: 60_000 });
  const hasMail = (conns.data?.gmail?.length ?? 0) > 0;
  const hasDrive = (conns.data?.drive?.length ?? 0) > 0;
  // Zoom only while it's on (lib/features.ts); Calendly took its place.
  const hasZoom = ZOOM_ON && (conns.data?.zoom?.length ?? 0) > 0;
  const hasCalendly = (conns.data?.calendly?.length ?? 0) > 0;
  // Shared shows once someone shares mail or Drive with me.
  const sharedMail = useQuery({ queryKey: ["mail-shared-with-me"], queryFn: fetchSharedWithMe, enabled: !!profile, refetchInterval: 60_000 });
  const sharedDrive = useQuery({ queryKey: ["drive-shared-with-me"], queryFn: fetchDriveSharedWithMe, enabled: !!profile, refetchInterval: 60_000 });
  const sharedMeetings = useQuery({ queryKey: ["meetings-shared"], queryFn: fetchMeetingsSharedWithMe, enabled: !!profile, refetchInterval: 120_000 });
  const hasShared = (sharedMail.data?.length ?? 0) + (sharedDrive.data?.length ?? 0) + (sharedMeetings.data?.length ?? 0) > 0;
  // Meetings: my Fireflies accounts, or meetings shared with me.
  const hasMeetings = (conns.data?.fireflies?.length ?? 0) > 0 || (sharedMeetings.data?.length ?? 0) > 0;
  // Projects: admins always; everyone else once they're on one.
  const projectCount = useQuery({ queryKey: ["projects-count"], queryFn: fetchProjectsCount, enabled: !!profile && !isAdmin, refetchInterval: 120_000 });
  const hasProjects = isAdmin || (projectCount.data ?? 0) > 0;
  // Alerts shows how many are open, like the bell (the Alerts page and the
  // notifications refresh it: same "watch-alerts" key).
  const alertCount = useQuery({ queryKey: ["watch-alerts", "count"], queryFn: fetchOpenAlertCount, enabled: !!profile, refetchInterval: 30_000, refetchOnWindowFocus: true });
  const openAlerts = alertCount.data ?? 0;
  const onHome = location.pathname === "/";
  const [pictureOpen, setPictureOpen] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);
  // A device that already allows notifications stays registered to whoever is signed in.
  useEffect(() => {
    void syncPush();
  }, [profile?.id]);

  // Rail on desktop, header on mobile. The sidebar lists every page, so on
  // desktop the menu only has the account's own settings; phones (no sidebar)
  // also reach every page the bottom tab bar doesn't hold.
  const accountMenu = (align: "left" | "right", size: number, className?: string, withName?: boolean, withPages?: boolean) => (
    <Menu
      align={align}
      className={withName ? "flex-1 min-w-0" : undefined}
      trigger={
        <button
          className={cn("rounded-md p-1 hover:bg-inset transition-colors duration-150", withName && "w-full flex items-center gap-2.5 text-left", className)}
          aria-label="Account"
        >
          <Avatar name={profile?.display_name ?? "?"} src={avatarSrc} size={size} />
          {withName && (
            <span className="min-w-0 flex-1 animate-fade-in block truncate text-[13px] font-semibold text-ink">{profile?.display_name}</span>
          )}
        </button>
      }
    >
      {(close) => (
        <>
          <div className="px-3 py-2 flex items-center gap-2.5">
            <Avatar name={profile?.display_name ?? "?"} src={avatarSrc} size={28} />
            <div className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{profile?.display_name}</div>
            <Check size={14} className="shrink-0 text-accent" aria-label="Signed in" />
          </div>
          {others.map((a) => (
            <div key={a.id} className="group relative">
              <MenuItem
                onClick={() => {
                  close();
                  void switchTo(a.id);
                }}
              >
                <span className="flex items-center gap-2.5 pr-6">
                  <Avatar name={a.name} src={a.avatar_url} size={22} />
                  <span className="min-w-0 truncate">Switch to {a.name}</span>
                </span>
              </MenuItem>
              <button
                type="button"
                onClick={async () => {
                  close();
                  const ok = await confirm({ title: `Remove ${a.name}?`, message: "They'll need their username and password to sign in on this device again.", confirmLabel: "Remove" });
                  if (ok) await forgetAccount(a.id);
                }}
                aria-label={`Remove ${a.name} from this device`}
                title="Remove from this device"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 h-7 w-7 grid place-items-center rounded-md text-subtle hover:text-ink hover:bg-inset sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100"
              >
                <X size={13} />
              </button>
            </div>
          ))}
          <MenuItem
            onClick={() => {
              close();
              nav("/login?add=1");
            }}
          >
            <span className="inline-flex items-center gap-2">
              <UserPlus size={14} /> Add another account
            </span>
          </MenuItem>
          <MenuDivider />
          <MenuItem
            onClick={() => {
              close();
              setPictureOpen(true);
            }}
          >
            <span className="inline-flex items-center gap-2">
              <Camera size={14} /> Change picture
            </span>
          </MenuItem>
          <MenuItem
            onClick={() => {
              close();
              setPushOpen(true);
            }}
          >
            <span className="inline-flex items-center gap-2">
              <BellRing size={14} /> Notifications on this device
            </span>
          </MenuItem>
          {withPages && morePages.length > 0 && (
            <>
              <MenuDivider />
              {morePages.map(({ to, icon: Icon, label }) => (
                <MenuItem
                  key={to}
                  onClick={() => {
                    close();
                    nav(to);
                  }}
                >
                  <span className="inline-flex items-center gap-2">
                    <Icon size={14} /> {label}
                  </span>
                </MenuItem>
              ))}
            </>
          )}
          <MenuDivider />
          <MenuItem
            onClick={() => {
              close();
              void handleSignOut();
            }}
          >
            <span className="inline-flex items-center gap-2">
              <LogOut size={14} /> Log out
            </span>
          </MenuItem>
        </>
      )}
    </Menu>
  );

  const themeLabel = theme === "dark" ? "Light mode" : "Dark mode";
  const onWb = location.pathname.startsWith("/wb");
  // My work lives inside Trello (board dock, Trello home), so Trello stays lit there.
  const onTrello = /^\/pm\/(boards|my-work)(\/|$)/.test(location.pathname);
  // The search + Create bar belongs to Trello (all /pm pages); Miro has its own.
  const trelloBar = location.pathname.startsWith("/pm");

  // The sidebar's sections, Center style: a heading over each group.
  const groups: { title: string; items: NavItem[] }[] = [
    {
      title: "Workspace",
      items: [
        { to: "/", icon: LayoutDashboard, label: "Home", active: onHome },
        trelloRole && { to: "/pm/boards", icon: Kanban, label: "Trello", active: onTrello },
        miroRole && { to: "/wb", icon: Shapes, label: "Miro" },
        briefRole && { to: "/briefs", icon: NotebookPen, label: "Briefs" },
        hasProjects && { to: "/projects", icon: FolderKanban, label: "Projects" },
        hasMeetings && { to: "/meetings", icon: AudioLines, label: "Meetings" },
        hasCalendly && { to: "/calendly", icon: CalendarClock, label: "Calendly" },
        hasZoom && { to: "/zoom", icon: Video, label: "Zoom" },
        { to: "/alerts", icon: BellRing, label: "Alerts", badge: openAlerts },
        { to: "/apps", icon: MonitorSmartphone, label: "Apps" },
      ].filter(Boolean) as NavItem[],
    },
    {
      title: "Google",
      items: [
        hasMail && { to: "/mail", icon: Mail, label: "Mail" },
        hasDrive && { to: "/drive", icon: HardDrive, label: "Drive" },
      ].filter(Boolean) as NavItem[],
    },
    { title: "Shared", items: hasShared ? [{ to: "/shared", icon: Share2, label: "Shared with you" }] : [] },
    { title: "Account", items: [{ to: "/connections", icon: Link2, label: "Connected accounts" }] },
    {
      title: "Admin",
      items: isAdmin
        ? [
            { to: "/users", icon: Users, label: "Users" },
            { to: "/invoices", icon: Receipt, label: "Invoices" },
            { to: "/activity", icon: History, label: "Activity log" },
          ]
        : [],
    },
  ].filter((g) => g.items.length);

  // Phones: the bottom tab bar holds the main places; the account menu the rest.
  const bottomTabs = [
    { to: "/", icon: LayoutDashboard, label: "Home", active: onHome },
    trelloRole && { to: "/pm/boards", icon: Kanban, label: "Trello", active: onTrello },
    miroRole && { to: "/wb", icon: Shapes, label: "Miro" },
    hasProjects && { to: "/projects", icon: FolderKanban, label: "Projects" },
    { to: "/alerts", icon: BellRing, label: "Alerts", badge: openAlerts },
  ].filter(Boolean) as NavItem[];
  const morePages = groups.flatMap((g) => g.items).filter((it) => !bottomTabs.some((b) => b.to === it.to));

  const themeButton = (className: string) => (
    <button
      onClick={toggle}
      className={cn("grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink transition-colors duration-150 shrink-0", className)}
      aria-label={themeLabel}
      title={themeLabel}
    >
      <span key={theme} className="theme-icon-in">{theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}</span>
    </button>
  );

  // Trello's search + Create. Phones search from the tab bar's Search tab, so
  // the field only shows from `sm` up.
  const createButton = can("pm.create_board", "kanban") && (
    <button
      // On Miro routes Create makes a Miro board, else a Trello board.
      onClick={() => nav(onWb ? "/wb?create=1" : "/pm/boards?create=1")}
      aria-label={onWb ? "Create Miro board" : "Create Trello board"}
      className="h-10 w-10 sm:h-9 sm:w-auto sm:px-4 shrink-0 inline-flex items-center justify-center gap-1.5 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent-hover active:scale-[0.97] transition-[background-color,transform] duration-150"
    >
      <Plus size={15} className="sm:hidden" />
      <span className="hidden sm:inline">Create</span>
    </button>
  );
  const searchForm = (
    <form
      className="hidden sm:block flex-1 min-w-0"
      onSubmit={(e) => {
        e.preventDefault();
        nav(`/pm/search${searchQ ? `?q=${encodeURIComponent(searchQ)}` : ""}`);
      }}
    >
      <SearchField value={searchQ} onChange={setSearchQ} placeholder="Search cards" aria-label="Search" />
    </form>
  );

  return (
    // Center's frame: on desktop a dark border runs round everything, the
    // sidebar sits in it, and the page is a rounded panel that scrolls on its
    // own. Fixed to the viewport so pages (the board especially) get a
    // definite height and scroll inside themselves.
    <div className="h-dvh flex bg-bg md:bg-frame md:p-3 md:gap-3 text-muted overflow-hidden print-flow">
      {/* Desktop sidebar: collapses to icons, from a round tab on its edge. */}
      <div className="relative hidden md:block print:!hidden shrink-0 h-full">
      <aside
        className={cn(
          "frame-dark flex flex-col h-full bg-frame overflow-hidden rounded-r-[20px]",
          "transition-[width] duration-300 ease-pop",
          open ? "w-[248px]" : "w-[68px]",
        )}
      >
        <div className={cn("flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col gap-6 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-4", open ? "px-3" : "px-2")}>
          <div className="flex items-center justify-center h-12">
            <Link to="/" title="iklipse" className="rounded-md hover:opacity-85 transition-opacity">
              {open ? <BrandMark size="lg" className="animate-fade-in" /> : <Emblem className="w-8 text-accent" />}
            </Link>
          </div>
          <div aria-hidden className="h-px mx-2 bg-gradient-to-r from-transparent via-border to-transparent" />

          <nav className="flex flex-col gap-5" aria-label="Main">
            {groups.map((g, i) => (
              <div key={g.title} className="flex flex-col gap-1">
                {open ? (
                  <span className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-subtle animate-fade-in">{g.title}</span>
                ) : (
                  i > 0 && <span aria-hidden className="mx-auto mb-2 h-px w-6 bg-border" />
                )}
                {g.items.map((it) => (
                  <RailLink key={it.to} to={it.to} icon={it.icon} open={open} active={it.active} badge={it.badge}>
                    {it.label}
                  </RailLink>
                ))}
              </div>
            ))}
          </nav>
        </div>

        {/* Bottom of the sidebar: who I am, notifications, install, theme. */}
        <div className={cn("flex items-center gap-1 border-t border-line p-3", !open && "flex-col px-2")}>
          {accountMenu("left", 32, undefined, open)}
          <NotificationBell />
          <InstallAppButton className="h-8 w-8" />
          {themeButton("h-8 w-8")}
        </div>
      </aside>
      {/* Level with the logo, half over the sidebar's edge; the arrow turns
          to point the way the sidebar will go. */}
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          "frame-dark absolute z-20 right-0 top-[calc(2.25rem+env(safe-area-inset-top))] translate-x-1/2 -translate-y-1/2",
          "h-7 w-7 grid place-items-center rounded-full border border-rule bg-surface text-muted shadow-pop",
          "transition-[color,background-color,border-color,transform] duration-200 hover:bg-accent hover:border-accent hover:text-white hover:scale-110",
        )}
        aria-label={open ? "Collapse sidebar" : "Expand sidebar"}
        title={open ? "Collapse sidebar" : "Expand sidebar"}
      >
        <ChevronLeft size={15} strokeWidth={2.25} className={cn("transition-transform duration-300 ease-pop", !open && "rotate-180")} />
      </button>
      </div>

      {/* The page panel. Phones: no frame, and bottom padding clears the
          fixed tab bar, including the iOS home-indicator inset. */}
      <div id="page-panel" className="relative isolate flex-1 min-w-0 h-full flex flex-col overflow-hidden bg-bg md:rounded-[20px] md:ring-1 md:ring-white/[0.06] md:shadow-[0_10px_40px_-12px_rgba(0,0,0,0.5)] pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0 print-flow">
        <div className="app-glow" aria-hidden />

        {/* Phones: the frame's top bar. */}
        <header className="frame-dark md:hidden print:!hidden h-[calc(3.5rem+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)] shrink-0 bg-frame flex items-center gap-2 sm:gap-3 px-3 sm:px-4 shadow-[0_8px_28px_-10px_rgba(0,0,0,0.5)]">
          <Link to="/" title="iklipse" className="shrink-0 rounded-md">
            <BrandMark />
          </Link>
          <div className="flex-1 min-w-0 flex items-center justify-end sm:justify-start gap-2">
            {trelloBar && searchForm}
            {trelloBar && createButton}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <InstallAppButton className="h-10 w-10 shrink-0" />
            {themeButton("h-10 w-10")}
            <NotificationBell />
            {accountMenu("right", 26, "h-10 w-10 grid place-items-center", false, true)}
          </div>
        </header>

        {/* Desktop: Trello's search + Create bar, on every /pm page. */}
        {trelloBar && (
          <header className="hidden md:grid print:!hidden h-14 shrink-0 border-b border-border bg-[rgb(var(--c-bg)/0.6)] backdrop-blur-md grid-cols-[1fr_minmax(0,720px)_1fr] items-center gap-3 px-4">
            <div />
            <div className="flex items-center gap-2 min-w-0">
              {searchForm}
              {createButton}
            </div>
            <div />
          </header>
        )}

        <main className="flex-1 min-h-0 overflow-auto print-flow">
          {/* Key on the base route only — opening a card is a modal sub-route
              (/cards/:id) on the same board, so it must NOT remount + replay the
              page-fade animation (that was the jitter when opening a card). */}
          <div key={location.pathname.replace(/\/cards\/[^/]+$/, "")} className="h-full animate-page-fade">
            <Outlet />
          </div>
        </main>
      </div>

      {/* Phones: the frame's bottom tab bar. The iOS inset is added on top of
          the 56px row (not carved out of it), matching the panel's padding. */}
      <nav className="frame-dark md:hidden print:!hidden fixed bottom-0 inset-x-0 z-40 bg-frame/95 backdrop-blur-md border-t border-line flex items-center justify-around h-[calc(3.5rem+env(safe-area-inset-bottom))] shadow-pop safe-bottom">
        {bottomTabs.map(({ to, icon: Icon, label, active, badge }) => (
          <MobileTab key={to} to={to} icon={<Icon size={20} />} label={label} active={active} badge={badge} />
        ))}
      </nav>

      <WatchAlarm />
      {profile && <AppBridge userId={profile.id} />}

      <ChangeAvatarModal
        open={pictureOpen}
        onClose={() => setPictureOpen(false)}
        current={avatarSrc}
        onChanged={setAvatarOverride}
      />
      <PushSettingsModal open={pushOpen} onClose={() => setPushOpen(false)} />
    </div>
  );
}

function RailLink({
  to,
  icon: Icon,
  open,
  active,
  badge,
  children,
}: {
  to: string;
  icon: LucideIcon;
  open: boolean;
  /** Overrides the router's match (a section spanning several routes). */
  active?: boolean;
  /** A count beside the label (a dot on the icon when the rail is shut). */
  badge?: number;
  children: React.ReactNode;
}) {
  const count = badge ? (badge > 99 ? "99+" : String(badge)) : null;
  return (
    <NavLink
      to={to}
      title={open ? undefined : `${String(children)}${count ? ` (${count})` : ""}`}
      className={({ isActive: routeActive }) => {
        const isActive = active ?? routeActive;
        return cn(
          "relative group flex items-center gap-3 h-10 rounded-[12px] text-[14px] font-medium whitespace-nowrap",
          "transition-[background-color,color,box-shadow] duration-150",
          open ? "px-3" : "w-10 mx-auto justify-center",
          isActive ? "text-white" : "text-muted hover:bg-inset hover:text-ink",
        );
      }}
    >
      {({ isActive: routeActive }) => (
        <>
          {/* The filled pill slides to the page you open (Video Library's rail). */}
          {(active ?? routeActive) && (
            <motion.span
              layoutId="rail-active"
              className="absolute inset-0 rounded-[12px] bg-accent shadow-[0_8px_24px_-12px_rgb(var(--c-accent)/0.9)] group-hover:bg-accent-hover"
              transition={SLIDE}
            />
          )}
          <Icon size={18} className="relative shrink-0" />
          {open && <span className="relative animate-fade-in">{children}</span>}
          {count &&
            (open ? (
              <span
                key={count}
                className="relative ml-auto h-5 min-w-[20px] px-1.5 rounded-full bg-danger text-white text-[11px] font-semibold tabular-nums inline-flex items-center justify-center animate-scale-in"
              >
                {count}
              </span>
            ) : (
              <span
                key={count}
                className="absolute top-0.5 right-0.5 h-4 min-w-[16px] px-1 rounded-full bg-danger text-white text-[10px] font-semibold tabular-nums inline-flex items-center justify-center animate-scale-in"
              >
                {count}
              </span>
            ))}
        </>
      )}
    </NavLink>
  );
}

function MobileTab({ to, icon, label, active, badge }: { to: string; icon: React.ReactNode; label: string; active?: boolean; badge?: number }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "flex flex-col items-center justify-center gap-0.5 flex-1 h-full text-[10px] font-medium transition-colors",
          (active ?? isActive) ? "text-accent" : "text-muted hover:text-ink",
        )
      }
    >
      <span className="relative">
        {icon}
        {!!badge && (
          <span
            key={badge}
            className="absolute -top-1.5 -right-2.5 h-4 min-w-[16px] px-1 rounded-full bg-danger text-white text-[10px] font-semibold tabular-nums inline-flex items-center justify-center animate-scale-in"
          >
            {badge > 99 ? "99+" : badge}
          </span>
        )}
      </span>
      <span>{label}</span>
    </NavLink>
  );
}
