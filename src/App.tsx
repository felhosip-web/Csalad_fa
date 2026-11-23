import { useCallback, useEffect, useState } from 'react';
import { Plus, Search, Sparkles, UserPlus } from 'lucide-react';
import { familyApi } from './api/client';
import { ContractPanel } from './components/ContractPanel';
import { PackagePanel } from './components/PackagePanel';
import { PersonDetailPanel } from './components/PersonDetailPanel';
import { QuickAddModal, type QuickAddMode } from './components/QuickAddModal';
import type { HealthResponse, PersonBundle, TreeSnapshot } from './types/family';
import { GENDER_LABELS } from './types/family';

type TabView = 'database' | 'package' | 'contract';

export default function App() {
  const [tab, setTab] = useState<TabView>('database');
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [snapshot, setSnapshot] = useState<TreeSnapshot | null>(null);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [bundle, setBundle] = useState<PersonBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [quickAdd, setQuickAdd] = useState<QuickAddMode | null>(null);

  const loadSnapshot = useCallback(
    async (preferPersonId?: string, query = search) => {
      try {
        setError(null);
        const [h, snap] = await Promise.all([
          familyApi.health(),
          familyApi.getTree(query),
        ]);
        setHealth(h);
        setSnapshot(snap);

        const candidateId =
          preferPersonId && snap.persons.some((p) => p.id === preferPersonId)
            ? preferPersonId
            : selectedId && snap.persons.some((p) => p.id === selectedId)
              ? selectedId
              : snap.persons[0]?.id ?? null;

        setSelectedId(candidateId);
        if (candidateId) {
          const personBundle = await familyApi.getPersonBundle(candidateId);
          setBundle(personBundle);
        } else {
          setBundle(null);
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : 'Nem sikerült csatlakozni a Python backendhez.',
        );
      } finally {
        setLoading(false);
      }
    },
    [search, selectedId],
  );

  useEffect(() => {
    void loadSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSelectPerson(personId: string) {
    setSelectedId(personId);
    try {
      const personBundle = await familyApi.getPersonBundle(personId);
      setBundle(personBundle);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Hiba a személy betöltésekor.');
    }
  }

  async function handleSearchChange(val: string) {
    setSearch(val);
    await loadSnapshot(selectedId ?? undefined, val);
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Three-Zone Top Bar */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-8 px-6 py-3.5">
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              setTab('database');
            }}
            className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            Családfa
          </a>

          <nav className="flex items-center gap-6 text-sm font-medium">
            <button
              type="button"
              onClick={() => setTab('database')}
              className={`whitespace-nowrap shrink-0 border-b-2 py-1 transition-colors ${
                tab === 'database'
                  ? 'border-emerald-700 text-slate-900'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              Adatbázis
            </button>
            <button
              type="button"
              onClick={() => setTab('package')}
              className={`whitespace-nowrap shrink-0 border-b-2 py-1 transition-colors ${
                tab === 'package'
                  ? 'border-emerald-700 text-slate-900'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              Csomag (.ftree)
            </button>
            <button
              type="button"
              onClick={() => setTab('contract')}
              className={`whitespace-nowrap shrink-0 border-b-2 py-1 transition-colors ${
                tab === 'contract'
                  ? 'border-emerald-700 text-slate-900'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              API szerződés
            </button>
          </nav>

          <div className="shrink-0">
            <button
              type="button"
              onClick={() => setQuickAdd({ type: 'root' })}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-800 whitespace-nowrap shrink-0"
            >
              <Plus className="h-3.5 w-3.5" />
              Új személy
            </button>
          </div>
        </div>
      </header>

      {/* Quiet Context Bar */}
      {snapshot && (
        <div className="border-b border-slate-200 bg-white/60">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-2.5 text-xs text-slate-600">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-slate-900">{snapshot.meta.tree_name}</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{snapshot.meta.person_count} személy</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{snapshot.meta.union_count} párkapcsolat</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{snapshot.meta.relation_count} szülő-gyermek él</span>
            </div>
            <div className="font-mono text-slate-500 tabular-nums">
              Séma v{snapshot.meta.schema_version}
            </div>
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="mx-auto max-w-7xl px-6 py-6">
        {error && (
          <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[300px_1fr]">
            <div className="h-96 animate-pulse rounded-xl border border-slate-200 bg-white" />
            <div className="h-96 animate-pulse rounded-xl border border-slate-200 bg-white" />
          </div>
        ) : tab === 'package' && snapshot ? (
          <PackagePanel meta={snapshot.meta} onRefresh={() => loadSnapshot()} />
        ) : tab === 'contract' ? (
          <ContractPanel health={health} />
        ) : snapshot && snapshot.persons.length === 0 && !search ? (
          <div className="mx-auto max-w-xl rounded-xl border border-slate-200 bg-white p-8 text-center">
            <h1 className="text-lg font-semibold text-slate-900">
              A családfa adatbázisa még üres
            </h1>
            <p className="mt-2 text-sm text-slate-600">
              Kezdj egy új személy felvételével, vagy töltsd be a több házasságot és féltestvéreket bemutató Kovács–Nagy mintacsaládot.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={async () => {
                  await familyApi.seedSample();
                  await loadSnapshot();
                }}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-800 hover:bg-slate-50"
              >
                <Sparkles className="h-4 w-4" />
                Minta családfa betöltése
              </button>
              <button
                type="button"
                onClick={() => setQuickAdd({ type: 'root' })}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-800"
              >
                <UserPlus className="h-4 w-4" />
                Első személy felvétele
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[300px_1fr]">
            {/* Left Directory */}
            <aside className="rounded-xl border border-slate-200 bg-white">
              <div className="border-b border-slate-200 p-3">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => handleSearchChange(e.target.value)}
                    placeholder="Keresés név alapján..."
                    className="w-full rounded-lg border border-slate-300 py-1.5 pl-9 pr-3 text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
                  />
                </div>
              </div>
              <ul className="max-h-[70vh] divide-y divide-slate-100 overflow-y-auto">
                {snapshot?.persons.length === 0 ? (
                  <li className="p-4 text-xs text-slate-500">Nincs találat a keresésre.</li>
                ) : (
                  snapshot?.persons.map((p) => {
                    const active = p.id === selectedId;
                    return (
                      <li key={p.id}>
                        <button
                          type="button"
                          onClick={() => handleSelectPerson(p.id)}
                          className={`w-full px-4 py-3 text-left transition-colors ${
                            active ? 'bg-emerald-50/70' : 'hover:bg-slate-50'
                          }`}
                        >
                          <div className="text-sm font-medium text-slate-900 truncate">
                            {p.full_name}
                          </div>
                          <div className="mt-0.5 text-xs text-slate-500">
                            {GENDER_LABELS[p.gender]}
                            {p.birth_date ? ` · ${p.birth_date}` : ''}
                            {!p.is_living ? ' · †' : ''}
                          </div>
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
            </aside>

            {/* Right Inspector */}
            <section className="min-w-0">
              {bundle ? (
                <PersonDetailPanel
                  bundle={bundle}
                  onSelectPerson={handleSelectPerson}
                  onOpenQuickAdd={(mode) => setQuickAdd(mode)}
                  onRefresh={(id) => loadSnapshot(id)}
                />
              ) : (
                <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
                  Válassz ki egy személyt a bal oldali listából a részletek megtekintéséhez.
                </div>
              )}
            </section>
          </div>
        )}
      </main>

      {quickAdd && (
        <QuickAddModal
          mode={quickAdd}
          onClose={() => setQuickAdd(null)}
          onCreated={async (createdId) => {
            await loadSnapshot(createdId);
          }}
        />
      )}
    </div>
  );
}
