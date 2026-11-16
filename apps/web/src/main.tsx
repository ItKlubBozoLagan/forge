import "./index.css";
import "katex/dist/katex.min.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, createRoutesFromElements, Route, RouterProvider } from "react-router";

import { AppShell, HomeRedirect, RequireAuth } from "./components/AppShell";
import { ApiError, onUnauthorized } from "./lib/api";
import { keys } from "./lib/queries";
import { WorkspaceProvider } from "./lib/workspace";
import { CliLoginPage } from "./pages/CliLoginPage";
import { LoginPage } from "./pages/LoginPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { AccessTab } from "./pages/problem/AccessTab";
import { BuildsTab } from "./pages/problem/BuildsTab";
import { FilesTab } from "./pages/problem/FilesTab";
import { InvocationsTab } from "./pages/problem/InvocationsTab";
import { ProblemIndex, ProblemLayout } from "./pages/problem/ProblemLayout";
import { ReviewTab } from "./pages/problem/ReviewTab";
import { CompareView } from "./pages/problem/revisions/CompareView";
import { RevisionView } from "./pages/problem/revisions/RevisionView";
import { RevisionsTab } from "./pages/problem/RevisionsTab";
import { StatementTab } from "./pages/problem/StatementTab";
import { StressTab } from "./pages/problem/StressTab";
import { StructureTab } from "./pages/problem/StructureTab";
import { ProblemsPage } from "./pages/ProblemsPage";
import { SetPage } from "./pages/SetPage";
import { SetsPage } from "./pages/SetsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TokensPage } from "./pages/TokensPage";
import { ToastProvider } from "./ui/Toast";

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            retry: (count, error) =>
                !(error instanceof ApiError && error.status >= 400 && error.status < 500) &&
                count < 2,
            refetchOnWindowFocus: false,
            staleTime: 5_000,
        },
    },
});

// a 401 anywhere means the session ended: re-check /me, which sends the user to /login
onUnauthorized(() => {
    if (queryClient.getQueryState(keys.me)?.status === "success")
        void queryClient.resetQueries({ queryKey: keys.me });
});

const router = createBrowserRouter(
    createRoutesFromElements(
        <>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<RequireAuth />}>
                <Route element={<AppShell />}>
                    <Route index element={<HomeRedirect />} />
                    <Route path="/w/:workspaceId" element={<ProblemsPage />} />
                    <Route path="/w/:workspaceId/sets" element={<SetsPage />} />
                    <Route path="/w/:workspaceId/settings" element={<SettingsPage />} />
                    <Route path="/sets/:setId" element={<SetPage />} />
                    <Route path="/tokens" element={<TokensPage />} />
                    <Route path="/cli-login" element={<CliLoginPage />} />
                    <Route path="/p/:problemId" element={<ProblemLayout />}>
                        <Route index element={<ProblemIndex />} />
                        <Route path="files" element={<FilesTab />} />
                        <Route path="structure" element={<StructureTab />} />
                        <Route path="statement" element={<StatementTab />} />
                        <Route path="builds" element={<BuildsTab />} />
                        <Route path="builds/:buildId" element={<BuildsTab />} />
                        <Route path="revisions" element={<RevisionsTab />} />
                        <Route path="revisions/compare" element={<CompareView />} />
                        <Route path="revisions/:revisionId" element={<RevisionView />} />
                        <Route path="stress" element={<StressTab />} />
                        <Route path="invocations" element={<InvocationsTab />} />
                        <Route path="review" element={<ReviewTab />} />
                        <Route path="access" element={<AccessTab />} />
                    </Route>
                    <Route path="*" element={<NotFoundPage />} />
                </Route>
            </Route>
        </>,
    ),
);

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <ToastProvider>
                <WorkspaceProvider>
                    <RouterProvider router={router} />
                </WorkspaceProvider>
            </ToastProvider>
        </QueryClientProvider>
    </StrictMode>,
);
