import { Navigate, Route, Routes } from "react-router-dom";
import { LoginPage } from "@/pages/LoginPage";
import { UsersPage } from "@/pages/UsersPage";
import { BoardsHomePage } from "@/pages/BoardsHomePage";
import { BoardPage } from "@/pages/BoardPage";
import { NotFoundPage } from "@/pages/NotFoundPage";
import { NotificationsPage } from "@/pages/NotificationsPage";
import { SearchPage } from "@/pages/SearchPage";
import { MyCardsPage } from "@/pages/MyCardsPage";
import { AutomationPage } from "@/pages/AutomationPage";
import { AppShell } from "@/components/AppShell";
import { ProtectedRoute, AdminOnlyRoute } from "@/components/routing";
import { SetupRequired } from "@/components/SetupRequired";
import { isSupabaseConfigured } from "@/lib/supabase";

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
        <Route index element={<Navigate to="/pm/boards" replace />} />

        <Route path="pm">
          <Route index element={<Navigate to="/pm/boards" replace />} />
          <Route path="boards" element={<BoardsHomePage />} />
          <Route path="boards/:boardId" element={<BoardPage />} />
          <Route path="boards/:boardId/cards/:cardId" element={<BoardPage />} />
          <Route path="boards/:boardId/automation" element={<AutomationPage />} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="my-cards" element={<MyCardsPage />} />
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
