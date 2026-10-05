import { ThemeToggle } from "./components/theme-toggle";
import { SessionCard } from "./components/session-card";

/**
 * Control plane for agents: sessions, sandboxes, and approvals.
 * Review happens in GitHub — see docs/design.md D16.
 */
function App() {
  return (
    <div className="relative mx-auto flex min-h-screen max-w-6xl flex-col gap-8 p-4">
      <ThemeToggle />

      <header className="text-center">
        <h1 className="font-black text-5xl">factory</h1>
        <p className="text-muted-foreground">
          Agent sessions, sandboxes, and approvals. Review happens in GitHub.
        </p>
      </header>

      <section className="grid w-full grid-cols-1 gap-6 auto-rows-[22rem] lg:grid-cols-2">
        {/* @slot:components */}
        {/* A session, created, driven, and watched over the RPC surface (D8/D9). */}
        <SessionCard />
      </section>
    </div>
  );
}

export default App;
