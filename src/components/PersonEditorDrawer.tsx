import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import {
  ChevronDown,
  ChevronRight,
  LocateFixed,
  Trash2,
  Upload,
  UserPlus,
  X,
} from 'lucide-react';
import { familyApi } from '../api/client';
import type {
  Gender,
  PersonBundle,
  RelationType,
  UnionStatus,
} from '../types/family';
import {
  GENDER_LABELS,
  RELATION_TYPE_LABELS,
  UNION_STATUS_LABELS,
} from '../types/family';
import { formatHungarianDate, getInitials } from '../utils/hungarian';
import { ConfirmDialog } from './ConfirmDialog';
import type { QuickAddMode } from './QuickAddModal';

interface PersonEditorDrawerProps {
  bundle: PersonBundle;
  showCloseButton?: boolean;
  onClose?: () => void;
  onFocusOnTree?: (personId: string) => void;
  onSelectPerson: (id: string) => void;
  onOpenQuickAdd: (mode: QuickAddMode) => void;
  onDirtyChange?: (dirty: boolean) => void;
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

type PendingConfirm =
  | { kind: 'delete_person' }
  | { kind: 'delete_union'; unionId: string; partnerLabel: string }
  | { kind: 'delete_parent_link'; parentId: string; parentName: string }
  | { kind: 'delete_child_link'; childId: string; childName: string }
  | { kind: 'delete_avatar' }
  | { kind: 'discard_changes'; nextAction: 'close' | { selectId: string } };

export function PersonEditorDrawer({
  bundle,
  showCloseButton = false,
  onClose,
  onFocusOnTree,
  onSelectPerson,
  onOpenQuickAdd,
  onDirtyChange,
  onRefresh,
  onError,
}: PersonEditorDrawerProps) {
  const { person, parents, unions, children, siblings } = bundle;

  const initialValues = useMemo(
    () => ({
      fullName: person.full_name,
      birthName: person.birth_name,
      gender: person.gender,
      birthDate: formatHungarianDate(person.birth_date),
      deathDate: formatHungarianDate(person.death_date),
      isLiving: person.is_living,
      notes: person.notes,
    }),
    [person],
  );

  const [fullName, setFullName] = useState(initialValues.fullName);
  const [birthName, setBirthName] = useState(initialValues.birthName);
  const [gender, setGender] = useState<Gender>(initialValues.gender);
  const [birthDate, setBirthDate] = useState(initialValues.birthDate);
  const [deathDate, setDeathDate] = useState(initialValues.deathDate);
  const [isLiving, setIsLiving] = useState(initialValues.isLiving);
  const [notes, setNotes] = useState(initialValues.notes);
  const [showAdvanced, setShowAdvanced] = useState(
    Boolean(person.notes || unions.length > 0 || parents.length > 0 || children.length > 0),
  );
  const [saving, setSaving] = useState(false);
  const [confirmState, setConfirmState] = useState<PendingConfirm | null>(null);

  useEffect(() => {
    setFullName(initialValues.fullName);
    setBirthName(initialValues.birthName);
    setGender(initialValues.gender);
    setBirthDate(initialValues.birthDate);
    setDeathDate(initialValues.deathDate);
    setIsLiving(initialValues.isLiving);
    setNotes(initialValues.notes);
  }, [initialValues]);

  const hasUnsavedChanges = useMemo(
    () =>
      fullName !== initialValues.fullName ||
      birthName !== initialValues.birthName ||
      gender !== initialValues.gender ||
      birthDate !== initialValues.birthDate ||
      deathDate !== initialValues.deathDate ||
      isLiving !== initialValues.isLiving ||
      notes !== initialValues.notes,
    [
      birthDate,
      birthName,
      deathDate,
      fullName,
      gender,
      initialValues,
      isLiving,
      notes,
    ],
  );

  useEffect(() => {
    onDirtyChange?.(hasUnsavedChanges);
  }, [hasUnsavedChanges, onDirtyChange]);

  const requestClose = useCallback(() => {
    if (!onClose) return;
    if (hasUnsavedChanges) {
      setConfirmState({ kind: 'discard_changes', nextAction: 'close' });
      return;
    }
    onClose();
  }, [hasUnsavedChanges, onClose]);

  const requestSelectPerson = useCallback(
    (targetId: string) => {
      if (targetId === person.id) return;
      if (hasUnsavedChanges) {
        setConfirmState({ kind: 'discard_changes', nextAction: { selectId: targetId } });
        return;
      }
      onSelectPerson(targetId);
    },
    [hasUnsavedChanges, onSelectPerson, person.id],
  );

  useEffect(() => {
    if (!showCloseButton || !onClose) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !confirmState && !saving) {
        e.stopPropagation();
        requestClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [confirmState, onClose, requestClose, saving, showCloseButton]);

  async function handleSavePerson(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await familyApi.updatePerson(person.id, {
        full_name: fullName,
        birth_name: birthName,
        gender,
        birth_date: birthDate,
        death_date: isLiving ? '' : deathDate,
        is_living: isLiving,
        notes,
      });
      await onRefresh(person.id, 'A változások elmentve.');
    } catch (err) {
      onError(err, {
        title: 'Mentési hiba',
        fallbackMessage: 'Nem sikerült elmenteni a személy adatait.',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleAvatarUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setSaving(true);
    try {
      await familyApi.uploadAvatar(person.id, file);
      await onRefresh(person.id, 'A portrékép frissítve.');
    } catch (err) {
      onError(err, {
        title: 'Képfeltöltési hiba',
        fallbackMessage: 'Nem sikerült feltölteni a portréképet.',
      });
    } finally {
      setSaving(false);
      e.target.value = '';
    }
  }

  async function handleUnionUpdate(
    unionId: string,
    patch: Partial<{ status: UnionStatus; start_date: string; end_date: string }>,
  ) {
    try {
      await familyApi.updateUnion(unionId, patch);
      await onRefresh(person.id, 'A kapcsolat adatai frissítve.');
    } catch (err) {
      onError(err, {
        title: 'Kapcsolat mentési hiba',
        fallbackMessage: 'Nem sikerült módosítani a párkapcsolat adatait.',
      });
    }
  }

  async function handleRelationTypeChange(
    childId: string,
    parentId: string,
    unionId: string | null,
    relationType: RelationType,
  ) {
    try {
      await familyApi.upsertRelation({
        child_id: childId,
        parent_id: parentId,
        union_id: unionId,
        relation_type: relationType,
      });
      await onRefresh(person.id, 'A rokonsági jelleg frissítve.');
    } catch (err) {
      onError(err, {
        title: 'Rokonsági kapcsolat hiba',
        fallbackMessage: 'Nem sikerült módosítani a rokonsági kapcsolatot.',
      });
    }
  }

  async function executeConfirmedAction() {
    if (!confirmState) return;
    if (confirmState.kind === 'discard_changes') {
      const action = confirmState.nextAction;
      setConfirmState(null);
      onDirtyChange?.(false);
      if (action === 'close') {
        onClose?.();
      } else {
        onSelectPerson(action.selectId);
      }
      return;
    }

    setSaving(true);
    try {
      if (confirmState.kind === 'delete_person') {
        await familyApi.deletePerson(person.id);
        setConfirmState(null);
        onDirtyChange?.(false);
        await onRefresh(undefined, `Személy törölve: ${person.full_name}`);
        onClose?.();
        return;
      }
      if (confirmState.kind === 'delete_avatar') {
        await familyApi.removeAvatar(person.id);
        setConfirmState(null);
        await onRefresh(person.id, 'A portrékép eltávolítva.');
        return;
      }
      if (confirmState.kind === 'delete_union') {
        await familyApi.deleteUnion(confirmState.unionId);
        setConfirmState(null);
        await onRefresh(person.id, 'A párkapcsolat törölve.');
        return;
      }
      if (confirmState.kind === 'delete_parent_link') {
        await familyApi.deleteRelation(person.id, confirmState.parentId);
        setConfirmState(null);
        await onRefresh(person.id, 'A szülő–gyermek kapcsolat bontva.');
        return;
      }
      if (confirmState.kind === 'delete_child_link') {
        await familyApi.deleteRelation(confirmState.childId, person.id);
        setConfirmState(null);
        await onRefresh(person.id, 'A szülő–gyermek kapcsolat bontva.');
      }
    } catch (err) {
      setConfirmState(null);
      onError(err, {
        title: 'Törlési hiba',
        fallbackMessage: 'A művelet végrehajtása sikertelen.',
      });
    } finally {
      setSaving(false);
    }
  }

  const unionChoices = unions.map((u) => ({
    ...u,
    partnerName: u.partner ? u.partner.full_name : null,
  }));

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Fejléc */}
      <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
        <div className="flex min-w-0 items-center gap-3.5">
          {person.avatar_path ? (
            <img
              src={`/${person.avatar_path}?v=${encodeURIComponent(person.updated_at)}`}
              alt={person.full_name}
              referrerPolicy="no-referrer"
              className="h-12 w-12 shrink-0 rounded-full border border-slate-200 object-cover"
            />
          ) : (
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-slate-100 text-sm font-semibold text-slate-700">
              {getInitials(person.full_name)}
            </div>
          )}
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-slate-900">
              {person.full_name}
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {GENDER_LABELS[person.gender]}
              {person.birth_date ? ` · ${formatHungarianDate(person.birth_date)}` : ''}
              {!person.is_living ? ' · Elhunyt' : ''}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {onFocusOnTree && (
            <button
              type="button"
              onClick={() => onFocusOnTree(person.id)}
              title="Személy megkeresése és középre igazítása a családfán"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
            >
              <LocateFixed className="h-3.5 w-3.5 text-emerald-700" />
              Megmutatás a fán
            </button>
          )}
          {showCloseButton && onClose && (
            <button
              type="button"
              onClick={requestClose}
              title="Szerkesztő bezárása (Esc)"
              aria-label="Szerkesztő bezárása"
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Görgethető tartalom */}
      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
        {hasUnsavedChanges && (
          <div
            role="status"
            className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2 text-xs font-medium text-amber-900"
          >
            Mentetlen módosítások vannak az adatlapon. A mentéshez kattints a „Változások mentése” gombra.
          </div>
        )}

        {/* Gyors bővítés gombok */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            title="Új vagy meglévő szülő hozzáadása ehhez a személyhez"
            onClick={() =>
              onOpenQuickAdd({
                type: 'parent',
                targetId: person.id,
                targetName: person.full_name,
              })
            }
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
          >
            <UserPlus className="h-3.5 w-3.5 text-emerald-700" />
            Szülő hozzáadása
          </button>
          <button
            type="button"
            title="Házastárs vagy élettárs hozzáadása ehhez a személyhez"
            onClick={() =>
              onOpenQuickAdd({
                type: 'partner',
                targetId: person.id,
                targetName: person.full_name,
              })
            }
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
          >
            <UserPlus className="h-3.5 w-3.5 text-emerald-700" />
            Házastárs / Társ
          </button>
          <button
            type="button"
            title="Gyermek hozzáadása ehhez a személyhez"
            onClick={() =>
              onOpenQuickAdd({
                type: 'child',
                targetId: person.id,
                targetName: person.full_name,
                unions: unionChoices,
              })
            }
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 whitespace-nowrap"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Gyermek hozzáadása
          </button>
        </div>

        {/* 1. Szekció: Alapadatok (mindig látható) */}
        <form onSubmit={handleSavePerson} className="space-y-4">
          <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50/50 p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">Alapadatok</h3>
              <div className="flex items-center gap-2">
                <label
                  title="Portrékép kiválasztása és feltöltése a számítógépről"
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  <Upload className="h-3.5 w-3.5" />
                  {person.avatar_path ? 'Kép cseréje' : 'Kép feltöltése'}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={handleAvatarUpload}
                    className="hidden"
                  />
                </label>
                {person.avatar_path && (
                  <button
                    type="button"
                    title="Feltöltött portrékép eltávolítása ennél a személynél"
                    onClick={() => setConfirmState({ kind: 'delete_avatar' })}
                    className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
                  >
                    Kép törlése
                  </button>
                )}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700" htmlFor="ed-full-name">
                Teljes név *
              </label>
              <input
                id="ed-full-name"
                type="text"
                required
                title="Add meg a személy jelenlegi vagy legismertebb teljes nevét"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700" htmlFor="ed-birth-name">
                Születési név (például leánykori név)
              </label>
              <input
                id="ed-birth-name"
                type="text"
                title="Add meg a születési vagy leánykori nevet, ha eltér a jelenlegi névtől"
                value={birthName}
                onChange={(e) => setBirthName(e.target.value)}
                placeholder="Hagyd üresen, ha nem tér el"
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-slate-700" htmlFor="ed-gender">
                  Nem
                </label>
                <select
                  id="ed-gender"
                  title="Válaszd ki a személy nemét a kártyaszínhez és a nyilvántartáshoz"
                  value={gender}
                  onChange={(e) => setGender(e.target.value as Gender)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
                >
                  {(Object.keys(GENDER_LABELS) as Gender[]).map((g) => (
                    <option key={g} value={g}>
                      {GENDER_LABELS[g]}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-end pb-2">
                <label
                  title="Ha be van jelölve, a személy élőként szerepel és nem tartozik hozzá halálozási dátum"
                  className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-700"
                >
                  <input
                    type="checkbox"
                    checked={isLiving}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setIsLiving(checked);
                      if (checked) {
                        setDeathDate('');
                      }
                    }}
                    className="h-4 w-4 rounded border-slate-300 text-emerald-700"
                  />
                  Jelenleg élő személy
                </label>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-slate-700" htmlFor="ed-birth-date">
                  Születési dátum
                </label>
                <input
                  id="ed-birth-date"
                  type="text"
                  title="Teljes vagy részleges dátum is megadható (például 1965, 1965.05 vagy kb. 1965)"
                  value={birthDate}
                  onChange={(e) => setBirthDate(e.target.value)}
                  placeholder="például: 1965. 05. 14."
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700" htmlFor="ed-death-date">
                  Halálozás dátuma
                </label>
                <input
                  id="ed-death-date"
                  type="text"
                  title="Halálozási dátum beírásakor a Jelenleg élő személy jelölés automatikusan kikapcsol"
                  value={deathDate}
                  onChange={(e) => {
                    const val = e.target.value;
                    setDeathDate(val);
                    if (val.trim()) {
                      setIsLiving(false);
                    }
                  }}
                  placeholder={isLiving ? 'Élő személynél üres' : 'például: 2018. 11.'}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
                />
              </div>
            </div>

            <div className="space-y-1 text-[11px] text-slate-500">
              <p>
                Részleges dátum is megadható: például <span className="font-mono">1965</span>,{' '}
                <span className="font-mono">1965.05</span>, <span className="font-mono">1965.05.14</span>{' '}
                vagy <span className="font-mono">kb. 1965</span>.
              </p>
              <p>
                {isLiving
                  ? 'Élőként van jelölve. Ha megadsz egy halálozási dátumot, a jelölés automatikusan kikapcsol.'
                  : 'Elhunytként van jelölve. Ha mégis él, pipáld vissza a „Jelenleg élő személy” mezőt.'}
              </p>
            </div>
          </div>

          {/* 2. Szekció: További részletek és kapcsolatok (lenyitható) */}
          <div className="rounded-xl border border-slate-200 bg-white">
            <button
              type="button"
              title={
                showAdvanced
                  ? 'További részletek és kapcsolatok elrejtése'
                  : 'Megjegyzések és kapcsolatok megjelenítése'
              }
              onClick={() => setShowAdvanced((v) => !v)}
              className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold text-slate-900 hover:bg-slate-50"
            >
              <span>További részletek és kapcsolatok</span>
              {showAdvanced ? (
                <ChevronDown className="h-4 w-4 text-slate-500" />
              ) : (
                <ChevronRight className="h-4 w-4 text-slate-500" />
              )}
            </button>

            {showAdvanced && (
              <div className="space-y-5 border-t border-slate-200 p-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700" htmlFor="ed-notes">
                    Megjegyzések, családi történetek
                  </label>
                  <textarea
                    id="ed-notes"
                    rows={3}
                    title="Ide írhatsz emlékeket, foglalkozást, lakóhelyet vagy családi történeteket"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Foglalkozás, lakhely, fontosabb életesemények..."
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
                  />
                </div>

                {/* Házasságok és párkapcsolatok */}
                <div className="space-y-2.5">
                  <h4 className="text-xs font-semibold text-slate-700">
                    Házasságok és párkapcsolatok ({unions.length})
                  </h4>
                  {unions.length === 0 ? (
                    <p className="text-xs text-slate-500">Nincs rögzített kapcsolat.</p>
                  ) : (
                    <div className="space-y-2.5">
                      {unions.map((u) => {
                        const partnerLabel = u.partner ? u.partner.full_name : 'Ismeretlen társ';
                        return (
                          <div
                            key={u.id}
                            className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3"
                          >
                            <div className="flex items-center justify-between gap-2">
                              {u.partner ? (
                                <button
                                  type="button"
                                  title={`${partnerLabel} adatlapjának megnyitása`}
                                  onClick={() => requestSelectPerson(u.partner!.id)}
                                  className="text-left text-xs font-semibold text-slate-900 hover:underline"
                                >
                                  {partnerLabel}
                                </button>
                              ) : (
                                <span className="text-xs font-medium text-slate-600">
                                  {partnerLabel}
                                </span>
                              )}
                              <button
                                type="button"
                                onClick={() =>
                                  setConfirmState({
                                    kind: 'delete_union',
                                    unionId: u.id,
                                    partnerLabel,
                                  })
                                }
                                title="Párkapcsolat törlése a fáról (a személyek megmaradnak)"
                                aria-label="Kapcsolat törlése"
                                className="rounded p-1 text-slate-400 hover:bg-white hover:text-red-700"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>

                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                              <select
                                aria-label="Kapcsolat állapota"
                                title="Kapcsolat jellege vagy jelenlegi állapota"
                                value={u.status}
                                onChange={(e) =>
                                  void handleUnionUpdate(u.id, {
                                    status: e.target.value as UnionStatus,
                                  })
                                }
                                className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-800"
                              >
                                {(Object.keys(UNION_STATUS_LABELS) as UnionStatus[]).map((st) => (
                                  <option key={st} value={st}>
                                    {UNION_STATUS_LABELS[st]}
                                  </option>
                                ))}
                              </select>
                              <input
                                key={`${u.id}-start-${u.start_date}`}
                                type="text"
                                title="Házasság vagy kapcsolat kezdete (mező elhagyásakor mentődik)"
                                defaultValue={formatHungarianDate(u.start_date)}
                                placeholder="Kezdete (például 1993)"
                                onBlur={(e) => {
                                  const next = e.target.value.trim();
                                  if (next !== formatHungarianDate(u.start_date)) {
                                    void handleUnionUpdate(u.id, { start_date: next });
                                  }
                                }}
                                className="rounded-md border border-slate-300 bg-white px-2 py-1.5 font-mono text-xs text-slate-800"
                              />
                              <input
                                key={`${u.id}-end-${u.end_date}`}
                                type="text"
                                title="Kapcsolat vége, ha véget ért (mező elhagyásakor mentődik)"
                                defaultValue={formatHungarianDate(u.end_date)}
                                placeholder="Vége (ha véget ért)"
                                onBlur={(e) => {
                                  const next = e.target.value.trim();
                                  if (next !== formatHungarianDate(u.end_date)) {
                                    void handleUnionUpdate(u.id, { end_date: next });
                                  }
                                }}
                                className="rounded-md border border-slate-300 bg-white px-2 py-1.5 font-mono text-xs text-slate-800"
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Szülők */}
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-slate-700">
                    Szülők ({parents.length})
                  </h4>
                  {parents.length === 0 ? (
                    <p className="text-xs text-slate-500">Nincs rögzített szülő.</p>
                  ) : (
                    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                      {parents.map((link) => (
                        <li
                          key={link.parent_id}
                          className="flex items-center justify-between gap-2 px-3 py-2"
                        >
                          <button
                            type="button"
                            title={`${link.person.full_name} adatlapjának megnyitása`}
                            onClick={() => requestSelectPerson(link.parent_id)}
                            className="min-w-0 flex-1 truncate text-left text-xs font-medium text-slate-900 hover:underline"
                          >
                            {link.person.full_name}
                          </button>
                          <select
                            aria-label="Szülői kapcsolat típusa"
                            title="Szülői kapcsolat típusának megváltoztatása"
                            value={link.relation_type}
                            onChange={(e) =>
                              void handleRelationTypeChange(
                                person.id,
                                link.parent_id,
                                link.union_id,
                                e.target.value as RelationType,
                              )
                            }
                            className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700"
                          >
                            {(Object.keys(RELATION_TYPE_LABELS) as RelationType[]).map((rt) => (
                              <option key={rt} value={rt}>
                                {RELATION_TYPE_LABELS[rt]}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() =>
                              setConfirmState({
                                kind: 'delete_parent_link',
                                parentId: link.parent_id,
                                parentName: link.person.full_name,
                              })
                            }
                            title="Szülő–gyermek kapcsolat bontása"
                            aria-label="Szülői kapcsolat bontása"
                            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-700"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* Gyermekek */}
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-slate-700">
                    Gyermekek ({children.length})
                  </h4>
                  {children.length === 0 ? (
                    <p className="text-xs text-slate-500">Nincs rögzített gyermek.</p>
                  ) : (
                    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                      {children.map((link) => (
                        <li
                          key={link.child_id}
                          className="flex items-center justify-between gap-2 px-3 py-2"
                        >
                          <button
                            type="button"
                            title={`${link.person.full_name} adatlapjának megnyitása`}
                            onClick={() => requestSelectPerson(link.child_id)}
                            className="min-w-0 flex-1 truncate text-left text-xs font-medium text-slate-900 hover:underline"
                          >
                            {link.person.full_name}
                          </button>
                          <select
                            aria-label="Gyermeki kapcsolat típusa"
                            title="Gyermeki kapcsolat típusának megváltoztatása"
                            value={link.relation_type}
                            onChange={(e) =>
                              void handleRelationTypeChange(
                                link.child_id,
                                person.id,
                                link.union_id,
                                e.target.value as RelationType,
                              )
                            }
                            className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700"
                          >
                            {(Object.keys(RELATION_TYPE_LABELS) as RelationType[]).map((rt) => (
                              <option key={rt} value={rt}>
                                {RELATION_TYPE_LABELS[rt]}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() =>
                              setConfirmState({
                                kind: 'delete_child_link',
                                childId: link.child_id,
                                childName: link.person.full_name,
                              })
                            }
                            title="Szülő–gyermek kapcsolat bontása"
                            aria-label="Gyermeki kapcsolat bontása"
                            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-700"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* Testvérek és féltestvérek */}
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-slate-700">
                    Testvérek és féltestvérek ({siblings.length})
                  </h4>
                  {siblings.length === 0 ? (
                    <p className="text-xs text-slate-500">Nincs rögzített testvér.</p>
                  ) : (
                    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                      {siblings.map((sib) => (
                        <li
                          key={sib.person.id}
                          className="flex items-center justify-between px-3 py-2 text-xs"
                        >
                          <button
                            type="button"
                            title={`${sib.person.full_name} adatlapjának megnyitása`}
                            onClick={() => requestSelectPerson(sib.person.id)}
                            className="font-medium text-slate-900 hover:underline"
                          >
                            {sib.person.full_name}
                          </button>
                          <span className="text-slate-500">
                            {sib.sibling_type === 'full' ? 'Édestestvér' : 'Féltestvér'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Mentés és törlés */}
          <div className="flex items-center justify-between gap-2 pt-1">
            <button
              type="button"
              title="Személy végleges eltávolítása a családfából (megerősítés után)"
              onClick={() => setConfirmState({ kind: 'delete_person' })}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-red-700 hover:bg-red-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Személy törlése
            </button>
            <button
              type="submit"
              title="A módosított adatok mentése a családfába"
              disabled={saving}
              className="rounded-lg bg-emerald-700 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              {saving ? 'Mentés...' : 'Változások mentése'}
            </button>
          </div>
        </form>
      </div>

      {/* Magyar megerősítő ablak */}
      {confirmState && (
        <ConfirmDialog
          busy={saving}
          destructive={confirmState.kind !== 'discard_changes'}
          title={
            confirmState.kind === 'discard_changes'
              ? 'Mentetlen módosítások'
              : confirmState.kind === 'delete_person'
                ? `Biztosan törlöd őt: ${person.full_name}?`
                : confirmState.kind === 'delete_avatar'
                  ? 'Portrékép eltávolítása'
                  : confirmState.kind === 'delete_union'
                    ? 'Párkapcsolat törlése'
                    : 'Szülő–gyermek kapcsolat bontása'
          }
          description={
            confirmState.kind === 'discard_changes'
              ? 'Vannak még el nem mentett változtatásaid ennél a személynél. Ha folytatod, a nem mentett módosítások elvesznek.'
              : confirmState.kind === 'delete_person'
                ? 'A személy adatai és közvetlen kapcsolati linkjei törlődnek a családfából. Ha véletlen volt, a Visszavonás gombbal visszaállíthatod.'
                : confirmState.kind === 'delete_avatar'
                  ? 'A személyhez feltöltött portrékép el lesz távolítva.'
                  : confirmState.kind === 'delete_union'
                    ? `Biztosan törlöd a következő kapcsolatot: ${confirmState.partnerLabel}? A személyek önmagukban megmaradnak a fán.`
                    : confirmState.kind === 'delete_parent_link'
                      ? `Biztosan megszünteted a szülő–gyermek kapcsolatot ${confirmState.parentName} és ${person.full_name} között?`
                      : `Biztosan megszünteted a szülő–gyermek kapcsolatot ${person.full_name} és ${confirmState.childName} között?`
          }
          confirmLabel={
            confirmState.kind === 'discard_changes'
              ? 'Változások elvetése'
              : 'Igen, törlöm'
          }
          cancelLabel={
            confirmState.kind === 'discard_changes' ? 'Maradok az adatlapon' : 'Mégse'
          }
          onCancel={() => setConfirmState(null)}
          onConfirm={executeConfirmedAction}
        />
      )}
    </div>
  );
}
