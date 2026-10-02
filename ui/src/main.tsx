import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Outlet, Route, Routes } from "react-router";
import "./index.css";
import { useWorkspace, WorkspaceProvider } from "./lib/workspace";
import { HomePage } from "./pages/HomePage";
import { ExamplePage, ResultPage } from "./pages/ResultPage";

function Layout() {
  const { info } = useWorkspace();
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b border-line bg-page/90 px-4 backdrop-blur sm:px-6">
        <Link to="/" className="flex items-center gap-2.5">
          <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
            <rect width="32" height="32" rx="7" fill="#1e1b4b" />
            <path d="M16 7v6M16 13L9 19M16 13l7 6" stroke="#a5b4fc" strokeWidth="2.4" strokeLinecap="round" fill="none" />
            <circle cx="16" cy="7" r="2.6" fill="#f97316" />
            <circle cx="9" cy="21" r="2.6" fill="#fde68a" />
            <circle cx="23" cy="21" r="2.6" fill="#e0e7ff" />
          </svg>
          <span className="font-display text-xl font-semibold tracking-tight">plano</span>
        </Link>
        <span className="hidden text-sm text-ink-3 sm:block">explorador de planos de consulta do Postgres</span>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-ink-3">
          {info?.live ? (
            <>
              <span className="size-2 rounded-full bg-good" /> ao vivo em <span className="num text-ink-2">{info.database.database}</span>
            </>
          ) : (
            <>
              <span className="size-2 rounded-full bg-ink-4" /> análise local, no navegador
            </>
          )}
        </span>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <footer className="border-t border-line py-5 text-center text-xs text-ink-3">
        Os planos colados são analisados no seu navegador e não são enviados a lugar nenhum.
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorkspaceProvider>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<HomePage />} />
            <Route path="plano" element={<ResultPage />} />
            <Route path="exemplo/:id" element={<ExamplePage />} />
            <Route path="*" element={<HomePage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </WorkspaceProvider>
  </StrictMode>,
);
