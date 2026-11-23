import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import {
  Maximize2,
  Minus,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Undo2,
  UserPlus,
} from 'lucide-react';
import type { ParentChild, Person, UndoState, UnionRecord } from '../types/family';
import { GENDER_LABELS } from '../types/family';
import { formatCardYears, getInitials } from '../utils/hungarian';
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  computeFamilyTreeLayout,
  getDirectFocusSet,
} from '../utils/treeLayout';
import type { QuickAddMode } from './QuickAddModal';

interface FamilyTreeCanvasProps {
  persons: Person[];
  unions: UnionRecord[];
  relations: ParentChild[];
  selectedId: string | null;
  focusTrigger?: { personId: string; seq: number } | null;
  undoState?: UndoState;
  undoBusy?: boolean;
  onSelectPerson: (personId: string | null) => void;
  onOpenEditor: (personId: string) => void;
  onOpenQuickAdd: (mode: QuickAddMode) => void;
  onUndo: () => Promise<void>;
  onSeedSample: () => Promise<void>;
}

const MIN_SCALE = 0.35;
const MAX_SCALE = 1.75;

function genderAvatarClasses(gender: Person['gender']): string {
  if (gender === 'female') {
    return 'bg-rose-50 text-rose-800 ring-1 ring-rose-200';
  }
  if (gender === 'male') {
    return 'bg-sky-50 text-sky-800 ring-1 ring-sky-200';
  }
  return 'bg-slate-100 text-slate-700 ring-1 ring-slate-200';
}

function genderCardAccent(
  gender: Person['gender'],
  selected: boolean,
  isDirectNeighbor: boolean,
): string {
  if (selected) {
    return 'border-emerald-700 ring-2 ring-emerald-700/25 shadow-md';
  }
  if (isDirectNeighbor) {
    return 'border-emerald-600/50 ring-1 ring-emerald-600/15 shadow-sm';
  }
  if (gender === 'female') {
    return 'border-rose-200/90 hover:border-rose-300 shadow-xs';
  }
  if (gender === 'male') {
    return 'border-sky-200/90 hover:border-sky-300 shadow-xs';
  }
  return 'border-slate-200 hover:border-slate-300 shadow-xs';
}

export function FamilyTreeCanvas({
  persons,
  unions,
  relations,
  selectedId,
  focusTrigger,
  undoState,
  undoBusy = false,
  onSelectPerson,
  onOpenEditor,
  onOpenQuickAdd,
  onUndo,
  onSeedSample,
}: FamilyTreeCanvasProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [transform, setTransform] = useState({ x: 40, y: 40, scale: 1 });
  const [isDragging, setIsDragging] = useState(false);
  const dragOriginRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
  } | null>(null);
  const didFitInitialRef = useRef(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);

  const layout = useMemo(
    () => computeFamilyTreeLayout(persons, unions, relations),
    [persons, unions, relations],
  );

  const focusSet = useMemo(
    () => getDirectFocusSet(selectedId, layout),
    [selectedId, layout],
  );

  const fitToView = useCallback(() => {
    const el = viewportRef.current;
    if (!el || layout.nodes.length === 0) return;

    const rect = el.getBoundingClientRect();
    const minX = Math.min(...layout.nodes.map((n) => n.x));
    const maxX = Math.max(...layout.nodes.map((n) => n.x + CARD_WIDTH));
    const minY = Math.min(...layout.nodes.map((n) => n.y));
    const maxY = Math.max(...layout.nodes.map((n) => n.y + CARD_HEIGHT + 52));

    const contentW = Math.max(260, maxX - minX);
    const contentH = Math.max(180, maxY - minY);
    const pad = 64;

    const scaleX = (rect.width - pad * 2) / contentW;
    const scaleY = (rect.height - pad * 2) / contentH;
    const nextScale = Math.max(MIN_SCALE, Math.min(1.05, Math.min(scaleX, scaleY)));

    const centerX = minX + contentW / 2;
    const centerY = minY + contentH / 2;

    setTransform({
      scale: nextScale,
      x: rect.width / 2 - centerX * nextScale,
      y: rect.height / 2 - centerY * nextScale,
    });
  }, [layout.nodes]);

  const focusPersonOnCanvas = useCallback(
    (personId: string) => {
      const node = layout.nodeById.get(personId);
      const el = viewportRef.current;
      if (!node || !el) return;
      const rect = el.getBoundingClientRect();
      setTransform((prev) => {
        const targetScale = Math.max(prev.scale, 0.95);
        const cx = node.x + CARD_WIDTH / 2;
        const cy = node.y + CARD_HEIGHT / 2;
        return {
          scale: targetScale,
          x: rect.width / 2 - cx * targetScale,
          y: rect.height / 2 - cy * targetScale,
        };
      });
    },
    [layout.nodeById],
  );

  useEffect(() => {
    if (layout.nodes.length > 0 && !didFitInitialRef.current) {
      didFitInitialRef.current = true;
      fitToView();
    }
    if (layout.nodes.length === 0) {
      didFitInitialRef.current = false;
    }
  }, [layout.nodes.length, fitToView]);

  useEffect(() => {
    if (!focusTrigger) return;
    didFitInitialRef.current = true;
    focusPersonOnCanvas(focusTrigger.personId);
  }, [focusTrigger, focusPersonOnCanvas]);

  const zoomAtCenter = (factor: number) => {
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    setTransform((prev) => {
      const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev.scale * factor));
      const ratio = nextScale / prev.scale;
      return {
        scale: nextScale,
        x: cx - (cx - prev.x) * ratio,
        y: cy - (cy - prev.y) * ratio,
      };
    });
  };

  const handleWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;

    setTransform((prev) => {
      const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev.scale * factor));
      const ratio = nextScale / prev.scale;
      return {
        scale: nextScale,
        x: mx - (mx - prev.x) * ratio,
        y: my - (my - prev.y) * ratio,
      };
    });
  };

  const handleMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-person-card="true"]') || target.closest('[data-canvas-ui="true"]')) {
      return;
    }
    setIsDragging(true);
    dragOriginRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: transform.x,
      origY: transform.y,
      moved: false,
    };
  };

  const handleMouseMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!isDragging || !dragOriginRef.current) return;
    const dx = e.clientX - dragOriginRef.current.startX;
    const dy = e.clientY - dragOriginRef.current.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
      dragOriginRef.current.moved = true;
    }
    setTransform((prev) => ({
      ...prev,
      x: dragOriginRef.current!.origX + dx,
      y: dragOriginRef.current!.origY + dy,
    }));
  };

  const handleMouseUp = () => {
    if (isDragging && dragOriginRef.current && !dragOriginRef.current.moved) {
      onSelectPerson(null);
    }
    setIsDragging(false);
    dragOriginRef.current = null;
  };

  const handleMouseLeave = () => {
    setIsDragging(false);
    dragOriginRef.current = null;
  };

  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return persons
      .filter(
        (p) =>
          p.full_name.toLowerCase().includes(q) ||
          p.birth_name.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [persons, searchQuery]);

  const personById = useMemo(() => new Map(persons.map((p) => [p.id, p])), [persons]);

  if (persons.length === 0) {
    return (
      <div className="flex h-[calc(100vh-124px)] min-h-[460px] items-center justify-center rounded-xl border border-slate-200 bg-white p-8">
        <div className="max-w-lg text-center">
          <h1 className="text-xl font-semibold text-slate-900">
            Még üres ez a családfa
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">
            Kezdd el az építést az első családtag felvételével, vagy töltsd be a több házasságot és féltestvéreket bemutató Kovács–Nagy mintacsaládot.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => void onSeedSample()}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-800 hover:bg-slate-50"
            >
              <Sparkles className="h-4 w-4" />
              Minta családfa betöltése
            </button>
            <button
              type="button"
              onClick={() => onOpenQuickAdd({ type: 'root' })}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-800"
            >
              <UserPlus className="h-4 w-4" />
              Első személy felvétele
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={viewportRef}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
      className={`relative h-[calc(100vh-124px)] min-h-[520px] w-full overflow-hidden rounded-xl border border-slate-200 bg-slate-50 select-none ${
        isDragging ? 'cursor-grabbing' : 'cursor-grab'
      }`}
      style={{
        backgroundImage:
          'radial-gradient(circle, rgba(148, 163, 184, 0.28) 1px, transparent 1px)',
        backgroundSize: '24px 24px',
      }}
    >
      {/* Bal felső vezérlősáv: Keresés és ugrás */}
      <div
        data-canvas-ui="true"
        className="absolute left-4 top-4 z-20 flex flex-wrap items-center gap-2"
      >
        <div className="relative">
          <div className="flex items-center rounded-lg border border-slate-200 bg-white shadow-sm">
            <Search className="ml-3 h-4 w-4 shrink-0 text-slate-400" />
            <input
              type="search"
              value={searchQuery}
              onFocus={() => setSearchOpen(true)}
              onBlur={() => {
                setTimeout(() => setSearchOpen(false), 160);
              }}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setSearchOpen(true);
              }}
              placeholder="Keresés név alapján a fán..."
              aria-label="Keresés név alapján a családfán"
              className="w-56 rounded-lg bg-transparent py-2 pl-2.5 pr-3 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none sm:w-64"
            />
          </div>

          {searchOpen && searchQuery.trim() !== '' && (
            <div className="absolute left-0 right-0 top-full mt-1.5 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
              {searchResults.length === 0 ? (
                <div className="px-3.5 py-2.5 text-xs text-slate-500">
                  Nincs ilyen nevű személy a családfában.
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {searchResults.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          onSelectPerson(p.id);
                          focusPersonOnCanvas(p.id);
                          setSearchQuery('');
                          setSearchOpen(false);
                        }}
                        className="flex w-full items-center justify-between px-3.5 py-2 text-left text-xs hover:bg-emerald-50"
                      >
                        <span className="font-medium text-slate-900">{p.full_name}</span>
                        <span className="font-mono text-slate-500 tabular-nums">
                          {formatCardYears(p)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Jobb felső vezérlősáv: Visszavonás + Nagyítás + Teljes fa nézet */}
      <div
        data-canvas-ui="true"
        className="absolute right-4 top-4 z-20 flex flex-wrap items-center gap-2"
      >
        <button
          type="button"
          disabled={!undoState?.can_undo || undoBusy}
          onClick={() => void onUndo()}
          title={
            undoState?.can_undo && undoState.last_label
              ? `Visszavonás: ${undoState.last_label} (Ctrl+Z)`
              : 'Nincs visszavonható művelet'
          }
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45 whitespace-nowrap shrink-0"
        >
          <Undo2 className="h-3.5 w-3.5" />
          Visszavonás
        </button>

        <div className="flex items-center overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <button
            type="button"
            onClick={() => zoomAtCenter(0.85)}
            title="Kicsinyítés"
            aria-label="Kicsinyítés"
            className="px-2.5 py-2 text-slate-700 hover:bg-slate-50"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <span className="border-x border-slate-200 px-2.5 py-2 font-mono text-xs text-slate-600 tabular-nums">
            {Math.round(transform.scale * 100)}%
          </span>
          <button
            type="button"
            onClick={() => zoomAtCenter(1.18)}
            title="Nagyítás"
            aria-label="Nagyítás"
            className="px-2.5 py-2 text-slate-700 hover:bg-slate-50"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>

        <button
          type="button"
          onClick={fitToView}
          title="Teljes családfa megjelenítése középen"
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50 whitespace-nowrap shrink-0"
        >
          <Maximize2 className="h-3.5 w-3.5" />
          Teljes fa nézet
        </button>
      </div>

      {/* Transzformált vászonréteg */}
      <div
        className="origin-top-left will-change-transform"
        style={{
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          width: layout.width,
          height: layout.height,
        }}
      >
        {/* Kapcsolati SVG réteg */}
        <svg
          width={layout.width}
          height={layout.height}
          className="pointer-events-none absolute inset-0 overflow-visible"
        >
          {/* Szülő-gyermek ágak */}
          {layout.childEdges.map((edge) => {
            const isHighlighted = !focusSet || focusSet.edgeIds.has(edge.id);
            return (
              <path
                key={edge.id}
                d={edge.svgPath}
                fill="none"
                stroke={
                  focusSet && isHighlighted
                    ? '#047857'
                    : edge.isBiological
                      ? '#64748b'
                      : '#94a3b8'
                }
                strokeWidth={focusSet && isHighlighted ? 2.4 : 1.75}
                strokeOpacity={isHighlighted ? 1 : 0.22}
                strokeDasharray={edge.isBiological ? undefined : '6 4'}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="transition-opacity duration-150"
              />
            );
          })}

          {/* Házastársi / élettársi kapcsolatok */}
          {layout.unions.map((lu) => {
            if (!lu.svgPath) return null;
            const isHighlighted = !focusSet || focusSet.unionIds.has(lu.union.id);
            const isBroken = lu.status === 'divorced' || lu.status === 'separated';
            const isPartner = lu.status === 'partner';
            return (
              <g
                key={lu.union.id}
                opacity={isHighlighted ? 1 : 0.25}
                className="transition-opacity duration-150"
              >
                <path
                  d={lu.svgPath}
                  fill="none"
                  stroke={isBroken ? '#b45309' : '#0f766e'}
                  strokeWidth={focusSet && isHighlighted ? 2.5 : 2}
                  strokeDasharray={isBroken ? '5 4' : isPartner ? '2 4' : undefined}
                />
                <circle
                  cx={lu.anchorX}
                  cy={lu.anchorY}
                  r={4}
                  fill={isBroken ? '#fffbeb' : '#0f766e'}
                  stroke={isBroken ? '#b45309' : '#ffffff'}
                  strokeWidth={1.5}
                />
              </g>
            );
          })}
        </svg>

        {/* Kapcsolati állapotfeliratok (pl. Elváltak) */}
        {layout.unions.map((lu) => {
          if (!lu.p2 || !lu.label) return null;
          const isHighlighted = !focusSet || focusSet.unionIds.has(lu.union.id);
          const isBroken = lu.status === 'divorced' || lu.status === 'separated';
          return (
            <div
              key={`lbl-${lu.union.id}`}
              style={{
                left: lu.labelX,
                top: lu.labelY - 22,
                transform: 'translateX(-50%)',
              }}
              className={`pointer-events-none absolute whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium transition-opacity duration-150 ${
                isHighlighted ? 'opacity-100' : 'opacity-25'
              } ${
                isBroken
                  ? 'border border-amber-200/80 bg-amber-50/95 text-amber-800'
                  : 'bg-white/90 text-slate-600'
              }`}
            >
              {lu.label}
            </div>
          );
        })}

        {/* Személykártyák */}
        {layout.nodes.map((node) => {
          const { person } = node;
          const isSelected = person.id === selectedId;
          const isInFocus = !focusSet || focusSet.personIds.has(person.id);
          const isDirectNeighbor = Boolean(focusSet && isInFocus && !isSelected);
          const years = formatCardYears(person);
          const personUnions = unions
            .filter((u) => u.partner1_id === person.id || u.partner2_id === person.id)
            .map((u) => {
              const partnerId =
                u.partner1_id === person.id ? u.partner2_id : u.partner1_id;
              const partner = partnerId ? personById.get(partnerId) : undefined;
              return {
                ...u,
                partnerName: partner ? partner.full_name : null,
              };
            });

          return (
            <div
              key={person.id}
              data-person-card="true"
              style={{
                left: node.x,
                top: node.y,
                width: CARD_WIDTH,
              }}
              className={`absolute transition-opacity duration-150 ${
                isInFocus ? 'opacity-100' : 'opacity-40 hover:opacity-85'
              }`}
            >
              <div
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectPerson(person.id);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  onSelectPerson(person.id);
                  onOpenEditor(person.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectPerson(person.id);
                  }
                }}
                className={`group flex h-[96px] w-full cursor-pointer items-center gap-3 rounded-xl border bg-white px-3.5 py-2.5 text-left transition-all ${genderCardAccent(
                  person.gender,
                  isSelected,
                  isDirectNeighbor,
                )}`}
              >
                {person.avatar_path ? (
                  <img
                    src={`/${person.avatar_path}?v=${encodeURIComponent(person.updated_at)}`}
                    alt={person.full_name}
                    referrerPolicy="no-referrer"
                    className={`h-12 w-12 shrink-0 rounded-full object-cover ${
                      person.gender === 'female'
                        ? 'ring-2 ring-rose-200'
                        : person.gender === 'male'
                          ? 'ring-2 ring-sky-200'
                          : 'ring-2 ring-slate-200'
                    }`}
                  />
                ) : (
                  <div
                    className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${genderAvatarClasses(
                      person.gender,
                    )}`}
                  >
                    {getInitials(person.full_name)}
                  </div>
                )}

                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-slate-900">
                    {person.full_name}
                  </div>
                  {person.birth_name && person.birth_name !== person.full_name && (
                    <div className="truncate text-[11px] text-slate-500">
                      szül. {person.birth_name}
                    </div>
                  )}
                  <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                    <span className="font-mono tabular-nums">{years}</span>
                    <span aria-hidden="true">·</span>
                    <span>{GENDER_LABELS[person.gender]}</span>
                  </div>
                </div>
              </div>

              {/* Kijelölt kártya gyorsműveletei */}
              {isSelected && (
                <div
                  data-canvas-ui="true"
                  className="mt-2 flex flex-wrap items-center justify-center gap-1 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg"
                >
                  <button
                    type="button"
                    title="Szülő hozzáadása ehhez a személyhez"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenQuickAdd({
                        type: 'parent',
                        targetId: person.id,
                        targetName: person.full_name,
                      });
                    }}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
                  >
                    <Plus className="h-3 w-3 text-emerald-700" />
                    Szülő
                  </button>
                  <button
                    type="button"
                    title="Gyermek hozzáadása ehhez a személyhez"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenQuickAdd({
                        type: 'child',
                        targetId: person.id,
                        targetName: person.full_name,
                        unions: personUnions,
                      });
                    }}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
                  >
                    <Plus className="h-3 w-3 text-emerald-700" />
                    Gyermek
                  </button>
                  <button
                    type="button"
                    title="Házastárs vagy élettárs hozzáadása"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenQuickAdd({
                        type: 'partner',
                        targetId: person.id,
                        targetName: person.full_name,
                      });
                    }}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
                  >
                    <Plus className="h-3 w-3 text-emerald-700" />
                    Társ
                  </button>
                  <button
                    type="button"
                    title="Személy adatainak és kapcsolatainak szerkesztése"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenEditor(person.id);
                    }}
                    className="inline-flex items-center gap-1 rounded-lg bg-emerald-700 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-800 whitespace-nowrap"
                  >
                    <Pencil className="h-3 w-3" />
                    Szerkesztés
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Barátságos kezdő tipp 1 fős fánál, illetve alsó jelmagyarázat */}
      {persons.length === 1 ? (
        <div
          data-canvas-ui="true"
          className="pointer-events-none absolute bottom-4 left-1/2 z-10 w-[min(92%,560px)] -translate-x-1/2 rounded-xl border border-emerald-200 bg-white/95 px-4 py-2.5 text-center text-xs text-slate-700 shadow-sm"
        >
          <span className="font-semibold text-emerald-800">Tipp a kezdéshez:</span>{' '}
          kattints a kártyára, majd az alatta megjelenő <span className="font-semibold">+ Szülő</span>,{' '}
          <span className="font-semibold">+ Gyermek</span> vagy{' '}
          <span className="font-semibold">+ Társ</span> gombokkal egyszerűen bővítheted a családfát.
        </div>
      ) : (
        <div
          data-canvas-ui="true"
          className="pointer-events-none absolute bottom-3 left-4 z-10 hidden flex-wrap items-center gap-4 rounded-lg border border-slate-200/80 bg-white/90 px-3 py-1.5 text-[11px] text-slate-600 sm:flex"
        >
          <span>Húzd a hátteret a mozgatáshoz</span>
          <span aria-hidden="true">·</span>
          <span>Görgess a nagyításhoz</span>
          <span aria-hidden="true">·</span>
          <span>Kattints egy kártyára a közvetlen kapcsolatok kiemeléséhez</span>
        </div>
      )}
    </div>
  );
}
