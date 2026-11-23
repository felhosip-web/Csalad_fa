import { useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import type { Gender, RelationType, UnionRecord, UnionStatus } from '../types/family';
import {
  GENDER_LABELS,
  RELATION_TYPE_LABELS,
  UNION_STATUS_LABELS,
} from '../types/family';
import { familyApi } from '../api/client';

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
  onClose: () => void;
  onCreated: (createdPersonId: string) => Promise<void>;
}

export function QuickAddModal({ mode, onClose, onCreated }: QuickAddModalProps) {
  const [fullName, setFullName] = useState('');
  const [gender, setGender] = useState<Gender>('unknown');
  const [birthDate, setBirthDate] = useState('');
  const [relationType, setRelationType] = useState<RelationType>('biological');
  const [unionId, setUnionId] = useState<string>(
    mode.type === 'child' && mode.unions.length > 0 ? mode.unions[0].id : '',
  );
  const [linkBoth, setLinkBoth] = useState(true);
  const [unionStatus, setUnionStatus] = useState<UnionStatus>('married');
  const [startDate, setStartDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const title =
    mode.type === 'root'
      ? 'Új személy felvétele'
      : mode.type === 'parent'
        ? `Szülő hozzáadása (${mode.targetName})`
        : mode.type === 'child'
          ? `Gyermek hozzáadása (${mode.targetName})`
          : `Partner hozzáadása (${mode.targetName})`;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      let createdId = '';
      if (mode.type === 'root') {
        const res = await familyApi.createPerson({
          full_name: fullName,
          gender,
          birth_date: birthDate,
        });
        createdId = res.person.id;
      } else if (mode.type === 'parent') {
        const res = await familyApi.quickAddParent(mode.targetId, {
          full_name: fullName,
          gender,
          birth_date: birthDate,
          relation_type: relationType,
        });
        createdId = res.person.id;
      } else if (mode.type === 'child') {
        const res = await familyApi.quickAddChild(mode.targetId, {
          full_name: fullName,
          gender,
          birth_date: birthDate,
          relation_type: relationType,
          union_id: unionId || null,
          link_both_partners: linkBoth,
        });
        createdId = res.person.id;
      } else {
        const res = await familyApi.quickAddPartner(mode.targetId, {
          full_name: fullName,
          gender,
          birth_date: birthDate,
          status: unionStatus,
          start_date: startDate,
        });
        createdId = res.person.id;
      }
      await onCreated(createdId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Hiba történt a mentés közben.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="quick-add-title"
    >
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-lg">
        <div className="flex items-center justify-between border-b border-slate-200 pb-3">
          <h2 id="quick-add-title" className="text-base font-semibold text-slate-900">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Bezárás"
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
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
              placeholder="pl. Kovács Eszter"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
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
                placeholder="pl. 1984 vagy 1984-05-12"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
              />
            </div>
          </div>

          {(mode.type === 'parent' || mode.type === 'child') && (
            <div>
              <label className="block text-xs font-medium text-slate-700" htmlFor="qa-rel-type">
                Kapcsolat típusa
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
                Melyik kapcsolatból / házasságból?
              </label>
              <select
                id="qa-union"
                value={unionId}
                onChange={(e) => setUnionId(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
              >
                <option value="">Nincs megadott kapcsolat (csak ehhez a szülőhöz)</option>
                {mode.unions.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.partnerName ? `${u.partnerName} (${UNION_STATUS_LABELS[u.status]})` : UNION_STATUS_LABELS[u.status]}
                  </option>
                ))}
              </select>
              {unionId && (
                <label className="flex items-center gap-2 text-xs text-slate-700">
                  <input
                    type="checkbox"
                    checked={linkBoth}
                    onChange={(e) => setLinkBoth(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-emerald-700"
                  />
                  A másik szülőhöz is kösse be automatikusan
                </label>
              )}
            </div>
          )}

          {mode.type === 'partner' && (
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
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
                  Kezdete (opcionális)
                </label>
                <input
                  id="qa-start"
                  type="text"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  placeholder="pl. 2005"
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
