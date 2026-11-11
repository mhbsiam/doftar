import { useEffect, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import terms from "../../TERMS.md?raw";
import icon from "../../assets/doftar-icon-fullbleed.svg";
import { useSettings } from "../stores/settings";
import { api } from "../ipc";
import { openRepo } from "../actions";

/** Bump when TERMS.md changes in substance. Everyone must agree again. */
export const TERMS_VERSION = "2026-10-27.2";

// The notices are about 700 KB, so they load in their own chunk, not in the app chunk.
const loadLicenses = () =>
  Promise.all([import("../../LICENSE?raw"), import("../../THIRD_PARTY_NOTICES.md?raw")]).then(
    ([apache, notices]) => [apache.default, notices.default] as const
  );

function TermsText() {
  return (
    <>
      {terms
        .split(/\n{2,}/)
        .map((block) => block.trim())
        .filter((block) => block && !block.startsWith("# "))
        .map((block, i) =>
          block.startsWith("## ") ? (
            <h3 key={i}>{block.slice(3)}</h3>
          ) : block.startsWith("**") ? (
            <p key={i}>
              <strong>{block.slice(2, -2)}</strong>
            </p>
          ) : (
            <p key={i}>{block}</p>
          )
        )}
    </>
  );
}

export function TermsGate({ children }: { children: ReactNode }) {
  const accepted = useSettings((s) => s.termsAccepted === TERMS_VERSION);
  const [texts, setTexts] = useState<readonly [string, string] | null>(null);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    if (accepted) return;
    const missing = "This text couldn't load. It's in Doftar's source on GitHub.";
    void loadLicenses()
      .catch(() => [missing, missing] as const)
      .then(setTexts);
    getVersion().then(setVersion, () => {});
  }, [accepted]);

  if (accepted) return children;
  return (
    <div className="overlay terms-gate" data-tauri-drag-region>
      <div
        className="dialog terms-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wf-terms-title"
      >
        <header className="terms-hero">
          <img className="terms-icon" src={icon} alt="" width={72} height={72} />
          <div>
            <h1 id="wf-terms-title">Welcome to Doftar</h1>
            <p className="terms-byline">
              {version && `Version ${version} · `}by Hasanul Banna Siam ·{" "}
              <button className="terms-link" onClick={openRepo}>
                GitHub
              </button>
            </p>
          </div>
        </header>
        <div
          className="dialog-body terms"
          tabIndex={0}
          aria-label="Terms of Use and licenses"
        >
          <div className="terms-lead">
            <strong>The short version</strong>
            <ul>
              <li>Doftar copies, moves, renames and deletes files. Some actions can't be undone.</li>
              <li>Review actions before confirming them, and keep backups. Use it at your own risk.</li>
              <li>It's free and private: no analytics, no telemetry, no network access.</li>
            </ul>
            The full Terms of Use and licenses are below.
          </div>
          <section className="terms-part">
            <h2>Part 1 · Terms of Use</h2>
            <TermsText />
          </section>
          <section className="terms-part">
            <h2>Part 2 · Apache License 2.0</h2>
            <p className="terms-part-note">Covers Doftar's own source code.</p>
            <pre>{texts ? texts[0] : "Loading…"}</pre>
          </section>
          <section className="terms-part">
            <h2>Part 3 · Third-party licenses</h2>
            <p className="terms-part-note">
              Cover the open-source components Doftar is built on, each under its own license.
            </p>
            {/* About 700 KB. Folded so that the Terms above are what the user reads. */}
            <details>
              <summary>Show the third-party licenses</summary>
              <pre>{texts ? texts[1] : "Loading…"}</pre>
            </details>
          </section>
        </div>
        <div className="dialog-actions terms-actions">
          <button className="btn subtle" onClick={() => void api.quit()}>
            Quit
          </button>
          <button
            className="btn accent"
            onClick={() => useSettings.getState().set({ termsAccepted: TERMS_VERSION })}
          >
            I Agree
          </button>
        </div>
      </div>
    </div>
  );
}
