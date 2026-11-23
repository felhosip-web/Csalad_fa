import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { AlertTriangle, Download, FilePlus2, ShieldCheck, Sparkles, Upload } from 'lucide-react';
import { familyApi } from '../api/client';
import type { TreeMeta } from '../types/family';
import { formatTimestampHu } from '../utils/hungarian';
import { ConfirmDialog } from './ConfirmDialog';

interface PackagePanelProps {
  meta: TreeMeta;
  onRefresh: (selectId?: string, feedbackMessage?: string) => Promise<void>;
  onError: (
    err: unknown,
    options?: {
      title?: string;
      fallbackMessage?: string;
      onRetry?: () => void | Promise<void>;
    },
  ) => void;
}

export function PackagePanel({ meta, onRefresh, onError }: PackagePanelProps) {
  const [treeName, setTreeName] = useState(meta.tree_name);
  const [busy, setBusy] = useState(false);
  const [importWarning, setImportWarning] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<'seed' | 'new' | null>(null);

  useEffect(() => {
    setTreeName(meta.tree_name);
  }, [meta.tree_name]);

  const safeFilename =
    (meta.tree_name || 'csaladfa')
      .toLowerCase()
      .replace(/[^a-z0-9áéíóöőúüű_-]+/gi, '_')
      .replace(/^_+|_+$/g, '') || 'csaladfa';

  async function handleExport() {
    setBusy(true);
    try {
      const blob = await familyApi.exportPackageBlob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${safeFilename}.ftree`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      onError(err, {
        title: 'Mentési hiba',
        fallbackMessage: 'Nem sikerült letölteni a .ftree mentési fájlt.',
        onRetry: () => handleExport(),
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleRename(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await familyApi.renameTree(treeName);
      await onRefresh(undefined, 'A családfa neve elmentve.');
    } catch (err) {
      onError(err, {
        title: 'Átnevezési hiba',
        fallbackMessage: 'Nem sikerült módosítani a családfa nevét.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleImport(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setImportWarning(null);
    try {
      const res = await familyApi.importPackage(file);
      setTreeName(res.meta.tree_name);
      if (res.warning) {
        setImportWarning(res.warning);
      }
      await onRefresh(
        undefined,
        res.warning
          ? `Családfa betöltve (ellenőrzőösszeg nélkül): ${res.meta.tree_name}.`
          : `Családfa betöltve: ${res.meta.tree_name} (${res.meta.person_count} személy).`,
      );
    } catch (err) {
      onError(err, {
        title: 'Fájlbetöltési hiba',
        fallbackMessage: 'A kiválasztott .ftree csomag betöltése nem sikerült.',
      });
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  }

  async function runDirectReset(kind: 'seed' | 'new') {
    setBusy(true);
    setImportWarning(null);
    try {
      if (kind === 'seed') {
        const snap = await familyApi.seedSample();
        setTreeName(snap.meta.tree_name);
        setConfirmAction(null);
        await onRefresh(undefined, 'A Kovács–Nagy mintacsaládfa betöltve.');
      } else {
        const snap = await familyApi.createNewTree('Új családfa');
        setTreeName(snap.meta.tree_name);
        setConfirmAction(null);
        await onRefresh(undefined, 'Új, üres családfa létrehozva.');
      }
    } catch (err) {
      setConfirmAction(null);
      onError(err, {
        title: kind === 'seed' ? 'Mintacsaládfa betöltési hiba' : 'Új családfa létrehozási hiba',
        fallbackMessage: 'A művelet végrehajtása sikertelen.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function executeResetConfirm() {
    if (!confirmAction) return;
    await runDirectReset(confirmAction);
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">
          Családfa mentése és megnyitása
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          A teljes családfát minden fényképpel és jegyzettel együtt egyetlen hordozható{' '}
          <span className="font-mono text-xs text-slate-800">.ftree</span> fájlba mentheted, így bármikor könnyedén folytathatod a szerkesztést, vagy elküldheted a családtagoknak.
        </p>
      </div>

      {importWarning && (
        <div
          role="status"
          className="flex items-start justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
            <span>{importWarning}</span>
          </div>
          <button
            type="button"
            onClick={() => setImportWarning(null)}
            className="text-xs font-medium underline shrink-0"
          >
            Rendben
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Mentés fájlba</h2>
          <p className="text-xs leading-relaxed text-slate-600">
            Letölti a jelenlegi családfát az összes feltöltött portréképpel együtt egyetlen hordozható csomagfájlként. A mentés SHA-256 ellenőrzőösszeggel védi a fájl épségét.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleExport()}
            title="Letölti a teljes családfát és minden portréképet egyetlen hordozható .ftree fájlban"
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            Családfa mentése (.ftree)
          </button>
        </div>

        <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Korábbi fájl megnyitása</h2>
          <p className="text-xs leading-relaxed text-slate-600">
            Válassz ki egy korábban elmentett <span className="font-mono">.ftree</span> fájlt a számítógépről a családfa folytatásához.
          </p>
          <label
            title="Korábban elmentett családfa csomag (.ftree) betöltése a számítógépről"
            className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <Upload className="h-4 w-4" />
            Családfa megnyitása fájlból
            <input
              type="file"
              accept=".ftree,.zip"
              disabled={busy}
              onChange={handleImport}
              className="hidden"
            />
          </label>
        </div>
      </div>

      {/* Családfa összegzés */}
      <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">Aktív családfa adatai</h2>
          <span className="inline-flex items-center gap-1.5 text-xs text-emerald-800">
            <ShieldCheck className="h-3.5 w-3.5" />
            Helyi tárolás · SHA-256 védelem
          </span>
        </div>
        <dl className="grid grid-cols-2 gap-4 border-b border-slate-100 pb-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-slate-500">Személyek</dt>
            <dd className="mt-0.5 font-semibold text-slate-900 tabular-nums">
              {meta.person_count} fő
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Párkapcsolatok</dt>
            <dd className="mt-0.5 font-semibold text-slate-900 tabular-nums">
              {meta.union_count} db
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Szülő–gyermek ágak</dt>
            <dd className="mt-0.5 font-semibold text-slate-900 tabular-nums">
              {meta.relation_count} db
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Utolsó mentés</dt>
            <dd className="mt-0.5 text-xs font-medium text-slate-800 tabular-nums">
              {formatTimestampHu(meta.updated_at)}
            </dd>
          </div>
        </dl>

        <form onSubmit={handleRename} className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <label className="block text-xs font-medium text-slate-700" htmlFor="tree-name-input">
              Családfa megnevezése
            </label>
            <input
              id="tree-name-input"
              type="text"
              required
              title="Add meg a családfa nevét (ez jelenik meg a fejlécben és a mentett fájl nevében is)"
              value={treeName}
              onChange={(e) => setTreeName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            title="A családfa új nevének elmentése"
            disabled={busy}
            className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            Név mentése
          </button>
        </form>

        <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
          <button
            type="button"
            title="Betölti a több házasságot és féltestvéreket bemutató magyar mintacsaládfát"
            disabled={busy}
            onClick={() => {
              if (meta.person_count > 0) {
                setConfirmAction('seed');
              } else {
                void runDirectReset('seed');
              }
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Minta családfa betöltése (Kovács–Nagy)
          </button>
          <button
            type="button"
            title="Létrehoz egy teljesen üres, új családfát"
            disabled={busy}
            onClick={() => {
              if (meta.person_count > 0) {
                setConfirmAction('new');
              } else {
                void runDirectReset('new');
              }
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <FilePlus2 className="h-3.5 w-3.5" />
            Új üres családfa kezdése
          </button>
        </div>
      </div>

      {confirmAction && (
        <ConfirmDialog
          busy={busy}
          destructive={false}
          title={
            confirmAction === 'seed'
              ? 'Minta családfa betöltése'
              : 'Új üres családfa kezdése'
          }
          description="A jelenleg megnyitott családfa adatai lecserélődnek. Ha meg szeretnéd őrizni a mostani munkádat, előtte mentsd el .ftree fájlba."
          confirmLabel="Igen, folytatom"
          cancelLabel="Mégse"
          onCancel={() => setConfirmAction(null)}
          onConfirm={executeResetConfirm}
        />
      )}
    </div>
  );
}
