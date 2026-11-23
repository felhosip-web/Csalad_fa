import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Trash2,
  Upload,
  User,
  UserPlus,
} from 'lucide-react';
import { familyApi } from '../api/client';
import type { Gender, PersonBundle, UnionStatus } from '../types/family';
import {
  GENDER_LABELS,
  RELATION_TYPE_LABELS,
  UNION_STATUS_LABELS,
} from '../types/family';
import type { QuickAddMode } from './QuickAddModal';

interface PersonDetailPanelProps {
  bundle: PersonBundle;
  onSelectPerson: (id: string) => void;
  onOpenQuickAdd: (mode: QuickAddMode) => void;
  onRefresh: (selectId?: string) => Promise<void>;
}

export function PersonDetailPanel({
  bundle,
  onSelectPerson,
  onOpenQuickAdd,
  onRefresh,
}: PersonDetailPanelProps) {
  const { person, parents, unions, children, siblings } = bundle;

  const [fullName, setFullName] = useState(person.full_name);
  const [birthName, setBirthName] = useState(person.birth_name);
  const [gender, setGender] = useState<Gender>(person.gender);
  const [birthDate, setBirthDate] = useState(person.birth_date);
  const [deathDate, setDeathDate] = useState(person.death_date);
  const [isLiving, setIsLiving] = useState(person.is_living);
  const [notes, setNotes] = useState(person.notes);
  const [showDetails, setShowDetails] = useState(
    Boolean(person.birth_name || person.death_date || person.notes),
  );
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    setFullName(person.full_name);
    setBirthName(person.birth_name);
    setGender(person.gender);
    setBirthDate(person.birth_date);
    setDeathDate(person.death_date);
    setIsLiving(person.is_living);
    setNotes(person.notes);
    setFeedback(null);
  }, [person]);

  async function handleSavePerson(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      await familyApi.updatePerson(person.id, {
        full_name: fullName,
        birth_name: birthName,
        gender,
        birth_date: birthDate,
        death_date: deathDate,
        is_living: isLiving,
        notes,
      });
      await onRefresh(person.id);
      setFeedback({ type: 'ok', text: 'Személy adatai elmentve.' });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Mentési hiba.',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleDeletePerson() {
    setSaving(true);
    try {
      await familyApi.deletePerson(person.id);
      await onRefresh();
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Törlési hiba.',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleAvatarChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFeedback(null);
    try {
      await familyApi.uploadAvatar(person.id, file);
      await onRefresh(person.id);
      setFeedback({ type: 'ok', text: 'Portrékép mentve.' });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Képfeltöltési hiba.',
      });
    } finally {
      e.target.value = '';
    }
  }

  async function handleUnionStatusChange(unionId: string, status: UnionStatus) {
    try {
      await familyApi.updateUnion(unionId, { status });
      await onRefresh(person.id);
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Kapcsolat frissítési hiba.',
      });
    }
  }

  const unionChoices = unions.map((u) => ({
    ...u,
    partnerName: u.partner ? u.partner.full_name : null,
  }));

  return (
    <div className="space-y-6">
      {/* Header & Quick Add Actions */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-5">
        <div className="flex items-center gap-4">
          {person.avatar_path ? (
            <img
              src={`/${person.avatar_path}?v=${encodeURIComponent(person.updated_at)}`}
              alt={person.full_name}
              referrerPolicy="no-referrer"
              className="h-14 w-14 rounded-xl border border-slate-200 object-cover"
            />
          ) : (
            <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-slate-200 bg-slate-100 text-slate-500">
              <User className="h-6 w-6" />
            </div>
          )}
          <div>
            <h2 className="text-xl font-semibold text-slate-900">{person.full_name}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span>{GENDER_LABELS[person.gender]}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">
                {person.birth_date || 'Születés: ismeretlen'}
              </span>
              {!person.is_living && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">
                    Elhunyt{person.death_date ? `: ${person.death_date}` : ''}
                  </span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span className="font-mono text-slate-400">#{person.id.slice(0, 8)}</span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() =>
              onOpenQuickAdd({
                type: 'parent',
                targetId: person.id,
                targetName: person.full_name,
              })
            }
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Szülő hozzáadása
          </button>
          <button
            type="button"
            onClick={() =>
              onOpenQuickAdd({
                type: 'partner',
                targetId: person.id,
                targetName: person.full_name,
              })
            }
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Partner hozzáadása
          </button>
          <button
            type="button"
            onClick={() =>
              onOpenQuickAdd({
                type: 'child',
                targetId: person.id,
                targetName: person.full_name,
                unions: unionChoices,
              })
            }
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-800 whitespace-nowrap shrink-0"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Gyermek hozzáadása
          </button>
        </div>
      </div>

      {feedback && (
        <div
          className={`rounded-lg border px-4 py-2.5 text-sm ${
            feedback.type === 'ok'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-red-200 bg-red-50 text-red-700'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* Basic Fields + Collapsible Details */}
      <form onSubmit={handleSavePerson} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">Alapadatok</h3>
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
            <Upload className="h-3.5 w-3.5" />
            Portré feltöltése
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={handleAvatarChange}
              className="hidden"
            />
          </label>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <label className="block text-xs font-medium text-slate-700" htmlFor="ed-fullname">
              Teljes név
            </label>
            <input
              id="ed-fullname"
              type="text"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700" htmlFor="ed-gender">
              Nem
            </label>
            <select
              id="ed-gender"
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
            <label className="block text-xs font-medium text-slate-700" htmlFor="ed-birth">
              Születési dátum (év is elég)
            </label>
            <input
              id="ed-birth"
              type="text"
              value={birthDate}
              onChange={(e) => setBirthDate(e.target.value)}
              placeholder="pl. 1968 vagy 1968-03-05"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
            />
          </div>
        </div>

        <div className="flex items-center justify-between pt-1">
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
          >
            {showDetails ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
            Részletes adatok (születési név, elhalálozás, jegyzetek)
          </button>

          <label className="inline-flex items-center gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={isLiving}
              onChange={(e) => setIsLiving(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-emerald-700"
            />
            Jelenleg élő személy
          </label>
        </div>

        {showDetails && (
          <div className="space-y-4 border-t border-slate-100 pt-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-slate-700" htmlFor="ed-birthname">
                  Születési (leánykori) név
                </label>
                <input
                  id="ed-birthname"
                  type="text"
                  value={birthName}
                  onChange={(e) => setBirthName(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700" htmlFor="ed-death">
                  Halálozási dátum
                </label>
                <input
                  id="ed-death"
                  type="text"
                  value={deathDate}
                  onChange={(e) => setDeathDate(e.target.value)}
                  placeholder="pl. 2018-11 vagy kb. 1990"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700" htmlFor="ed-notes">
                Jegyzetek, életrajzi adatok
              </label>
              <textarea
                id="ed-notes"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
              />
            </div>

            {person.avatar_path && (
              <button
                type="button"
                onClick={async () => {
                  await familyApi.removeAvatar(person.id);
                  await onRefresh(person.id);
                }}
                className="text-xs font-medium text-red-700 hover:underline"
              >
                Portrékép eltávolítása
              </button>
            )}
          </div>
        )}

        <div className="flex items-center justify-between border-t border-slate-100 pt-3">
          <button
            type="button"
            onClick={handleDeletePerson}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-red-700 hover:bg-red-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Személy törlése
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {saving ? 'Mentés...' : 'Változtatások mentése'}
          </button>
        </div>
      </form>

      {/* Relational Network: Parents, Unions (multi-marriage), Children, Siblings (full/half) */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-slate-900">Szülők ({parents.length})</h3>
          {parents.length === 0 ? (
            <p className="mt-2 text-xs text-slate-500">Nincs rögzített szülő.</p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100">
              {parents.map((link) => (
                <li key={link.parent_id} className="flex items-center justify-between py-2">
                  <button
                    type="button"
                    onClick={() => onSelectPerson(link.parent_id)}
                    className="text-left hover:underline"
                  >
                    <div className="text-sm font-medium text-slate-900">{link.person.full_name}</div>
                    <div className="text-xs text-slate-500">
                      {RELATION_TYPE_LABELS[link.relation_type]}
                      {link.person.birth_date ? ` · ${link.person.birth_date}` : ''}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      await familyApi.deleteRelation(person.id, link.parent_id);
                      await onRefresh(person.id);
                    }}
                    aria-label="Szülő kapcsolat bontása"
                    className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-700"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-slate-900">
            Testvérek és féltestvérek ({siblings.length})
          </h3>
          {siblings.length === 0 ? (
            <p className="mt-2 text-xs text-slate-500">Nincs rögzített testvér vagy féltestvér.</p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100">
              {siblings.map((sib) => (
                <li key={sib.person.id} className="flex items-center justify-between py-2">
                  <button
                    type="button"
                    onClick={() => onSelectPerson(sib.person.id)}
                    className="text-left hover:underline"
                  >
                    <div className="text-sm font-medium text-slate-900">{sib.person.full_name}</div>
                    <div className="text-xs text-slate-500">
                      {sib.sibling_type === 'full' ? 'Teljes testvér' : 'Féltestvér'}
                      {sib.person.birth_date ? ` · ${sib.person.birth_date}` : ''}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Unions & Children */}
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h3 className="text-sm font-semibold text-slate-900">
          Házasságok, párkapcsolatok és gyermekek ({unions.length} kapcsolat · {children.length} gyermek)
        </h3>
        {unions.length === 0 && children.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500">
            Még nincs rögzített partner vagy gyermek ehhez a személyhez.
          </p>
        ) : (
          <div className="mt-3 space-y-4">
            {unions.map((u) => (
              <div key={u.id} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {u.partner ? (
                      <button
                        type="button"
                        onClick={() => onSelectPerson(u.partner!.id)}
                        className="text-sm font-semibold text-slate-900 hover:underline"
                      >
                        {u.partner.full_name}
                      </button>
                    ) : (
                      <span className="text-sm font-medium text-slate-600">Ismeretlen partner</span>
                    )}
                    <span className="text-xs text-slate-500 font-mono tabular-nums">
                      {u.start_date || '—'} – {u.end_date || 'jelenleg'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      aria-label="Kapcsolat állapota"
                      value={u.status}
                      onChange={(e) =>
                        handleUnionStatusChange(u.id, e.target.value as UnionStatus)
                      }
                      className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700"
                    >
                      {(Object.keys(UNION_STATUS_LABELS) as UnionStatus[]).map((st) => (
                        <option key={st} value={st}>
                          {UNION_STATUS_LABELS[st]}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={async () => {
                        await familyApi.deleteUnion(u.id);
                        await onRefresh(person.id);
                      }}
                      aria-label="Kapcsolat törlése"
                      className="rounded p-1 text-slate-400 hover:bg-white hover:text-red-700"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                <div className="mt-3 border-t border-slate-200 pt-2.5">
                  <div className="text-xs font-medium text-slate-600">
                    Közös gyermekek ({u.children.length})
                  </div>
                  {u.children.length === 0 ? (
                    <p className="mt-1 text-xs text-slate-500">Nincs ebből a kapcsolatból gyermek.</p>
                  ) : (
                    <ul className="mt-1.5 space-y-1">
                      {u.children.map((ch) => (
                        <li key={ch.child_id} className="flex items-center justify-between text-sm">
                          <button
                            type="button"
                            onClick={() => onSelectPerson(ch.child_id)}
                            className="font-medium text-slate-800 hover:underline"
                          >
                            {ch.person.full_name}
                          </button>
                          <span className="font-mono text-xs text-slate-500 tabular-nums">
                            {ch.person.birth_date || '—'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
