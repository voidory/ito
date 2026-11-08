import { useEffect, useState } from "react";
import { runStartupChecks } from "./startup";

type Status =
  | { kind: "booting" }
  | { kind: "ready"; detail: string }
  | { kind: "error"; detail: string };

/**
 * The App shell renders an explicit READY / ERROR state.
 *
 * Per spec section 24 this visible state is a SAFEGUARD so a human (and the
 * Playwright baseline test) can confirm the app actually started in a browser.
 * It is NOT a substitute for runtime tests of real behaviour.
 */
export function App(): JSX.Element {
  const [status, setStatus] = useState<Status>({ kind: "booting" });

  useEffect(() => {
    let cancelled = false;
    runStartupChecks()
      .then((detail) => {
        if (!cancelled) setStatus({ kind: "ready", detail });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const detail = err instanceof Error ? err.message : String(err);
          setStatus({ kind: "error", detail });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        padding: "2rem",
        maxWidth: "48rem",
        margin: "0 auto",
      }}
    >
      <h1 style={{ marginBottom: "0.25rem" }}>ito</h1>
      <p style={{ color: "#555", marginTop: 0 }}>
        Research PDF reader + source-local annotation + concept network.
      </p>

      {status.kind === "booting" && (
        <section data-testid="app-status" data-state="booting">
          <p>Starting…</p>
        </section>
      )}

      {status.kind === "ready" && (
        <section data-testid="app-status" data-state="ready">
          <h2 style={{ color: "#137333" }}>READY</h2>
          <p>{status.detail}</p>
        </section>
      )}

      {status.kind === "error" && (
        <section data-testid="app-status" data-state="error">
          <h2 style={{ color: "#c5221f" }}>ERROR</h2>
          <p>{status.detail}</p>
        </section>
      )}
    </main>
  );
}
