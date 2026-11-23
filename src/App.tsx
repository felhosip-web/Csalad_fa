import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, LocateFixed, Pencil, Plus, Search, Undo2 } from 'lucide-react';
import { familyApi } from './api/client';
import { ConfirmDialog } from './components/ConfirmDialog';
import { FamilyTreeCanvas } from './components/FamilyTreeCanvas';
import { PackagePanel } from './components/PackagePanel';
import { PersonEditorDrawer } from './components/PersonEditorDrawer';
import { QuickAddModal, type QuickAddMode } from './components/QuickAddModal';
import type { PersonBundle, TreeSnapshot } from './types/family';
import { GENDER_LABELS } from './types/family';
import { formatCardYears, getInitials, translateBackendError } from './utils/hungarian';

type TabView = 'tree' | 'list' | 'package';

type PendingNavigation =
  | { kind: 'tab'; tab: TabView }
  | { kind: 'select'; personId: string | null; openDrawer: boolean; focusTree: boolean };

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return Boolean(target.closest('[contenteditable="true"]'));
}

export default function App() {
  const [tab, setTab] = useState<TabView>('tree');
  const [snapshot, setSnapshot] = useState<TreeSnapshot | null>(null);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const [pendingNav, setPendingNav] = useState<PendingNavigation | null>(null);
  const [bundle, setBundle] = useState<PersonBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [undoBusy, setUndoBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [quickAdd, setQuickAdd] = useState<QuickAddMode | null>(null);
  const [focusTrigger, setFocusTrigger] = useState<{ personId: string; seq: number } | null>(null);
  const focusSeqRef = useRef(0);
  const listEditorRef = useRef<HTMLElement | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const loadSnapshot = useCallback(
    async (preferPersonId?: string, feedbackMessage?: string, query = search) => {
      try {
        setError(null);
        const snap = await familyApi.getTree(query);
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
          setEditorOpen(false);
        }

        if (feedbackMessage) {
          showToast(feedbackMessage);
        }
      } catch (err) {
        setError(translateBackendError(err));
      } finally {
        setLoading(false);
      }
    },
    [search, selectedId, showToast],
  );

  useEffect(() => {
    void loadSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const performSelectPerson = useCallback(
    async (personId: string | null, openDrawer = false, focusTree = false) => {
      setSelectedId(personId);
      if (personId === null) {
        setBundle(null);
        setEditorOpen(false);
        setEditorDirty(false);
        return;
      }
      if (openDrawer) {
        setEditorOpen(true);
      }
      if (focusTree) {
        setTab('tree');
        focusSeqRef.current += 1;
        setFocusTrigger({ personId, seq: focusSeqRef.current });
      }
      try {
        const personBundle = await familyApi.getPersonBundle(personId);
        setBundle(personBundle);
      } catch (err) {
        setError(translateBackendError(err));
      }
    },
    [],
  );

  const requestSelectPerson = useCallback(
    (personId: string | null, openDrawer = false, focusTree = false) => {
      if (personId === selectedId && !focusTree && !openDrawer) return;
      if (editorDirty && personId !== selectedId && (editorOpen || tab === 'list')) {
        setPendingNav({ kind: 'select', personId, openDrawer, focusTree });
        return;
      }
      void performSelectPerson(personId, openDrawer, focusTree);
    },
    [editorDirty, editorOpen, performSelectPerson, selectedId, tab],
  );

  const requestSwitchTab = useCallback(
    (nextTab: TabView) => {
      if (nextTab === tab) return;
      if (editorDirty && (editorOpen || tab === 'list')) {
        setPendingNav({ kind: 'tab', tab: nextTab });
        return;
      }
      setTab(nextTab);
    },
    [editorDirty, editorOpen, tab],
  );

  async function handleSearchChange(val: string) {
    setSearch(val);
    await loadSnapshot(selectedId ?? undefined, undefined, val);
  }

  const handleUndo = useCallback(async () => {
    setUndoBusy(true);
    setError(null);
    try {
      const res = await familyApi.undo();
      setEditorDirty(false);
      await loadSnapshot(selectedId ?? undefined, `Visszavonva: ${res.undone_label}`);
    } catch (err) {
      setError(translateBackendError(err));
    } finally {
      setUndoBusy(false);
    }
  }, [loadSnapshot, selectedId]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const isUndoCombo =
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === 'z';
      if (!isUndoCombo) return;
      if (quickAdd || pendingNav) return;
      if (isEditableTarget(e.target)) return;
      if (!snapshot?.undo?.can_undo || undoBusy) return;

      e.preventDefault();
      void handleUndo();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleUndo, pendingNav, quickAdd, snapshot?.undo?.can_undo, undoBusy]);

  async function handleSeedSample() {
    setError(null);
    try {
      await familyApi.seedSample();
      await loadSnapshot(undefined, 'A Kovács–Nagy mintacsaládfa betöltve.');
    } catch (err) {
      setError(translateBackendError(err));
    }
  }

  function confirmDiscardNavigation() {
    if (!pendingNav) return;
    const nav = pendingNav;
    setPendingNav(null);
    setEditorDirty(false);
    if (nav.kind === 'tab') {
      setTab(nav.tab);
    } else {
      void performSelectPerson(nav.personId, nav.openDrawer, nav.focusTree);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Háromzónás felső navigációs sáv */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-6 px-6 py-3">
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              requestSwitchTab('tree');
            }}
            className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            Családfa
          </a>

          <nav className="flex items-center gap-6 text-sm font-medium">
            <button
              type="button"
              title="Interaktív családfa-gráf megnyitása"
              onClick={() => requestSwitchTab('tree')}
              className={`whitespace-nowrap shrink-0 border-b-2 py-1 transition-colors ${
                tab === 'tree'
                  ? 'border-emerald-700 text-slate-900'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              Családfa nézet
            </button>
            <button
              type="button"
              title="Kereshető névsor és részletes adatlapok megnyitása"
              onClick={() => requestSwitchTab('list')}
              className={`whitespace-nowrap shrink-0 border-b-2 py-1 transition-colors ${
                tab === 'list'
                  ? 'border-emerald-700 text-slate-900'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              Személyek listája
            </button>
            <button
              type="button"
              title="Családfa mentése .ftree fájlba, vagy korábbi fájl betöltése"
              onClick={() => requestSwitchTab('package')}
              className={`whitespace-nowrap shrink-0 border-b-2 py-1 transition-colors ${
                tab === 'package'
                  ? 'border-emerald-700 text-slate-900'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              Mentés és megnyitás
            </button>
          </nav>

          <div className="shrink-0">
            <button
              type="button"
              title="Új személy felvétele a családfába"
              onClick={() => setQuickAdd({ type: 'root' })}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-800 whitespace-nowrap shrink-0"
            >
              <Plus className="h-3.5 w-3.5" />
              Új személy
            </button>
          </div>
        </div>
      </header>

      {/* Visszajelző sáv (összefoglaló + mentési értesítés) */}
      {snapshot && (
        <div className="border-b border-slate-200 bg-white/75">
          <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-4 px-6 py-2 text-xs text-slate-600">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-slate-900">{snapshot.meta.tree_name}</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{snapshot.meta.person_count} személy</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{snapshot.meta.union_count} kapcsolat</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{snapshot.meta.relation_count} szülő–gyermek ág</span>
            </div>

            {toast && (
              <div
                role="status"
                className="inline-flex items-center gap-1.5 font-medium text-emerald-800"
              >
                <Check className="h-3.5 w-3.5" />
                {toast}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Fő tartalom */}
      <main className="mx-auto max-w-[1600px] px-4 py-4 sm:px-6">
        {error && (
          <div className="mb-4 flex items-center justify-between gap-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="text-xs font-medium underline"
            >
              Bezárás
            </button>
          </div>
        )}

        {loading ? (
          <div className="h-[72vh] animate-pulse rounded-xl border border-slate-200 bg-white" />
        ) : tab === 'package' && snapshot ? (
          <div className="py-2">
            <PackagePanel
              meta={snapshot.meta}
              onRefresh={(id, msg) => loadSnapshot(id, msg)}
            />
          </div>
        ) : tab === 'tree' && snapshot ? (
          <div className="relative flex gap-4">
            <div className="min-w-0 flex-1">
              <FamilyTreeCanvas
                persons={snapshot.persons}
                unions={snapshot.unions}
                relations={snapshot.parent_child}
                selectedId={selectedId}
                focusTrigger={focusTrigger}
                undoState={snapshot.undo}
                undoBusy={undoBusy}
                onSelectPerson={(id) => requestSelectPerson(id, false, false)}
                onOpenEditor={(id) => requestSelectPerson(id, true, false)}
                onOpenQuickAdd={(mode) => setQuickAdd(mode)}
                onUndo={handleUndo}
                onSeedSample={handleSeedSample}
              />
            </div>

            {editorOpen && bundle && (
              <aside className="fixed inset-y-0 right-0 z-30 w-full max-w-md border-l border-slate-200 bg-white shadow-2xl lg:static lg:z-auto lg:h-[calc(100vh-124px)] lg:w-[410px] lg:shrink-0 lg:overflow-hidden lg:rounded-xl lg:border lg:shadow-sm">
                <PersonEditorDrawer
                  bundle={bundle}
                  showCloseButton
                  onClose={() => {
                    setEditorOpen(false);
                    setEditorDirty(false);
                  }}
                  onFocusOnTree={(id) => requestSelectPerson(id, false, true)}
                  onSelectPerson={(id) => void performSelectPerson(id, true, true)}
                  onOpenQuickAdd={(mode) => setQuickAdd(mode)}
                  onDirtyChange={setEditorDirty}
                  onRefresh={(id, msg) => loadSnapshot(id, msg)}
                />
              </aside>
            )}
          </div>
        ) : snapshot ? (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[360px_1fr]">
            {/* Bal oldali személylista */}
            <aside className="rounded-xl border border-slate-200 bg-white">
              <div className="flex items-center justify-between gap-2 border-b border-slate-200 p-3">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => void handleSearchChange(e.target.value)}
                    placeholder="Keresés név vagy születési név alapján..."
                    title="Szűrés név vagy születési név alapján a személyek listájában"
                    aria-label="Keresés a személyek listájában"
                    className="w-full rounded-lg border border-slate-300 py-1.5 pl-9 pr-3 text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
                  />
                </div>
                <button
                  type="button"
                  disabled={!snapshot.undo?.can_undo || undoBusy}
                  onClick={() => void handleUndo()}
                  title={
                    snapshot.undo?.can_undo
                      ? `Utolsó lépés visszavonása: ${snapshot.undo.last_label} (Ctrl+Z)`
                      : 'Jelenleg nincs visszavonható lépés'
                  }
                  className="rounded-lg border border-slate-300 p-2 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                  aria-label="Utolsó lépés visszavonása"
                >
                  <Undo2 className="h-4 w-4" />
                </button>
              </div>
              <ul className="max-h-[70vh] divide-y divide-slate-100 overflow-y-auto">
                {snapshot.persons.length === 0 ? (
                  <li className="p-5 text-center text-xs text-slate-500">
                    {search
                      ? 'Nincs a keresésnek megfelelő személy.'
                      : 'Még nincs felvett személy a családfában.'}
                  </li>
                ) : (
                  snapshot.persons.map((p) => {
                    const active = p.id === selectedId;
                    return (
                      <li
                        key={p.id}
                        className={`flex items-center justify-between gap-2 px-3.5 py-2.5 transition-colors ${
                          active ? 'bg-emerald-50/70' : 'hover:bg-slate-50'
                        }`}
                      >
                        <button
                          type="button"
                          title={`${p.full_name} adatlapjának megnyitása`}
                          onClick={() => requestSelectPerson(p.id, false, false)}
                          className="flex min-w-0 flex-1 items-center gap-3 text-left"
                        >
                          {p.avatar_path ? (
                            <img
                              src={`/${p.avatar_path}?v=${encodeURIComponent(p.updated_at)}`}
                              alt={p.full_name}
                              referrerPolicy="no-referrer"
                              className="h-9 w-9 shrink-0 rounded-full border border-slate-200 object-cover"
                            />
                          ) : (
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-700">
                              {getInitials(p.full_name)}
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-slate-900">
                              {p.full_name}
                            </div>
                            <div className="mt-0.5 truncate text-xs text-slate-500">
                              {GENDER_LABELS[p.gender]} ·{' '}
                              <span className="font-mono tabular-nums">{formatCardYears(p)}</span>
                            </div>
                          </div>
                        </button>

                        <div className="flex shrink-0 items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              requestSelectPerson(p.id, false, false);
                              setTimeout(() => {
                                listEditorRef.current?.scrollIntoView({
                                  behavior: 'smooth',
                                  block: 'nearest',
                                });
                                const nameInput = document.getElementById('ed-full-name');
                                if (nameInput instanceof HTMLInputElement) {
                                  nameInput.focus();
                                }
                              }, 60);
                            }}
                            title="Személy adatainak gyors szerkesztése"
                            aria-label={`${p.full_name} adatainak szerkesztése`}
                            className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[11px] font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50 whitespace-nowrap"
                          >
                            <span className="inline-flex items-center gap-1">
                              <Pencil className="h-3 w-3" />
                              Szerkesztés
                            </span>
                          </button>

                          <button
                            type="button"
                            onClick={() => requestSelectPerson(p.id, false, true)}
                            title="Ugrás a személyhez a családfa nézetben"
                            aria-label={`${p.full_name} megmutatása a családfán`}
                            className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[11px] font-medium text-slate-700 hover:border-emerald-700 hover:text-emerald-800 whitespace-nowrap"
                          >
                            <span className="inline-flex items-center gap-1">
                              <LocateFixed className="h-3.5 w-3.5 text-emerald-700" />
                              Fán
                            </span>
                          </button>
                        </div>
                      </li>
                    );
                  })
                )}
              </ul>
            </aside>

            {/* Jobb oldali kártyaszerkesztő */}
            <section
              ref={listEditorRef}
              className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white"
            >
              {bundle ? (
                <PersonEditorDrawer
                  bundle={bundle}
                  onFocusOnTree={(id) => requestSelectPerson(id, false, true)}
                  onSelectPerson={(id) => void performSelectPerson(id, false, false)}
                  onOpenQuickAdd={(mode) => setQuickAdd(mode)}
                  onDirtyChange={setEditorDirty}
                  onRefresh={(id, msg) => loadSnapshot(id, msg)}
                />
              ) : (
                <div className="p-10 text-center text-sm text-slate-500">
                  Válassz ki egy személyt a bal oldali listából, vagy vegyél fel egy új családtagot.
                </div>
              )}
            </section>
          </div>
        ) : null}
      </main>

      {quickAdd && (
        <QuickAddModal
          mode={quickAdd}
          existingPersons={snapshot?.persons ?? []}
          onClose={() => setQuickAdd(null)}
          onCreated={async (createdId, msg) => {
            await loadSnapshot(createdId, msg);
          }}
        />
      )}

      {pendingNav && (
        <ConfirmDialog
          destructive={false}
          title="Mentetlen módosítások"
          description="Vannak még el nem mentett változtatásaid az aktuális adatlapon. Ha továbblépsz, ezek a módosítások elvesznek."
          confirmLabel="Változások elvetése"
          cancelLabel="Maradok az adatlapon"
          onCancel={() => setPendingNav(null)}
          onConfirm={confirmDiscardNavigation}
        />
      )}
    </div>
  );
}
