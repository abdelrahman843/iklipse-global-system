import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
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
import { ProtectedRoute, AdminOnlyRoute, HomeRedirect, ProductRoute } from "@/components/routing";
import { SetupRequired } from "@/components/SetupRequired";
import { isSupabaseConfigured } from "@/lib/supabase";
import { PageSpinner } from "@/components/ui/Spinner";

// The whiteboard (canvas engine, toolbars, exporter) loads only when opened.
const WhiteboardPage = lazy(() => import("@/pages/WhiteboardPage").then((m) => ({ default: m.WhiteboardPage })));

export default function App() {
  if (!isSupabaseConfigured) return <SetupRequired />;
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        element={
          <ProtectedRoute>
            <AppShell />
          </ProtectedRoute>
        }
      >
        <Route index element={<HomeRedirect />} />

        <Route path="pm">
          <Route index element={<HomeRedirect />} />
          <Route path="boards" element={<ProductRoute kind="kanban"><BoardsHomePage /></ProductRoute>} />
          <Route path="boards/:boardId" element={<ProductRoute kind="kanban"><BoardPage /></ProductRoute>} />
          <Route path="boards/:boardId/cards/:cardId" element={<ProductRoute kind="kanban"><BoardPage /></ProductRoute>} />
          <Route path="boards/:boardId/automation" element={<ProductRoute kind="kanban"><AutomationPage /></ProductRoute>} />
          <Route path="notifications" element={<NotificationsPage />} />
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

        <Route
          path="users"
          element={
            <AdminOnlyRoute>
              <UsersPage />
            </AdminOnlyRoute>
          }
        />
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
