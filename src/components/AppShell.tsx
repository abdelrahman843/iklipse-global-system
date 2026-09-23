import { useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  LogOut,
  Users,
  Kanban,
  Search,
  Inbox,
  Star,
  Sun,
  Moon,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/lib/theme";
import { Avatar } from "@/components/ui/Avatar";
import { Menu, MenuDivider, MenuItem } from "@/components/ui/Menu";
import { cn } from "@/lib/cn";
import { NotificationBell } from "@/components/pm/NotificationBell";

export function AppShell() {
  const { profile, isAdmin, signOut, can } = useAuth();
  const { theme, toggle } = useTheme();
  const nav = useNavigate();
  const location = useLocation();
  const [searchQ, setSearchQ] = useState("");

  const handleSignOut = async () => {
    await signOut();
    nav("/login", { replace: true });
  };

  return (
    <div className="min-h-full grid md:grid-cols-[232px_minmax(0,1fr)] bg-bg text-muted">
      {/* Desktop rail */}
      <aside className="hidden md:flex md:flex-col sticky top-0 self-start h-screen bg-surface border-r border-border px-4 py-6 gap-6 shadow-card">
        <Link to="/" className="display text-[20px] leading-none px-2">
          Iklipse
        </Link>

        <nav className="flex flex-col gap-1">
          {can("pm.view") && (
            <>
              <RailLink to="/pm/boards" icon={<Kanban size={14} />}>
                Boards
              </RailLink>
              <RailLink to="/pm/my-cards" icon={<Star size={14} />}>
                My cards
              </RailLink>
              <RailLink to="/pm/notifications" icon={<Inbox size={14} />}>
                Inbox
              </RailLink>
            </>
          )}
          {isAdmin && (
            <RailLink to="/users" icon={<Users size={14} />}>
              Users
            </RailLink>
          )}
        </nav>

        <div className="mt-auto flex flex-col gap-1.5 text-[10px] text-subtle uppercase tracking-[0.3px] border-t border-line pt-4">
          <span className="px-2 truncate text-muted font-medium normal-case tracking-normal text-[12px]">
            @{profile?.username ?? "…"}
          </span>
          <span className="px-2">Internal · English only</span>
        </div>
      </aside>

      {/* Main column */}
      <div className="min-w-0 flex flex-col pb-16 md:pb-0">
        <header className="h-14 border-b border-border bg-surface flex items-center gap-2 sm:gap-3 px-3 sm:px-4 shadow-card">
          <div className="md:hidden display text-[18px] text-ink shrink-0">Iklipse</div>

          <form
            className="flex-1 min-w-0 max-w-md"
            onSubmit={(e) => {
              e.preventDefault();
              nav(`/pm/search${searchQ ? `?q=${encodeURIComponent(searchQ)}` : ""}`);
            }}
          >
            <div className="flex items-center gap-2 rounded-md border border-rule bg-inset px-2.5 h-9 text-sm text-subtle transition-colors duration-150 focus-within:border-ink focus-within:bg-surface focus-within:shadow-card">
              <Search size={14} className="shrink-0" />
              <input
                className="flex-1 min-w-0 bg-transparent outline-none placeholder:text-subtle text-ink"
                placeholder="Search…"
                aria-label="Search"
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
              />
            </div>
          </form>

          <button
            onClick={toggle}
            className="rounded-md p-1.5 text-muted hover:bg-bg hover:text-ink transition-colors duration-150 shrink-0"
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Light mode" : "Dark mode"}
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>

          <NotificationBell />

          <Menu
            align="right"
            trigger={
              <button
                className="flex items-center gap-2 rounded-md p-1 hover:bg-bg transition-colors duration-150 shrink-0"
                aria-label="Account"
              >
                <Avatar name={profile?.display_name ?? "?"} src={profile?.avatar_url} size={26} />
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
        </header>

        <main className="flex-1 min-h-0 overflow-auto">
          <div key={location.pathname} className="animate-page-fade">
            <Outlet />
          </div>
        </main>
      </div>

      {/* Mobile bottom tab bar */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-surface border-t border-border flex items-center justify-around h-14 shadow-pop safe-bottom">
        {can("pm.view") && (
          <>
            <MobileTab to="/pm/boards" icon={<Kanban size={20} />} label="Boards" />
            <MobileTab to="/pm/my-cards" icon={<Star size={20} />} label="My cards" />
            <MobileTab to="/pm/search" icon={<Search size={20} />} label="Search" />
            <MobileTab to="/pm/notifications" icon={<Inbox size={20} />} label="Inbox" />
          </>
        )}
        {isAdmin && <MobileTab to="/users" icon={<Users size={20} />} label="Users" />}
      </nav>
    </div>
  );
}

function RailLink({
  to,
  icon,
  children,
}: {
  to: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 px-3 h-10 rounded-md border border-transparent",
          "eyebrow font-semibold text-muted",
          "hover:text-ink hover:bg-inset hover:border-line",
          "transition-colors duration-150",
          isActive && "bg-accent text-white border-accent shadow-card hover:bg-accent-hover hover:text-white hover:border-accent-hover",
        )
      }
    >
      <span className="grid place-items-center w-6 h-6 rounded-md">{icon}</span>
      <span>{children}</span>
    </NavLink>
  );
}

function MobileTab({
  to,
  icon,
  label,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "flex flex-col items-center justify-center gap-0.5 flex-1 h-full text-[10px] font-medium transition-colors",
          isActive ? "text-accent" : "text-muted",
        )
      }
    >
      {icon}
      <span>{label}</span>
    </NavLink>
  );
}
