import { useEffect, useState } from "react";
import { PushSettingsModal } from "@/components/PushSettings";
import { syncPush } from "@/lib/push";
import { InstallAppButton } from "@/components/InstallApp";
import { SearchField } from "@/components/ui/SearchField";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { BellRing, LogOut, Users, Kanban, Search, Sun, Moon, PanelLeftClose, PanelLeftOpen, Plus, Camera, Shapes, NotebookPen, Mail, Link2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { fetchConnections } from "@/lib/connectionsApi";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/lib/theme";
import { Avatar } from "@/components/ui/Avatar";
import { Menu, MenuDivider, MenuItem } from "@/components/ui/Menu";
import { cn } from "@/lib/cn";
import { NotificationBell } from "@/components/pm/NotificationBell";
import { ChangeAvatarModal } from "@/components/ChangeAvatarModal";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { waitingCount } from "@/lib/offline/outbox";

// Sidebar starts collapsed; the choice is remembered per browser.
const RAIL_KEY = "sidebar-open";
function readRail() {
  try {
    return localStorage.getItem(RAIL_KEY) === "1";
  } catch {
    return false;
  }
}

export function AppShell() {
  const { profile, isAdmin, signOut, can, trelloRole, miroRole, briefRole } = useAuth();
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
    // Unsent changes stay on this device for this account (they go up at the
    // next sign-in here), but say so before leaving.
    const n = await waitingCount().catch(() => 0);
    if (n > 0) {
      const ok = await confirm({
        title: "Some changes haven't synced",
        message: `${n} ${n === 1 ? "change made" : "changes made"} on this device ${n === 1 ? "isn't" : "aren't"} on the server yet. They stay saved here and sync the next time you sign in on this device. Sign out anyway?`,
        confirmLabel: "Sign out",
      });
      if (!ok) return;
    }
    await signOut();
    nav("/login", { replace: true });
  };

  // A new picture shows at once; the profile itself catches up through the
  // auth context's live profile subscription, which clears this override.
  const [avatarOverride, setAvatarOverride] = useState<string | null | undefined>(undefined);
  useEffect(() => setAvatarOverride(undefined), [profile?.avatar_url]);
  const avatarSrc = avatarOverride !== undefined ? avatarOverride : profile?.avatar_url;
  // Mail shows once a Gmail account is connected (Connected accounts).
  const conns = useQuery({ queryKey: ["connections"], queryFn: fetchConnections, enabled: !!profile, staleTime: 5 * 60_000 });
  const hasMail = (conns.data?.gmail.length ?? 0) > 0;
  const [pictureOpen, setPictureOpen] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);
  // A device that already allows notifications stays registered to whoever is signed in.
  useEffect(() => {
    void syncPush();
  }, [profile?.id]);

  // Rail on desktop, header on mobile.
  const accountMenu = (align: "left" | "right", size: number, className?: string) => (
    <Menu
      align={align}
      trigger={
        <button className={cn("rounded-md p-1 hover:bg-inset transition-colors duration-150", className)} aria-label="Account">
          <Avatar name={profile?.display_name ?? "?"} src={avatarSrc} size={size} />
        </button>
      }
    >
      {(close) => (
        <>
          <div className="px-3 py-2">
            <div className="text-sm font-semibold text-ink">{profile?.display_name}</div>
            <div className="text-xs text-subtle">@{profile?.username}</div>
          </div>
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
          <MenuItem
            onClick={() => {
              close();
              nav("/connections");
            }}
          >
            <span className="inline-flex items-center gap-2">
              <Link2 size={14} /> Connected accounts
            </span>
          </MenuItem>
          <MenuItem
            onClick={() => {
              close();
              handleSignOut();
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

  return (
    // Fixed to the viewport so pages (the board especially) get a definite
    // height and scroll inside themselves instead of stretching the page.
    <div className="h-dvh flex bg-bg text-muted overflow-hidden print-flow">
      {/* Desktop rail — collapses to icons */}
      <aside
        className={cn(
          "hidden md:flex print:!hidden flex-col shrink-0 h-full bg-surface border-r border-border shadow-card pt-[calc(1rem+env(safe-area-inset-top))] pb-4 gap-5 overflow-hidden",
          "transition-[width] duration-300 ease-pop",
          open ? "w-[232px] px-3" : "w-16 px-2",
        )}
      >
        <div className={cn("flex items-center gap-2", open ? "px-1" : "flex-col")}>
          <Link to="/" className="display leading-none shrink-0 hover:text-accent transition-colors" title="iklipse">
            {open ? (
              <span className="text-[20px] px-1 animate-fade-in">iklipse</span>
            ) : (
              <span className="h-9 w-9 rounded-lg bg-accent text-white grid place-items-center text-base font-bold">I</span>
            )}
          </Link>
          <button
            onClick={() => setOpen(!open)}
            className={cn(
              "h-8 w-8 grid place-items-center rounded-md text-muted hover:text-ink hover:bg-inset transition-colors",
              open && "ml-auto",
            )}
            aria-label={open ? "Collapse sidebar" : "Expand sidebar"}
            title={open ? "Collapse sidebar" : "Expand sidebar"}
          >
            {open ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          </button>
        </div>

        <nav className="flex flex-col gap-1">
          {trelloRole && (
            <RailLink to="/pm/boards" icon={<Kanban size={16} />} open={open} active={onTrello}>
              Trello
            </RailLink>
          )}
          {miroRole && (
            <RailLink to="/wb" icon={<Shapes size={16} />} open={open}>
              Miro
            </RailLink>
          )}
          {briefRole && (
            <RailLink to="/briefs" icon={<NotebookPen size={16} />} open={open}>
              Briefs
            </RailLink>
          )}
          {hasMail && (
            <RailLink to="/mail" icon={<Mail size={16} />} open={open}>
              Mail
            </RailLink>
          )}
          {isAdmin && (
            <RailLink to="/users" icon={<Users size={16} />} open={open}>
              Users
            </RailLink>
          )}
        </nav>

        {/* Bottom of the rail — profile, notifications, theme toggle. */}
        <div className={cn("mt-auto flex items-center gap-1 border-t border-line pt-3", !open && "flex-col")}>
          {accountMenu("left", 30)}
          <NotificationBell />
          <InstallAppButton className="h-8 w-8" />
          <button
            onClick={toggle}
            className="h-8 w-8 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink transition-colors duration-150"
            aria-label={themeLabel}
            title={themeLabel}
          >
            <span key={theme} className="theme-icon-in">{theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}</span>
          </button>
        </div>
      </aside>

      {/* Main column. Phones: bottom padding clears the fixed tab bar,
          including the iOS home-indicator inset. */}
      <div className="flex-1 min-w-0 h-full flex flex-col pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0 print-flow">
        <header className={cn("print:!hidden h-[calc(3.5rem+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)] shrink-0 border-b border-border bg-surface grid grid-cols-[auto_minmax(0,1fr)_auto] md:grid-cols-[1fr_minmax(0,720px)_1fr] items-center gap-2 sm:gap-3 px-3 sm:px-4 shadow-card", !trelloBar && "md:hidden")}>
          <div className="md:hidden display text-[18px] text-ink shrink-0">iklipse</div>
          <div className="hidden md:block" />

          {/* Centered search + Create, Trello style. Phones search from the
              tab bar's Search tab, so the field only shows from `sm` up. */}
          <div className={cn("flex items-center justify-end sm:justify-start gap-2 min-w-0", !trelloBar && "invisible")}>
            <form
              className="hidden sm:block flex-1 min-w-0"
              onSubmit={(e) => {
                e.preventDefault();
                nav(`/pm/search${searchQ ? `?q=${encodeURIComponent(searchQ)}` : ""}`);
              }}
            >
              <SearchField value={searchQ} onChange={setSearchQ} placeholder="Search cards" aria-label="Search" />
            </form>
            {can("pm.create_board", "kanban") && (
              <button
                // On Miro routes Create makes a Miro board, else a Trello board.
                onClick={() => nav(onWb ? "/wb?create=1" : "/pm/boards?create=1")}
                aria-label={onWb ? "Create Miro board" : "Create Trello board"}
                className="h-10 w-10 sm:h-9 sm:w-auto sm:px-4 shrink-0 inline-flex items-center justify-center gap-1.5 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent-hover active:scale-[0.97] transition-[background-color,transform] duration-150"
              >
                <Plus size={15} className="sm:hidden" />
                <span className="hidden sm:inline">Create</span>
              </button>
            )}
          </div>

          {/* Mobile only — on desktop these live at the bottom of the rail. */}
          <div className="flex items-center justify-end gap-2 sm:gap-3">
            <div className="flex items-center gap-1 md:hidden">
              <InstallAppButton className="h-10 w-10 shrink-0" />
              <button
                onClick={toggle}
                className="h-10 w-10 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink transition-colors duration-150 shrink-0"
                aria-label={themeLabel}
                title={themeLabel}
              >
                <span key={theme} className="theme-icon-in">{theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}</span>
              </button>
              <NotificationBell />
              {accountMenu("right", 26, "h-10 w-10 grid place-items-center")}
            </div>
          </div>
        </header>

        <main className="flex-1 min-h-0 overflow-auto print-flow">
          {/* Key on the base route only — opening a card is a modal sub-route
              (/cards/:id) on the same board, so it must NOT remount + replay the
              page-fade animation (that was the jitter when opening a card). */}
          <div key={location.pathname.replace(/\/cards\/[^/]+$/, "")} className="h-full animate-page-fade">
            <Outlet />
          </div>
        </main>
      </div>

      {/* Mobile bottom tab bar. The iOS inset is added on top of the 56px
          row (not carved out of it), matching the main column's padding. */}
      <nav className="md:hidden print:!hidden fixed bottom-0 inset-x-0 z-40 bg-surface border-t border-border flex items-center justify-around h-[calc(3.5rem+env(safe-area-inset-bottom))] shadow-pop safe-bottom">
        {trelloRole && <MobileTab to="/pm/boards" icon={<Kanban size={20} />} label="Trello" active={onTrello} />}
        {miroRole && <MobileTab to="/wb" icon={<Shapes size={20} />} label="Miro" />}
        {trelloRole && <MobileTab to="/pm/search" icon={<Search size={20} />} label="Search" />}
        {briefRole && <MobileTab to="/briefs" icon={<NotebookPen size={20} />} label="Briefs" />}
        {hasMail && <MobileTab to="/mail" icon={<Mail size={20} />} label="Mail" />}
        {isAdmin && <MobileTab to="/users" icon={<Users size={20} />} label="Users" />}
      </nav>

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
  icon,
  open,
  active,
  children,
}: {
  to: string;
  icon: React.ReactNode;
  open: boolean;
  /** Overrides the router's match (a section spanning several routes). */
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <NavLink
      to={to}
      title={open ? undefined : String(children)}
      className={({ isActive: routeActive }) => {
        const isActive = active ?? routeActive;
        return cn(
          "flex items-center gap-3 h-10 rounded-md border border-transparent",
          "eyebrow font-semibold text-muted whitespace-nowrap",
          "hover:text-ink hover:bg-inset hover:border-line",
          "transition-colors duration-150",
          open ? "px-2" : "justify-center",
          isActive && "bg-accent text-white border-accent shadow-card hover:bg-accent-hover hover:text-white hover:border-accent-hover",
        );
      }}
    >
      <span className="grid place-items-center w-6 h-6 rounded-md shrink-0">{icon}</span>
      {open && <span className="animate-fade-in">{children}</span>}
    </NavLink>
  );
}

function MobileTab({ to, icon, label, active }: { to: string; icon: React.ReactNode; label: string; active?: boolean }) {
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
      {icon}
      <span>{label}</span>
    </NavLink>
  );
}
