import { lazyPage } from "@/lib/lazyPage";
import { Suspense, useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LoginPage } from "@/pages/LoginPage";
import { UsersPage } from "@/pages/UsersPage";
import { BoardsHomePage } from "@/pages/BoardsHomePage";
import { BoardPage } from "@/pages/BoardPage";
import { NotFoundPage } from "@/pages/NotFoundPage";
import { NotificationsPage } from "@/pages/NotificationsPage";
import { SearchPage } from "@/pages/SearchPage";
import { MyWorkPage } from "@/pages/MyWorkPage";
import { AutomationPage } from "@/pages/AutomationPage";
import { WhiteboardsHomePage } from "@/pages/WhiteboardsHomePage";
import { AppShell } from "@/components/AppShell";
import { ProtectedRoute, AdminOnlyRoute, BriefRoute, DeliveryRoute, HomeRedirect, ProductRoute } from "@/components/routing";
import { BriefsPage } from "@/pages/BriefsPage";
import { BriefAnswersPage } from "@/pages/BriefAnswersPage";
import { ConnectionsPage } from "@/pages/ConnectionsPage";
import { SetupRequired } from "@/components/SetupRequired";
import { isSupabaseConfigured } from "@/lib/supabase";
import { PageSpinner } from "@/components/ui/Spinner";

// The whiteboard (canvas engine, toolbars, exporter) loads only when opened.
const WhiteboardPage = lazyPage(() => import("@/pages/WhiteboardPage").then((m) => ({ default: m.WhiteboardPage })));
const ShareViewPage = lazyPage(() => import("@/pages/ShareViewPage"));
const OAuthConsentPage = lazyPage(() => import("@/pages/OAuthConsentPage"));
const BriefFormPage = lazyPage(() => import("@/pages/BriefFormPage"));
const MailPage = lazyPage(() => import("@/pages/MailPage"));
const DrivePage = lazyPage(() => import("@/pages/DrivePage"));
const SharedPage = lazyPage(() => import("@/pages/SharedPage"));
const InvoicesPage = lazyPage(() => import("@/pages/InvoicesPage"));
const ProjectsPage = lazyPage(() => import("@/pages/ProjectsPage"));
const ProjectPage = lazyPage(() => import("@/pages/ProjectPage"));
const MeetingsPage = lazyPage(() => import("@/pages/MeetingsPage"));
const CalendlyPage = lazyPage(() => import("@/pages/CalendlyPage"));
const CalendarPage = lazyPage(() => import("@/pages/CalendarPage"));
const PublicMeetingPage = lazyPage(() => import("@/pages/PublicMeetingPage"));
const DeliveriesPage = lazyPage(() => import("@/pages/DeliveriesPage"));
const DeliveryPage = lazyPage(() => import("@/pages/DeliveryPage"));
const DeliveryViewPage = lazyPage(() => import("@/pages/DeliveryViewPage"));
const AlertsPage = lazyPage(() => import("@/pages/AlertsPage"));
const HomePage = lazyPage(() => import("@/pages/HomePage"));
const AppsPage = lazyPage(() => import("@/pages/AppsPage"));
const ActivityPage = lazyPage(() => import("@/pages/ActivityPage"));

// After the first screen is up, the other pages load quietly in the background,
// so opening one later is instant instead of waiting for its file.
const PRELOAD = [
  () => import("@/pages/HomePage"),
  () => import("@/pages/AlertsPage"),
  () => import("@/pages/ProjectsPage"),
  () => import("@/pages/ProjectPage"),
  () => import("@/pages/DeliveriesPage"),
  () => import("@/pages/DeliveryPage"),
  () => import("@/pages/MailPage"),
  () => import("@/pages/DrivePage"),
  () => import("@/pages/SharedPage"),
  () => import("@/pages/InvoicesPage"),
  () => import("@/pages/MeetingsPage"),
  () => import("@/pages/CalendlyPage"),
  () => import("@/pages/CalendarPage"),
  () => import("@/pages/ActivityPage"),
  () => import("@/pages/AppsPage"),
  () => import("@/pages/WhiteboardPage"),
];
let preloaded = false;
function preloadPages() {
  if (preloaded) return;
  preloaded = true;
  const idle = (fn: () => void) =>
    "requestIdleCallback" in window ? window.requestIdleCallback(fn, { timeout: 4000 }) : setTimeout(fn, 1500);
  // One at a time, so the page in use never waits behind them.
  const next = (i: number) => {
    if (i >= PRELOAD.length) return;
    idle(() => void PRELOAD[i]!().catch(() => undefined).finally(() => next(i + 1)));
  };
  next(0);
}

export default function App() {
  const location = useLocation();
  useEffect(() => {
    if (location.pathname !== "/login") preloadPages();
  }, [location.pathname]);
  if (!isSupabaseConfigured) return <SetupRequired />;
  return (
    <ErrorBoundary resetKey={location.pathname}>
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {/* ChatGPT / Claude asking to use the account through the MCP server. */}
      <Route
        path="/oauth/consent"
        element={
          <ProtectedRoute>
            <Suspense fallback={<PageSpinner />}>
              <OAuthConsentPage />
            </Suspense>
          </ProtectedRoute>
        }
      />
      {/* Miro boards shared with clients by link: no account needed. */}
      <Route
        path="/s/:token"
        element={
          <Suspense fallback={<PageSpinner />}>
            <ShareViewPage />
          </Suspense>
        }
      />

      {/* A Fireflies meeting shared by email: summary and transcript, no account. */}
      <Route
        path="/meeting/:token"
        element={
          <Suspense fallback={<PageSpinner />}>
            <PublicMeetingPage />
          </Suspense>
        }
      />

      {/* A delivery sent to a client by link: previews, comments, no account. */}
      <Route
        path="/d/:token"
        element={
          <Suspense fallback={<PageSpinner />}>
            <DeliveryViewPage />
          </Suspense>
        }
      />

      {/* A brief sent to a client by link: no account, one device only. */}
      <Route
        path="/b/:token"
        element={
          <Suspense fallback={<PageSpinner />}>
            <BriefFormPage />
          </Suspense>
        }
      />
      {/* The same form for the team to look at; nothing is saved. */}
      <Route
        path="/brief-preview"
        element={
          <ProtectedRoute>
            <BriefRoute>
              <Suspense fallback={<PageSpinner />}>
                <BriefFormPage preview />
              </Suspense>
            </BriefRoute>
          </ProtectedRoute>
        }
      />

      <Route
        element={
          <ProtectedRoute>
            <AppShell />
          </ProtectedRoute>
        }
      >
        <Route
          index
          element={
            <Suspense fallback={<PageSpinner />}>
              <HomePage />
            </Suspense>
          }
        />

        <Route path="pm">
          <Route index element={<HomeRedirect />} />
          <Route path="boards" element={<ProductRoute kind="kanban"><BoardsHomePage /></ProductRoute>} />
          <Route path="boards/:boardId" element={<ProductRoute kind="kanban"><BoardPage /></ProductRoute>} />
          <Route path="boards/:boardId/cards/:cardId" element={<ProductRoute kind="kanban"><BoardPage /></ProductRoute>} />
          <Route path="boards/:boardId/automation" element={<ProductRoute kind="kanban"><AutomationPage /></ProductRoute>} />
          <Route path="notifications" element={<Navigate to="/notifications" replace />} />
          <Route path="search" element={<ProductRoute kind="kanban"><SearchPage /></ProductRoute>} />
          <Route path="my-work" element={<ProductRoute kind="kanban"><MyWorkPage /></ProductRoute>} />
        </Route>

        <Route path="wb">
          <Route index element={<ProductRoute kind="whiteboard"><WhiteboardsHomePage /></ProductRoute>} />
          <Route
            path=":boardId"
            element={
              <ProductRoute kind="whiteboard">
                <Suspense fallback={<PageSpinner />}>
                  <WhiteboardPage />
                </Suspense>
              </ProductRoute>
            }
          />
        </Route>

        <Route path="connections" element={<ConnectionsPage />} />
        <Route
          path="mail"
          element={
            <Suspense fallback={<PageSpinner />}>
              <MailPage />
            </Suspense>
          }
        />
        <Route
          path="drive"
          element={
            <Suspense fallback={<PageSpinner />}>
              <DrivePage />
            </Suspense>
          }
        />
        {/* Everything shared with me, a tab per kind (mail, Drive). */}
        <Route
          path="shared"
          element={
            <Suspense fallback={<PageSpinner />}>
              <SharedPage />
            </Suspense>
          }
        />
        <Route path="notifications" element={<NotificationsPage />} />
        {/* Old address (links in earlier notifications). */}
        <Route path="shared-mail" element={<Navigate to="/shared?tab=mail" replace />} />

        <Route path="briefs" element={<BriefRoute><BriefsPage /></BriefRoute>} />
        <Route path="briefs/:id" element={<BriefRoute><BriefAnswersPage /></BriefRoute>} />

        <Route
          path="users"
          element={
            <AdminOnlyRoute>
              <UsersPage />
            </AdminOnlyRoute>
          }
        />
        <Route
          path="meetings"
          element={
            <Suspense fallback={<PageSpinner />}>
              <MeetingsPage />
            </Suspense>
          }
        />
        <Route
          path="calendly"
          element={
            <Suspense fallback={<PageSpinner />}>
              <CalendlyPage />
            </Suspense>
          }
        />
        <Route
          path="calendar"
          element={
            <Suspense fallback={<PageSpinner />}>
              <CalendarPage />
            </Suspense>
          }
        />
        <Route
          path="projects"
          element={
            <Suspense fallback={<PageSpinner />}>
              <ProjectsPage />
            </Suspense>
          }
        />
        <Route
          path="projects/:id"
          element={
            <Suspense fallback={<PageSpinner />}>
              <ProjectPage />
            </Suspense>
          }
        />
        <Route
          path="deliveries"
          element={
            <DeliveryRoute>
              <Suspense fallback={<PageSpinner />}>
                <DeliveriesPage />
              </Suspense>
            </DeliveryRoute>
          }
        />
        <Route
          path="deliveries/:id"
          element={
            <Suspense fallback={<PageSpinner />}>
              <DeliveryPage />
            </Suspense>
          }
        />
        <Route
          path="alerts"
          element={
            <Suspense fallback={<PageSpinner />}>
              <AlertsPage />
            </Suspense>
          }
        />
        <Route
          path="apps"
          element={
            <Suspense fallback={<PageSpinner />}>
              <AppsPage />
            </Suspense>
          }
        />
        <Route path="attendance" element={<Navigate to="/users?tab=attendance" replace />} />
        <Route
          path="activity"
          element={
            <AdminOnlyRoute>
              <Suspense fallback={<PageSpinner />}>
                <ActivityPage />
              </Suspense>
            </AdminOnlyRoute>
          }
        />
        <Route
          path="invoices"
          element={
            <AdminOnlyRoute>
              <Suspense fallback={<PageSpinner />}>
                <InvoicesPage />
              </Suspense>
            </AdminOnlyRoute>
          }
        />
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
    </ErrorBoundary>
  );
}
