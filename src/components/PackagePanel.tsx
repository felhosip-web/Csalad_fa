import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Download, FilePlus2, Sparkles, Upload } from 'lucide-react';
import { familyApi } from '../api/client';
import type { TreeMeta } from '../types/family';

interface PackagePanelProps {
  meta: TreeMeta;
  onRefresh: () => Promise<void>;
}

export function PackagePanel({ meta, onRefresh }: PackagePanelProps) {
  const [treeName, setTreeName] = useState(meta.tree_name);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  async function handleRename(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await familyApi.renameTree(treeName);
      await onRefresh();
      setMessage({ type: 'ok', text: 'Családfa neve frissítve.' });
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Hiba.' });
    } finally {
      setBusy(false);
    }
  }

  async function handleImport(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await familyApi.importPackage(file);
      setTreeName(res.meta.tree_name);
      await onRefresh();
      setMessage({
        type: 'ok',
        text: `Csomag betöltve: ${res.meta.tree_name} (${res.meta.person_count} személy).`,
      });
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Import hiba.' });
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  }

  async function handleSeedSample() {
    setBusy(true);
    setMessage(null);
    try {
      const snap = await familyApi.seedSample();
      setTreeName(snap.meta.tree_name);
      await onRefresh();
      setMessage({
        type: 'ok',
        text: 'Minta családfa betöltve (több házasság és féltestvér kapcsolat).',
      });
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Hiba.' });
    } finally {
      setBusy(false);
    }
  }

  async function handleNewBlank() {
    setBusy(true);
    setMessage(null);
    try {
      const snap = await familyApi.createNewTree('Új családfa');
      setTreeName(snap.meta.tree_name);
      await onRefresh();
      setMessage({ type: 'ok', text: 'Üres családfa munkaterület létrehozva.' });
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Hiba.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Hordozható .ftree csomagkezelő</h2>
        <p className="mt-1 text-sm text-slate-600">
          A teljes családfa (SQLite adatbázis, optimalizált képek és metaadatok) egyetlen hordozható{' '}
          <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">.ftree</code> ZIP archívumban tárolható.
        </p>
      </div>

      {message && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            message.type === 'ok'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-red-200 bg-red-50 text-red-700'
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-3">
          <h3 className="text-sm font-semibold text-slate-900">Mentés egyetlen fájlba</h3>
          <p className="text-xs text-slate-600">
            Biztonságos SQLite online pillanatképet készít a <code className="font-mono">family.db</code> fájlról és becsomagolja a hivatkozott portrékkal.
          </p>
          <a
            href="/api/package/export"
            download="csaladfa.ftree"
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-800"
          >
            <Download className="h-4 w-4" />
            Letöltés (.ftree)
          </a>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-3">
          <h3 className="text-sm font-semibold text-slate-900">Meglévő csomag megnyitása</h3>
          <p className="text-xs text-slate-600">
            Ellenőrzi a ZIP útvonalakat (Zip Slip védelem), lefuttatja az SQLite integritási tesztet és szükség esetén frissíti a sémát.
          </p>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50">
            <Upload className="h-4 w-4" />
            .ftree fájl betöltése
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

      <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
        <h3 className="text-sm font-semibold text-slate-900">Munkaterület beállításai és tesztadatok</h3>
        <form onSubmit={handleRename} className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[220px]">
            <label className="block text-xs font-medium text-slate-700" htmlFor="tree-name-input">
              Családfa megnevezése
            </label>
            <input
              id="tree-name-input"
              type="text"
              required
              value={treeName}
              onChange={(e) => setTreeName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            Név mentése
          </button>
        </form>

        <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
          <button
            type="button"
            disabled={busy}
            onClick={handleSeedSample}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Minta családfa betöltése (Kovács–Nagy)
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={handleNewBlank}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <FilePlus2 className="h-3.5 w-3.5" />
            Új üres családfa
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <h3 className="text-sm font-semibold text-slate-900">Aktív meta.json tartalom</h3>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-900 p-4 font-mono text-xs text-slate-100">
          {JSON.stringify(meta, null, 2)}
        </pre>
      </div>
    </div>
  );
}
