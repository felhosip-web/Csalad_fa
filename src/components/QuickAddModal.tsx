import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { ChevronDown, ChevronRight, Upload, X } from 'lucide-react';
import { familyApi } from '../api/client';
import type {
  Gender,
  Person,
  RelationType,
  UnionRecord,
  UnionStatus,
} from '../types/family';
import {
  GENDER_LABELS,
  RELATION_TYPE_LABELS,
  UNION_STATUS_LABELS,
} from '../types/family';
import { formatCardYears } from '../utils/hungarian';

export type QuickAddMode =
  | { type: 'root' }
  | { type: 'parent'; targetId: string; targetName: string }
  | {
      type: 'child';
      targetId: string;
      targetName: string;
      unions: Array<UnionRecord & { partnerName: string | null }>;
    }
  | { type: 'partner'; targetId: string; targetName: string };

interface QuickAddModalProps {
  mode: QuickAddMode;
  existingPersons?: Person[];
  onClose: () => void;
  onCreated: (createdPersonId: string, feedbackMessage: string) => Promise<void>;
}

export function QuickAddModal({
  mode,
  existingPersons = [],
  onClose,
  onCreated,
}: QuickAddModalProps) {
  const canLinkExisting = mode.type !== 'root' && existingPersons.length > 1;
  const [sourceTab, setSourceTab] = useState<'new' | 'existing'>('new');
  const [existingSearch, setExistingSearch] = useState('');
  const [selectedExistingId, setSelectedExistingId] = useState('');

  const [fullName, setFullName] = useState('');
  const [birthName, setBirthName] = useState('');
  const [gender, setGender] = useState<Gender>('unknown');
  const [birthDate, setBirthDate] = useState('');
  const [deathDate, setDeathDate] = useState('');
  const [isLiving, setIsLiving] = useState(true);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [showMore, setShowMore] = useState(false);

  const [relationType, setRelationType] = useState<RelationType>('biological');
  const [unionId, setUnionId] = useState<string>(
    mode.type === 'child' && mode.unions.length > 0 ? mode.unions[0].id : '',
  );
  const [linkBoth, setLinkBoth] = useState(true);
  const [unionStatus, setUnionStatus] = useState<UnionStatus>('married');
  const [startDate, setStartDate] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !submitting) {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose, submitting]);

  const title =
    mode.type === 'root'
      ? 'Új személy felvétele'
      : mode.type === 'parent'
        ? `Szülő hozzáadása (${mode.targetName})`
        : mode.type === 'child'
          ? `Gyermek hozzáadása (${mode.targetName})`
          : `Házastárs / Társ hozzáadása (${mode.targetName})`;

  const candidatePersons = useMemo(() => {
    if (mode.type === 'root') return [];
    const q = existingSearch.trim().toLowerCase();
    return existingPersons
      .filter((p) => p.id !== mode.targetId)
      .filter(
        (p) =>
          !q ||
          p.full_name.toLowerCase().includes(q) ||
          p.birth_name.toLowerCase().includes(q),
      );
  }, [existingPersons, existingSearch, mode]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      let targetFocusId = '';
      let feedbackMsg = 'A változások elmentve.';

      if (sourceTab === 'existing' && mode.type !== 'root') {
        if (!selectedExistingId) {
          setError('Válassz ki egy meglévő személyt a listából.');
          setSubmitting(false);
          return;
        }
        if (mode.type === 'parent') {
          await familyApi.upsertRelation({
            child_id: mode.targetId,
            parent_id: selectedExistingId,
            relation_type: relationType,
          });
          targetFocusId = mode.targetId;
          feedbackMsg = 'A szülői kapcsolat rögzítve.';
        } else if (mode.type === 'child') {
          await familyApi.upsertRelation({
            child_id: selectedExistingId,
            parent_id: mode.targetId,
            union_id: unionId || null,
            relation_type: relationType,
          });
          if (unionId && linkBoth) {
            const u = mode.unions.find((item) => item.id === unionId);
            const otherParent =
              u?.partner1_id === mode.targetId ? u?.partner2_id : u?.partner1_id;
            if (otherParent) {
              await familyApi.upsertRelation({
                child_id: selectedExistingId,
                parent_id: otherParent,
                union_id: unionId,
                relation_type: relationType,
              });
            }
          }
          targetFocusId = selectedExistingId;
          feedbackMsg = 'A gyermek összekapcsolva.';
        } else {
          await familyApi.createUnion({
            partner1_id: mode.targetId,
            partner2_id: selectedExistingId,
            status: unionStatus,
            start_date: startDate,
          });
          targetFocusId = mode.targetId;
          feedbackMsg = 'A párkapcsolat rögzítve.';
        }
      } else {
        if (mode.type === 'root') {
          const res = await familyApi.createPerson({
            full_name: fullName,
            birth_name: birthName,
            gender,
            birth_date: birthDate,
            death_date: isLiving ? '' : deathDate,
            is_living: isLiving,
          });
          targetFocusId = res.person.id;
          feedbackMsg = `Új személy felvéve: ${res.person.full_name}`;
        } else if (mode.type === 'parent') {
          const res = await familyApi.quickAddParent(mode.targetId, {
            full_name: fullName,
            birth_name: birthName,
            gender,
            birth_date: birthDate,
            death_date: isLiving ? '' : deathDate,
            is_living: isLiving,
            relation_type: relationType,
          });
          targetFocusId = res.person.id;
          feedbackMsg = `Szülő hozzáadva: ${res.person.full_name}`;
        } else if (mode.type === 'child') {
          const res = await familyApi.quickAddChild(mode.targetId, {
            full_name: fullName,
            birth_name: birthName,
            gender,
            birth_date: birthDate,
            death_date: isLiving ? '' : deathDate,
            is_living: isLiving,
            relation_type: relationType,
            union_id: unionId || null,
            link_both_partners: linkBoth,
          });
          targetFocusId = res.person.id;
          feedbackMsg = `Gyermek hozzáadva: ${res.person.full_name}`;
        } else {
          const res = await familyApi.quickAddPartner(mode.targetId, {
            full_name: fullName,
            birth_name: birthName,
            gender,
            birth_date: birthDate,
            death_date: isLiving ? '' : deathDate,
            is_living: isLiving,
            status: unionStatus,
            start_date: startDate,
          });
          targetFocusId = res.person.id;
          feedbackMsg = `Házastárs / társ hozzáadva: ${res.person.full_name}`;
        }

        if (avatarFile && targetFocusId) {
          await familyApi.uploadAvatar(targetFocusId, avatarFile);
        }
      }

      await onCreated(targetFocusId, feedbackMsg);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Hiba történt a mentés közben.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  function handleAvatarSelect(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setAvatarFile(file);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="quick-add-title"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 pb-3">
          <h2 id="quick-add-title" className="text-base font-semibold text-slate-900">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Ablak bezárása"
            title="Bezárás (Esc)"
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {canLinkExisting && (
          <div className="mt-4 flex rounded-lg bg-slate-100 p-1 text-xs font-medium">
            <button
              type="button"
              onClick={() => setSourceTab('new')}
              className={`flex-1 rounded-md py-1.5 transition-colors ${
                sourceTab === 'new'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Új személy felvétele
            </button>
            <button
              type="button"
              onClick={() => setSourceTab('existing')}
              className={`flex-1 rounded-md py-1.5 transition-colors ${
                sourceTab === 'existing'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Meglévő személy összekötése
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          {sourceTab === 'existing' && mode.type !== 'root' ? (
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-700" htmlFor="qa-search">
                  Személy keresése a családfában
                </label>
                <input
                  id="qa-search"
                  type="search"
                  value={existingSearch}
                  onChange={(e) => setExistingSearch(e.target.value)}
                  placeholder="Írd be a keresett nevet..."
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
                />
              </div>
              <div className="max-h-44 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
                {candidatePersons.length === 0 ? (
                  <div className="p-3 text-xs text-slate-500">Nincs megfelelő személy.</div>
                ) : (
                  candidatePersons.map((p) => (
                    <label
                      key={p.id}
                      className="flex cursor-pointer items-center justify-between px-3 py-2 text-xs hover:bg-slate-50"
                    >
                      <span className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="existing-person"
                          value={p.id}
                          checked={selectedExistingId === p.id}
                          onChange={() => setSelectedExistingId(p.id)}
                          className="text-emerald-700"
                        />
                        <span className="font-medium text-slate-900">{p.full_name}</span>
                      </span>
                      <span className="font-mono text-slate-500 tabular-nums">
                        {formatCardYears(p)}
                      </span>
                    </label>
                  ))
                )}
              </div>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-xs font-medium text-slate-700" htmlFor="qa-name">
                  Teljes név *
                </label>
                <input
                  id="qa-name"
                  type="text"
                  required
                  autoFocus
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="például: Kovács Eszter"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700" htmlFor="qa-birthname">
                  Születési név (például leánykori név)
                </label>
                <input
                  id="qa-birthname"
                  type="text"
                  value={birthName}
                  onChange={(e) => setBirthName(e.target.value)}
                  placeholder="Hagyd üresen, ha megegyezik"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-slate-700" htmlFor="qa-gender">
                    Nem
                  </label>
                  <select
                    id="qa-gender"
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

                <div>
                  <label className="block text-xs font-medium text-slate-700" htmlFor="qa-birth">
                    Születési dátum
                  </label>
                  <input
                    id="qa-birth"
                    type="text"
                    value={birthDate}
                    onChange={(e) => setBirthDate(e.target.value)}
                    placeholder="például: 1965. 05. 14."
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
                  />
                </div>
              </div>
              <p className="text-[11px] text-slate-500">
                Elég csak az évszám is: például <span className="font-mono">1965</span>,{' '}
                <span className="font-mono">1965.05</span>, <span className="font-mono">1965.05.14</span>{' '}
                vagy <span className="font-mono">kb. 1965</span>.
              </p>

              {/* Lenyitható további részletek */}
              <div className="rounded-lg border border-slate-200 bg-slate-50/50">
                <button
                  type="button"
                  onClick={() => setShowMore((v) => !v)}
                  className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-slate-700 hover:text-slate-900"
                >
                  <span>További részletek (elhalálozás, portrékép)</span>
                  {showMore ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </button>
                {showMore && (
                  <div className="space-y-3 border-t border-slate-200 p-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div>
                        <label
                          className="block text-xs font-medium text-slate-700"
                          htmlFor="qa-death"
                        >
                          Halálozás dátuma
                        </label>
                        <input
                          id="qa-death"
                          type="text"
                          value={deathDate}
                          onChange={(e) => {
                            const val = e.target.value;
                            setDeathDate(val);
                            if (val.trim()) {
                              setIsLiving(false);
                            }
                          }}
                          placeholder="például: 2018. 11."
                          className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
                        />
                      </div>
                      <div className="flex items-end pb-2">
                        <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-700">
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
                    <p className="text-[11px] text-slate-500">
                      {isLiving
                        ? 'Élőként jelölt személynél nem tartozik ide halálozási dátum; ha mégis beírsz egy dátumot, automatikusan elhunytként rögzítjük.'
                        : 'Elhunytként jelölve. Ha mégis él, pipáld vissza a „Jelenleg élő személy” mezőt.'}
                    </p>
                    <div className="flex items-center justify-between pt-1">
                      <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
                        <Upload className="h-3.5 w-3.5" />
                        {avatarFile ? avatarFile.name : 'Portrékép kiválasztása'}
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          onChange={handleAvatarSelect}
                          className="hidden"
                        />
                      </label>
                      {avatarFile && (
                        <button
                          type="button"
                          onClick={() => setAvatarFile(null)}
                          className="text-xs text-red-700 hover:underline"
                        >
                          Eltávolítás
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {(mode.type === 'parent' || mode.type === 'child') && (
            <div>
              <label className="block text-xs font-medium text-slate-700" htmlFor="qa-rel-type">
                Rokonsági kapcsolat típusa
              </label>
              <select
                id="qa-rel-type"
                value={relationType}
                onChange={(e) => setRelationType(e.target.value as RelationType)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
              >
                {(Object.keys(RELATION_TYPE_LABELS) as RelationType[]).map((rt) => (
                  <option key={rt} value={rt}>
                    {RELATION_TYPE_LABELS[rt]}
                  </option>
                ))}
              </select>
            </div>
          )}

          {mode.type === 'child' && mode.unions.length > 0 && (
            <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <label className="block text-xs font-medium text-slate-700" htmlFor="qa-union">
                Melyik házasságból vagy kapcsolatból?
              </label>
              <select
                id="qa-union"
                value={unionId}
                onChange={(e) => setUnionId(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
              >
                <option value="">Egyedülálló szülőként (csak ehhez a személyhez)</option>
                {mode.unions.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.partnerName
                      ? `${u.partnerName} (${UNION_STATUS_LABELS[u.status]})`
                      : UNION_STATUS_LABELS[u.status]}
                  </option>
                ))}
              </select>
              {unionId && (
                <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-700">
                  <input
                    type="checkbox"
                    checked={linkBoth}
                    onChange={(e) => setLinkBoth(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-emerald-700"
                  />
                  A másik szülőhöz is kösd be automatikusan
                </label>
              )}
            </div>
          )}

          {mode.type === 'partner' && (
            <div className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-slate-700" htmlFor="qa-status">
                  Kapcsolat jellege
                </label>
                <select
                  id="qa-status"
                  value={unionStatus}
                  onChange={(e) => setUnionStatus(e.target.value as UnionStatus)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
                >
                  {(Object.keys(UNION_STATUS_LABELS) as UnionStatus[]).map((s) => (
                    <option key={s} value={s}>
                      {UNION_STATUS_LABELS[s]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700" htmlFor="qa-start">
                  Kezdete (választható)
                </label>
                <input
                  id="qa-start"
                  type="text"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  placeholder="például: 2005"
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
                />
              </div>
            </div>
          )}

          {error && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
            >
              Mégse
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              {submitting ? 'Mentés...' : 'Mentés'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
