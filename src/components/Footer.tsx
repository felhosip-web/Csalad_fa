import { RefreshCw } from 'lucide-react';

export type BackendVersionState =
  | { status: 'loading' }
  | { status: 'ready'; version: string; schemaVersion?: number }
  | { status: 'unavailable' };

interface FooterProps {
  frontendVersion: string;
  backendState: BackendVersionState;
  onRetryBackendVersion: () => void;
}

export function Footer({
  frontendVersion,
  backendState,
  onRetryBackendVersion,
}: FooterProps) {
  return (
    <footer className="mt-auto border-t border-slate-200 bg-white/85">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-6 py-3 text-xs text-slate-600">
        <div className="text-slate-500">
          Családfa · Helyi SQLite és <span className="font-mono">.ftree</span> tárolás
        </div>

        <div className="flex flex-wrap items-center gap-2 text-slate-600">
          <span
            title={`A böngészős felhasználói felület aktuális verziója (v${frontendVersion})`}
            className="whitespace-nowrap"
          >
            Felület:{' '}
            <span className="font-mono font-medium text-slate-800 tabular-nums">
              v{frontendVersion}
            </span>
          </span>

          <span aria-hidden="true" className="text-slate-400">
            ·
          </span>

          {backendState.status === 'loading' ? (
            <span
              title="A helyi Python háttérprogram verziójának lekérdezése folyamatban van"
              className="whitespace-nowrap text-slate-500"
            >
              Háttérprogram: lekérdezés...
            </span>
          ) : backendState.status === 'ready' ? (
            <span
              title={
                backendState.schemaVersion
                  ? `A helyi Python + SQLite háttérprogram verziója (v${backendState.version}, adatbázisséma: v${backendState.schemaVersion})`
                  : `A helyi Python + SQLite háttérprogram verziója (v${backendState.version})`
              }
              className="whitespace-nowrap"
            >
              Háttérprogram:{' '}
              <span className="font-mono font-medium text-slate-800 tabular-nums">
                v{backendState.version}
              </span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-amber-800">
              <span title="A helyi háttérprogram verziója jelenleg nem kérdezhető le. Ellenőrizd, hogy fut-e a program háttérszolgáltatása.">
                Háttérprogram: nem elérhető
              </span>
              <button
                type="button"
                onClick={onRetryBackendVersion}
                title="Háttérprogram verziójának újbóli lekérdezése"
                className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                <RefreshCw className="h-3 w-3" />
                Újra
              </button>
            </span>
          )}
        </div>
      </div>
    </footer>
  );
}
