import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { LogOut, Users, Kanban, Search, Sun, Moon, PanelLeftClose, PanelLeftOpen, Plus, ListTodo, Camera } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/lib/theme";
import { Avatar } from "@/components/ui/Avatar";
import { Menu, MenuDivider, MenuItem } from "@/components/ui/Menu";
import { cn } from "@/lib/cn";
import { NotificationBell } from "@/components/pm/NotificationBell";
import { ChangeAvatarModal } from "@/components/ChangeAvatarModal";

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
  const { profile, isAdmin, signOut, can } = useAuth();
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

  const handleSignOut = async () => {
    await signOut();
    nav("/login", { replace: true });
  };

  // A new picture shows at once; the profile itself catches up through the
  // auth context's live profile subscription, which clears this override.
  const [avatarOverride, setAvatarOverride] = useState<string | null | undefined>(undefined);
  useEffect(() => setAvatarOverride(undefined), [profile?.avatar_url]);
  const avatarSrc = avatarOverride !== undefined ? avatarOverride : profile?.avatar_url;
  const [pictureOpen, setPictureOpen] = useState(false);

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

  return (
    // Fixed to the viewport so pages (the board especially) get a definite
    // height and scroll inside themselves instead of stretching the page.
    <div className="h-dvh flex bg-bg text-muted overflow-hidden">
      {/* Desktop rail — collapses to icons */}
      <aside
        className={cn(
          "hidden md:flex flex-col shrink-0 h-full bg-surface border-r border-border shadow-card pt-[calc(1rem+env(safe-area-inset-top))] pb-4 gap-5 overflow-hidden",
          "transition-[width] duration-300 ease-pop",
          open ? "w-[232px] px-3" : "w-16 px-2",
        )}
      >
        <div className={cn("flex items-center gap-2", open ? "px-1" : "flex-col")}>
          <Link to="/" className="display leading-none shrink-0 hover:text-accent transition-colors" title="Iklipse">
            {open ? (
              <span className="text-[20px] px-1 animate-fade-in">Iklipse</span>
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
          {can("pm.view") && (
            <>
              <RailLink to="/pm/boards" icon={<Kanban size={16} />} open={open}>
                Boards
              </RailLink>
              <RailLink to="/pm/my-work" icon={<ListTodo size={16} />} open={open}>
                My work
              </RailLink>
            </>
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
          <button
            onClick={toggle}
            className="h-8 w-8 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink transition-colors duration-150"
            aria-label={themeLabel}
            title={themeLabel}
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
      </aside>

      {/* Main column. Phones: bottom padding clears the fixed tab bar,
          including the iOS home-indicator inset. */}
      <div className="flex-1 min-w-0 h-full flex flex-col pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
        <header className="h-[calc(3.5rem+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)] shrink-0 border-b border-border bg-surface grid grid-cols-[auto_minmax(0,1fr)_auto] md:grid-cols-[1fr_minmax(0,720px)_1fr] items-center gap-2 sm:gap-3 px-3 sm:px-4 shadow-card">
          <div className="md:hidden display text-[18px] text-ink shrink-0">Iklipse</div>
          <div className="hidden md:block" />

          {/* Centered search + Create, Trello style. Phones search from the
              tab bar's Search tab, so the field only shows from `sm` up. */}
          <div className="flex items-center justify-end sm:justify-start gap-2 min-w-0">
            <form
              className="hidden sm:block flex-1 min-w-0"
              onSubmit={(e) => {
                e.preventDefault();
                nav(`/pm/search${searchQ ? `?q=${encodeURIComponent(searchQ)}` : ""}`);
              }}
            >
              <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 h-9 text-sm text-subtle transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-ring">
                <Search size={15} className="shrink-0" />
                {/* 16px until the desktop layout so iOS doesn't zoom on focus. */}
                <input
                  className="flex-1 min-w-0 bg-transparent outline-none placeholder:text-subtle text-ink text-lg md:text-sm"
                  placeholder="Search"
                  aria-label="Search"
                  value={searchQ}
                  onChange={(e) => setSearchQ(e.target.value)}
                />
              </div>
            </form>
            {can("pm.create_board") && (
              <button
                onClick={() => nav("/pm/boards?create=1")}
                aria-label="Create board"
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
              <button
                onClick={toggle}
                className="h-10 w-10 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink transition-colors duration-150 shrink-0"
                aria-label={themeLabel}
                title={themeLabel}
              >
                {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
              </button>
              <NotificationBell />
              {accountMenu("right", 26, "h-10 w-10 grid place-items-center")}
            </div>
          </div>
        </header>

        <main className="flex-1 min-h-0 overflow-auto">
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
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-surface border-t border-border flex items-center justify-around h-[calc(3.5rem+env(safe-area-inset-bottom))] shadow-pop safe-bottom">
        {can("pm.view") && (
          <>
            <MobileTab to="/pm/boards" icon={<Kanban size={20} />} label="Boards" />
            <MobileTab to="/pm/my-work" icon={<ListTodo size={20} />} label="My work" />
            <MobileTab to="/pm/search" icon={<Search size={20} />} label="Search" />
          </>
        )}
        {isAdmin && <MobileTab to="/users" icon={<Users size={20} />} label="Users" />}
      </nav>

      <ChangeAvatarModal
        open={pictureOpen}
        onClose={() => setPictureOpen(false)}
        current={avatarSrc}
        onChanged={setAvatarOverride}
      />
    </div>
  );
}

function RailLink({ to, icon, open, children }: { to: string; icon: React.ReactNode; open: boolean; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      title={open ? undefined : String(children)}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 h-10 rounded-md border border-transparent",
          "eyebrow font-semibold text-muted whitespace-nowrap",
          "hover:text-ink hover:bg-inset hover:border-line",
          "transition-colors duration-150",
          open ? "px-2" : "justify-center",
          isActive && "bg-accent text-white border-accent shadow-card hover:bg-accent-hover hover:text-white hover:border-accent-hover",
        )
      }
    >
      <span className="grid place-items-center w-6 h-6 rounded-md shrink-0">{icon}</span>
      {open && <span className="animate-fade-in">{children}</span>}
    </NavLink>
  );
}

function MobileTab({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "flex flex-col items-center justify-center gap-0.5 flex-1 h-full text-[10px] font-medium transition-colors",
          isActive ? "text-accent" : "text-muted hover:text-ink",
        )
      }
    >
      {icon}
      <span>{label}</span>
    </NavLink>
  );
}
