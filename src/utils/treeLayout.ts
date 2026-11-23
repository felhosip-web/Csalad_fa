import type {
  ParentChild,
  Person,
  RelationType,
  UnionRecord,
  UnionStatus,
} from '../types/family';
import {
  RELATION_TYPE_LABELS,
  UNION_STATUS_CANVAS_LABELS,
  UNION_STATUS_LABELS,
} from '../types/family';
import { extractDisplayYear, formatHungarianDate } from './hungarian';

export const CARD_WIDTH = 228;
export const CARD_HEIGHT = 96;
export const UNION_GAP = 92;
export const SIBLING_GAP = 40;
export const ROW_STEP = 212; // Alapértelmezett generációs lépésköz
export const LANE_STEP = 14;
export const CANVAS_PADDING = 80;

export interface LayoutNode {
  person: Person;
  generation: number;
  x: number;
  y: number;
}

export interface LayoutUnion {
  union: UnionRecord;
  p1: LayoutNode;
  p2: LayoutNode | null;
  isAdjacent: boolean;
  sameRow: boolean;
  anchorX: number;
  anchorY: number;
  label: string;
  tooltip: string;
  status: UnionStatus;
  svgPath: string;
  labelX: number;
  labelY: number;
}

export interface LayoutChildEdge {
  id: string;
  busId: string;
  childId: string;
  childName: string;
  parentIds: string[];
  unionId: string | null;
  relationType: RelationType;
  svgPath: string;
  arrowX: number;
  arrowY: number;
  isBiological: boolean;
  tooltip: string;
}

export interface LayoutBusSegment {
  id: string;
  x1: number;
  x2: number;
  y: number;
  svgPath: string;
  edgeIds: string[];
  isBiological: boolean;
}

export interface LayoutDescentBus {
  id: string;
  corridorGen: number;
  laneIndex: number;
  anchorX: number;
  anchorY: number;
  busY: number;
  minX: number;
  maxX: number;
  unionId: string | null;
  parentIds: string[];
  childIds: string[];
  edgeIds: string[];
  stemPath: string;
  stemIsBiological: boolean;
  segments: LayoutBusSegment[];
  children: LayoutChildEdge[];
  stemTooltip: string;
  busTooltip: string;
}

export interface TreeLayoutResult {
  nodes: LayoutNode[];
  nodeById: Map<string, LayoutNode>;
  unions: LayoutUnion[];
  buses: LayoutDescentBus[];
  childEdges: LayoutChildEdge[];
  width: number;
  height: number;
  maxGeneration: number;
}

function assignGenerations(
  persons: Person[],
  unions: UnionRecord[],
  relations: ParentChild[],
): Map<string, number> {
  const gen = new Map<string, number>();
  const parentsOf = new Map<string, string[]>();
  const childrenOf = new Map<string, string[]>();
  const partnersOf = new Map<string, string[]>();

  for (const p of persons) {
    gen.set(p.id, 0);
    parentsOf.set(p.id, []);
    childrenOf.set(p.id, []);
    partnersOf.set(p.id, []);
  }

  for (const rel of relations) {
    if (!gen.has(rel.parent_id) || !gen.has(rel.child_id)) continue;
    parentsOf.get(rel.child_id)!.push(rel.parent_id);
    childrenOf.get(rel.parent_id)!.push(rel.child_id);
  }

  for (const u of unions) {
    if (!u.partner2_id || !gen.has(u.partner1_id) || !gen.has(u.partner2_id)) continue;
    partnersOf.get(u.partner1_id)!.push(u.partner2_id);
    partnersOf.get(u.partner2_id)!.push(u.partner1_id);
  }

  // 1. Hosszabbításos generáció-meghatározás (gyermek >= szülő + 1) + házastársi igazítás
  const maxIter = Math.max(12, persons.length * 3);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;

    for (const rel of relations) {
      const pg = gen.get(rel.parent_id);
      const cg = gen.get(rel.child_id);
      if (pg === undefined || cg === undefined) continue;
      if (cg < pg + 1) {
        gen.set(rel.child_id, pg + 1);
        changed = true;
      }
    }

    for (const u of unions) {
      if (!u.partner2_id) continue;
      const g1 = gen.get(u.partner1_id);
      const g2 = gen.get(u.partner2_id);
      if (g1 === undefined || g2 === undefined || g1 === g2) continue;

      const p1HasParents = (parentsOf.get(u.partner1_id)?.length ?? 0) > 0;
      const p2HasParents = (parentsOf.get(u.partner2_id)?.length ?? 0) > 0;

      if (p1HasParents && !p2HasParents) {
        gen.set(u.partner2_id, g1);
        changed = true;
      } else if (p2HasParents && !p1HasParents) {
        gen.set(u.partner1_id, g2);
        changed = true;
      } else {
        const target = Math.max(g1, g2);
        if (g1 !== target) {
          gen.set(u.partner1_id, target);
          changed = true;
        }
        if (g2 !== target) {
          gen.set(u.partner2_id, target);
          changed = true;
        }
      }
    }

    if (!changed) break;
  }

  // 2. Szülő nélküli gyökérszemélyek lefelé igazítása közvetlenül a gyermekeik fölé
  for (let pass = 0; pass < 3; pass++) {
    for (const p of persons) {
      if ((parentsOf.get(p.id)?.length ?? 0) > 0) continue;
      const kids = childrenOf.get(p.id) ?? [];
      if (kids.length === 0) continue;
      const minChildGen = Math.min(...kids.map((kid) => gen.get(kid) ?? 0));
      const partnerGens = (partnersOf.get(p.id) ?? [])
        .filter((pid) => (parentsOf.get(pid)?.length ?? 0) > 0)
        .map((pid) => gen.get(pid) ?? 0);
      const desired =
        partnerGens.length > 0
          ? Math.min(partnerGens[0], minChildGen - 1)
          : minChildGen - 1;
      if (desired > (gen.get(p.id) ?? 0)) {
        gen.set(p.id, desired);
      }
    }
  }

  // 3. Normalizálás 0-tól
  let minG = Infinity;
  for (const g of gen.values()) {
    if (g < minG) minG = g;
  }
  if (minG !== 0 && Number.isFinite(minG)) {
    for (const [id, g] of gen.entries()) {
      gen.set(id, g - minG);
    }
  }
  return gen;
}

/**
 * Egy generáción belül összekapcsolt partner-láncok felépítése.
 * Ha egy személynek 2 partnere van ugyanabban a generációban, középre kerül: [Partner1, Személy, Partner2].
 */
function buildPartnerChains(
  rowIds: string[],
  unions: UnionRecord[],
  genMap: Map<string, number>,
): string[][] {
  const rowSet = new Set(rowIds);
  const adj = new Map<string, string[]>();
  for (const id of rowIds) adj.set(id, []);

  for (const u of unions) {
    if (!u.partner2_id) continue;
    if (!rowSet.has(u.partner1_id) || !rowSet.has(u.partner2_id)) continue;
    if (genMap.get(u.partner1_id) !== genMap.get(u.partner2_id)) continue;
    if (!adj.get(u.partner1_id)!.includes(u.partner2_id)) {
      adj.get(u.partner1_id)!.push(u.partner2_id);
    }
    if (!adj.get(u.partner2_id)!.includes(u.partner1_id)) {
      adj.get(u.partner2_id)!.push(u.partner1_id);
    }
  }

  const visited = new Set<string>();
  const chains: string[][] = [];

  for (const seed of rowIds) {
    if (visited.has(seed)) continue;
    // BFS az összefüggő partner-komponenshez
    const comp: string[] = [];
    const q = [seed];
    visited.add(seed);
    while (q.length > 0) {
      const cur = q.shift()!;
      comp.push(cur);
      for (const nb of adj.get(cur) ?? []) {
        if (!visited.has(nb)) {
          visited.add(nb);
          q.push(nb);
        }
      }
    }

    if (comp.length <= 2) {
      chains.push(comp);
      continue;
    }

    // Többszörös házasság: keressük a központi személyt (legtöbb partnerrel)
    const hub = [...comp].sort(
      (a, b) => (adj.get(b)?.length ?? 0) - (adj.get(a)?.length ?? 0),
    )[0];
    const hubPartners = adj.get(hub) ?? [];
    if (hubPartners.length >= 2) {
      const ordered: string[] = [hubPartners[0], hub, ...hubPartners.slice(1)];
      const inOrdered = new Set(ordered);
      for (const rest of comp) {
        if (!inOrdered.has(rest)) ordered.push(rest);
      }
      chains.push(ordered);
    } else {
      chains.push(comp);
    }
  }

  return chains;
}

function buildOrthogonalUnionLabel(union: UnionRecord): string {
  const statusText = UNION_STATUS_CANVAS_LABELS[union.status] ?? '';
  const startYear = extractDisplayYear(union.start_date);
  if (union.status === 'divorced' || union.status === 'separated') {
    return statusText;
  }
  if (startYear) {
    return statusText ? `${statusText} · ${startYear}` : startYear;
  }
  return statusText;
}

function buildUnionTooltip(union: UnionRecord): string {
  const statusName = UNION_STATUS_LABELS[union.status] || 'Kapcsolat';
  const start = formatHungarianDate(union.start_date);
  const end = formatHungarianDate(union.end_date);
  if (start && end) {
    return `${statusName} (${start} – ${end})`;
  }
  if (start) {
    return `${statusName} · Kezdete: ${start}`;
  }
  if (end) {
    return `${statusName} · Vége: ${end}`;
  }
  return statusName;
}

export function computeFamilyTreeLayout(
  persons: Person[],
  unions: UnionRecord[],
  relations: ParentChild[],
): TreeLayoutResult {
  if (persons.length === 0) {
    return {
      nodes: [],
      nodeById: new Map(),
      unions: [],
      buses: [],
      childEdges: [],
      width: 800,
      height: 500,
      maxGeneration: 0,
    };
  }

  const personById = new Map(persons.map((p) => [p.id, p]));
  const genMap = assignGenerations(persons, unions, relations);

  let maxGen = 0;
  const rows = new Map<number, string[]>();
  for (const p of persons) {
    const g = genMap.get(p.id) ?? 0;
    if (g > maxGen) maxGen = g;
    if (!rows.has(g)) rows.set(g, []);
    rows.get(g)!.push(p.id);
  }

  // Adjacency a baricentrum-rendezéshez
  const parentsOf = new Map<string, string[]>();
  const childrenOf = new Map<string, string[]>();
  for (const p of persons) {
    parentsOf.set(p.id, []);
    childrenOf.set(p.id, []);
  }
  for (const rel of relations) {
    if (!personById.has(rel.parent_id) || !personById.has(rel.child_id)) continue;
    parentsOf.get(rel.child_id)!.push(rel.parent_id);
    childrenOf.get(rel.parent_id)!.push(rel.child_id);
  }

  // Kezdeti X koordináták generációnként láncok alapján
  const rowChains = new Map<number, string[][]>();
  const xPos = new Map<string, number>();

  const layoutRowFromChains = (g: number, chains: string[][], targetCenter?: Map<string, number>) => {
    const placed: Array<{ chain: string[]; desiredCenter: number; width: number }> = [];
    for (const chain of chains) {
      const width =
        chain.length * CARD_WIDTH + Math.max(0, chain.length - 1) * UNION_GAP;
      let desiredCenter = 0;
      if (targetCenter) {
        const vals = chain
          .map((id) => targetCenter.get(id))
          .filter((v): v is number => v !== undefined);
        if (vals.length > 0) {
          desiredCenter = vals.reduce((a, b) => a + b, 0) / vals.length;
        } else {
          desiredCenter =
            chain.reduce((acc, id) => acc + (xPos.get(id) ?? 0) + CARD_WIDTH / 2, 0) /
            chain.length;
        }
      }
      placed.push({ chain, desiredCenter, width });
    }

    if (targetCenter) {
      placed.sort((a, b) => a.desiredCenter - b.desiredCenter);
    }

    let cursor = CANVAS_PADDING;
    for (const item of placed) {
      let startX = targetCenter ? item.desiredCenter - item.width / 2 : cursor;
      if (startX < cursor) startX = cursor;
      item.chain.forEach((id, idx) => {
        xPos.set(id, startX + idx * (CARD_WIDTH + UNION_GAP));
      });
      cursor = startX + item.width + SIBLING_GAP;
    }
  };

  for (let g = 0; g <= maxGen; g++) {
    const rowIds = rows.get(g) ?? [];
    const chains = buildPartnerChains(rowIds, unions, genMap);
    rowChains.set(g, chains);
    layoutRowFromChains(g, chains);
  }

  // Baricentrum finomhangolás: fentről lefelé, majd lentről felfelé (4 kör)
  for (let pass = 0; pass < 4; pass++) {
    // Fentről lefelé: gyermekek igazítása a szülők középéhez
    for (let g = 1; g <= maxGen; g++) {
      const chains = rowChains.get(g) ?? [];
      const desired = new Map<string, number>();
      for (const id of rows.get(g) ?? []) {
        const ps = parentsOf.get(id) ?? [];
        if (ps.length > 0) {
          const avgParentCenter =
            ps.reduce((sum, pid) => sum + (xPos.get(pid) ?? 0) + CARD_WIDTH / 2, 0) /
            ps.length;
          desired.set(id, avgParentCenter);
        }
      }
      layoutRowFromChains(g, chains, desired);
    }

    // Lentről felfelé: szülők igazítása gyermekeik középéhez
    for (let g = maxGen - 1; g >= 0; g--) {
      const chains = rowChains.get(g) ?? [];
      const desired = new Map<string, number>();
      for (const id of rows.get(g) ?? []) {
        const ks = childrenOf.get(id) ?? [];
        if (ks.length > 0) {
          const avgChildCenter =
            ks.reduce((sum, kid) => sum + (xPos.get(kid) ?? 0) + CARD_WIDTH / 2, 0) /
            ks.length;
          desired.set(id, avgChildCenter);
        }
      }
      layoutRowFromChains(g, chains, desired);
    }
  }

  // Összes csúcs eltolása, hogy a bal széle pontosan CANVAS_PADDING legyen
  let minX = Infinity;
  let maxRight = 0;
  for (const x of xPos.values()) {
    if (x < minX) minX = x;
    if (x + CARD_WIDTH > maxRight) maxRight = x + CARD_WIDTH;
  }
  const shiftX = Number.isFinite(minX) ? CANVAS_PADDING - minX : 0;

  const finalX = new Map<string, number>();
  for (const [id, x] of xPos.entries()) {
    finalX.set(id, x + shiftX);
  }

  // Segédtérkép annak eldöntésére, szomszédos-e két partner a sorban
  const rowSortedOrder = new Map<number, string[]>();
  for (let g = 0; g <= maxGen; g++) {
    const sorted = (rows.get(g) ?? [])
      .slice()
      .sort((a, b) => (finalX.get(a) ?? 0) - (finalX.get(b) ?? 0));
    rowSortedOrder.set(g, sorted);
  }

  // Párkapcsolati alapadatok (X középpont, szomszédosság, nem szomszédos hidak sora)
  interface UnionGeomDraft {
    union: UnionRecord;
    p1Id: string;
    p2Id: string | null;
    leftId: string;
    rightId: string | null;
    isAdjacent: boolean;
    sameRow: boolean;
    anchorX: number;
    bridgeCorridorGen: number | null;
    bridgeSlot: number;
  }

  const unionDrafts: UnionGeomDraft[] = [];
  const unionDraftById = new Map<string, UnionGeomDraft>();
  const bridgeCountByCorridor = new Map<number, number>();

  for (const u of unions) {
    const x1 = finalX.get(u.partner1_id);
    if (x1 === undefined) continue;
    const g1 = genMap.get(u.partner1_id) ?? 0;
    const x2 = u.partner2_id ? finalX.get(u.partner2_id) : undefined;
    const g2 = u.partner2_id ? genMap.get(u.partner2_id) : undefined;

    if (!u.partner2_id || x2 === undefined || g2 === undefined) {
      const draft: UnionGeomDraft = {
        union: u,
        p1Id: u.partner1_id,
        p2Id: null,
        leftId: u.partner1_id,
        rightId: null,
        isAdjacent: true,
        sameRow: true,
        anchorX: x1 + CARD_WIDTH / 2,
        bridgeCorridorGen: null,
        bridgeSlot: 0,
      };
      unionDrafts.push(draft);
      unionDraftById.set(u.id, draft);
      continue;
    }

    const leftId = x1 <= x2 ? u.partner1_id : u.partner2_id;
    const rightId = x1 <= x2 ? u.partner2_id : u.partner1_id;
    const leftX = Math.min(x1, x2);
    const rightX = Math.max(x1, x2);
    const leftGen = x1 <= x2 ? g1 : g2;
    const rightGen = x1 <= x2 ? g2 : g1;
    const sameRow = leftGen === rightGen;

    let isAdjacent = false;
    if (sameRow) {
      const sortedRow = rowSortedOrder.get(leftGen) ?? [];
      const i1 = sortedRow.indexOf(leftId);
      const i2 = sortedRow.indexOf(rightId);
      isAdjacent = Math.abs(i1 - i2) === 1;
    }

    let anchorX = (leftX + CARD_WIDTH / 2 + rightX + CARD_WIDTH / 2) / 2;
    let bridgeCorridorGen: number | null = null;
    let bridgeSlot = 0;

    if (sameRow && isAdjacent) {
      anchorX = (leftX + CARD_WIDTH + rightX) / 2;
    } else {
      bridgeCorridorGen = Math.max(leftGen, rightGen);
      bridgeSlot = bridgeCountByCorridor.get(bridgeCorridorGen) ?? 0;
      bridgeCountByCorridor.set(bridgeCorridorGen, bridgeSlot + 1);
    }

    const draft: UnionGeomDraft = {
      union: u,
      p1Id: u.partner1_id,
      p2Id: u.partner2_id,
      leftId,
      rightId,
      isAdjacent,
      sameRow,
      anchorX,
      bridgeCorridorGen,
      bridgeSlot,
    };
    unionDrafts.push(draft);
    unionDraftById.set(u.id, draft);
  }

  // Szülő-gyermek kapcsolatok csoportosítása kapcsolati középpontok (buszok) szerint
  const relationsByChild = new Map<string, ParentChild[]>();
  for (const rel of relations) {
    if (!finalX.has(rel.child_id) || !finalX.has(rel.parent_id)) continue;
    if (!relationsByChild.has(rel.child_id)) relationsByChild.set(rel.child_id, []);
    relationsByChild.get(rel.child_id)!.push(rel);
  }

  const findUnionDraftForParents = (pA: string, pB: string): UnionGeomDraft | undefined => {
    for (const d of unionDrafts) {
      if (!d.rightId) continue;
      if ((d.leftId === pA && d.rightId === pB) || (d.leftId === pB && d.rightId === pA)) {
        return d;
      }
    }
    return undefined;
  };

  interface BusDraftItem {
    childId: string;
    childX: number;
    childGen: number;
    parentIds: string[];
    relationType: RelationType;
  }

  interface BusDraft {
    id: string;
    anchorX: number;
    unionId: string | null;
    singleParentId: string | null;
    parentIds: string[];
    items: BusDraftItem[];
    corridorGen: number;
    laneIndex: number;
    minX: number;
    maxX: number;
  }

  const busDraftMap = new Map<string, BusDraft>();

  for (const [childId, childRels] of relationsByChild.entries()) {
    const childCenterX = (finalX.get(childId) ?? CANVAS_PADDING) + CARD_WIDTH / 2;
    const childGen = genMap.get(childId) ?? 0;
    const explicitUnionRel = childRels.find((r) => r.union_id && unionDraftById.has(r.union_id));

    if (explicitUnionRel && explicitUnionRel.union_id) {
      const ud = unionDraftById.get(explicitUnionRel.union_id)!;
      const key = `u:${ud.union.id}`;
      if (!busDraftMap.has(key)) {
        const pIds = ud.rightId ? [ud.leftId, ud.rightId] : [ud.leftId];
        busDraftMap.set(key, {
          id: key,
          anchorX: ud.anchorX,
          unionId: ud.union.id,
          singleParentId: null,
          parentIds: pIds,
          items: [],
          corridorGen: Math.max(0, childGen - 1),
          laneIndex: 0,
          minX: ud.anchorX,
          maxX: ud.anchorX,
        });
      }
      const bus = busDraftMap.get(key)!;
      bus.items.push({
        childId,
        childX: childCenterX,
        childGen,
        parentIds: Array.from(new Set([...bus.parentIds, ...childRels.map((r) => r.parent_id)])),
        relationType: explicitUnionRel.relation_type,
      });
      continue;
    }

    if (childRels.length === 2) {
      const matchedUnion = findUnionDraftForParents(childRels[0].parent_id, childRels[1].parent_id);
      if (matchedUnion) {
        const key = `u:${matchedUnion.union.id}`;
        if (!busDraftMap.has(key)) {
          busDraftMap.set(key, {
            id: key,
            anchorX: matchedUnion.anchorX,
            unionId: matchedUnion.union.id,
            singleParentId: null,
            parentIds: [matchedUnion.leftId, matchedUnion.rightId!],
            items: [],
            corridorGen: Math.max(0, childGen - 1),
            laneIndex: 0,
            minX: matchedUnion.anchorX,
            maxX: matchedUnion.anchorX,
          });
        }
        const bus = busDraftMap.get(key)!;
        bus.items.push({
          childId,
          childX: childCenterX,
          childGen,
          parentIds: childRels.map((r) => r.parent_id),
          relationType: childRels[0].relation_type,
        });
        continue;
      }
    }

    // Egyedülálló szülő vagy union nélküli szülői kapcsolat
    for (const rel of childRels) {
      const parentCenterX = (finalX.get(rel.parent_id) ?? CANVAS_PADDING) + CARD_WIDTH / 2;
      const key = `p:${rel.parent_id}`;
      if (!busDraftMap.has(key)) {
        busDraftMap.set(key, {
          id: key,
          anchorX: parentCenterX,
          unionId: null,
          singleParentId: rel.parent_id,
          parentIds: [rel.parent_id],
          items: [],
          corridorGen: Math.max(0, childGen - 1),
          laneIndex: 0,
          minX: parentCenterX,
          maxX: parentCenterX,
        });
      }
      const bus = busDraftMap.get(key)!;
      bus.items.push({
        childId,
        childX: childCenterX,
        childGen,
        parentIds: [rel.parent_id],
        relationType: rel.relation_type,
      });
    }
  }

  // Gyűjtősínek sávba osztása (interval scheduling generációs folyosónként)
  const busesByCorridor = new Map<number, BusDraft[]>();
  for (const bus of busDraftMap.values()) {
    const minChildGen = Math.min(...bus.items.map((it) => it.childGen));
    bus.corridorGen = Math.max(0, minChildGen - 1);
    const xs = [bus.anchorX, ...bus.items.map((it) => it.childX)];
    bus.minX = Math.min(...xs);
    bus.maxX = Math.max(...xs);
    if (!busesByCorridor.has(bus.corridorGen)) busesByCorridor.set(bus.corridorGen, []);
    busesByCorridor.get(bus.corridorGen)!.push(bus);
  }

  const laneCountByCorridor = new Map<number, number>();
  for (const [corridorGen, corridorBuses] of busesByCorridor.entries()) {
    corridorBuses.sort((a, b) => a.minX - b.minX || a.maxX - b.maxX);
    const laneRightEdge: number[] = [];
    for (const bus of corridorBuses) {
      const spanMin = bus.minX - 14;
      const spanMax = bus.maxX + 14;
      let chosenLane = -1;
      for (let i = 0; i < laneRightEdge.length; i++) {
        if (laneRightEdge[i] <= spanMin) {
          chosenLane = i;
          laneRightEdge[i] = spanMax;
          break;
        }
      }
      if (chosenLane === -1) {
        chosenLane = laneRightEdge.length;
        laneRightEdge.push(spanMax);
      }
      bus.laneIndex = chosenLane;
    }
    laneCountByCorridor.set(corridorGen, laneRightEdge.length);
  }

  // Generációs Y koordináták meghatározása (dinamikusan bővül, ha több sáv van)
  const rowY = new Map<number, number>();
  const topPaddingByCorridor = new Map<number, number>();
  let currentY = CANVAS_PADDING;

  for (let g = 0; g <= maxGen; g++) {
    rowY.set(g, currentY);
    const hasBridge = (bridgeCountByCorridor.get(g) ?? 0) > 0;
    const topPad = hasBridge ? 42 : 28;
    topPaddingByCorridor.set(g, topPad);
    const lanes = Math.max(1, laneCountByCorridor.get(g) ?? 0);
    const neededCorridor = topPad + lanes * LANE_STEP + 26;
    const corridorHeight = Math.max(ROW_STEP - CARD_HEIGHT, neededCorridor);
    currentY += CARD_HEIGHT + corridorHeight;
  }

  // Csomópontok végső elhelyezése
  const nodes: LayoutNode[] = [];
  const nodeById = new Map<string, LayoutNode>();

  for (let g = 0; g <= maxGen; g++) {
    const rowIds = rows.get(g) ?? [];
    const y = rowY.get(g) ?? CANVAS_PADDING;
    for (const id of rowIds) {
      const person = personById.get(id);
      if (!person) continue;
      const node: LayoutNode = {
        person,
        generation: g,
        x: finalX.get(id) ?? CANVAS_PADDING,
        y,
      };
      nodes.push(node);
      nodeById.set(id, node);
    }
  }

  // Párkapcsolati vonalak és középpontok felépítése
  const layoutUnions: LayoutUnion[] = [];
  const unionById = new Map<string, LayoutUnion>();

  for (const draft of unionDrafts) {
    const n1 = nodeById.get(draft.leftId);
    if (!n1) continue;
    const n2 = draft.rightId ? nodeById.get(draft.rightId) ?? null : null;

    if (!n2) {
      const anchorX = n1.x + CARD_WIDTH / 2;
      const anchorY = n1.y + CARD_HEIGHT;
      const lu: LayoutUnion = {
        union: draft.union,
        p1: n1,
        p2: null,
        isAdjacent: true,
        sameRow: true,
        anchorX,
        anchorY,
        label: buildOrthogonalUnionLabel(draft.union),
        tooltip: buildUnionTooltip(draft.union),
        status: draft.union.status,
        svgPath: '',
        labelX: anchorX,
        labelY: anchorY,
      };
      layoutUnions.push(lu);
      unionById.set(draft.union.id, lu);
      continue;
    }

    let svgPath = '';
    let anchorX = draft.anchorX;
    let anchorY = n1.y + CARD_HEIGHT / 2;
    let labelX = anchorX;
    let labelY = anchorY - 22;

    if (draft.sameRow && draft.isAdjacent) {
      const x1 = n1.x + CARD_WIDTH;
      const x2 = n2.x;
      const y = n1.y + CARD_HEIGHT / 2;
      svgPath = `M ${x1} ${y} L ${x2} ${y}`;
      anchorX = (x1 + x2) / 2;
      anchorY = y;
      labelX = anchorX;
      labelY = y - 22;
    } else {
      const x1 = n1.x + CARD_WIDTH / 2;
      const y1 = n1.y + CARD_HEIGHT;
      const x2 = n2.x + CARD_WIDTH / 2;
      const y2 = n2.y + CARD_HEIGHT;
      const dropLevel = Math.max(y1, y2) + 16 + (draft.bridgeSlot % 2) * 8;
      svgPath = `M ${x1} ${y1} V ${dropLevel} H ${x2} V ${y2}`;
      anchorX = (x1 + x2) / 2;
      anchorY = dropLevel;
      labelX = anchorX;
      labelY = dropLevel - 11;
    }

    const lu: LayoutUnion = {
      union: draft.union,
      p1: n1,
      p2: n2,
      isAdjacent: draft.isAdjacent,
      sameRow: draft.sameRow,
      anchorX,
      anchorY,
      label: buildOrthogonalUnionLabel(draft.union),
      tooltip: buildUnionTooltip(draft.union),
      status: draft.union.status,
      svgPath,
      labelX,
      labelY,
    };
    layoutUnions.push(lu);
    unionById.set(draft.union.id, lu);
  }

  // Gyűjtősínes (bus) leszármazási struktúra felépítése
  const buses: LayoutDescentBus[] = [];
  const childEdges: LayoutChildEdge[] = [];

  for (const draft of busDraftMap.values()) {
    const lu = draft.unionId ? unionById.get(draft.unionId) : undefined;
    const singleParentNode = draft.singleParentId ? nodeById.get(draft.singleParentId) : undefined;

    const anchorX = lu
      ? lu.anchorX
      : singleParentNode
        ? singleParentNode.x + CARD_WIDTH / 2
        : draft.anchorX;
    const anchorY = lu
      ? lu.anchorY
      : singleParentNode
        ? singleParentNode.y + CARD_HEIGHT
        : CANVAS_PADDING;

    const corridorBaseY = (rowY.get(draft.corridorGen) ?? CANVAS_PADDING) + CARD_HEIGHT;
    const topPad = topPaddingByCorridor.get(draft.corridorGen) ?? 28;
    const busY = Math.max(
      anchorY + 14,
      corridorBaseY + topPad + draft.laneIndex * LANE_STEP,
    );

    const parentNames = draft.parentIds
      .map((pid) => personById.get(pid)?.full_name)
      .filter((name): name is string => Boolean(name));
    const parentContext =
      parentNames.length >= 2
        ? `${parentNames[0]} és ${parentNames[1]} kapcsolatából`
        : parentNames.length === 1
          ? `${parentNames[0]} ágáról`
          : 'Szülői ágról';

    const itemsSorted = [...draft.items].sort((a, b) => a.childX - b.childX);
    const busChildEdges: LayoutChildEdge[] = [];

    for (const item of itemsSorted) {
      const childNode = nodeById.get(item.childId)!;
      const cx = childNode.x + CARD_WIDTH / 2;
      const cy = childNode.y;
      const endY = cy - 6;
      const isBiological = item.relationType === 'biological';
      const relLabel = RELATION_TYPE_LABELS[item.relationType];
      const tooltip = isBiological
        ? `${relLabel} leszármazási ág: ${childNode.person.full_name} (a nyíl a gyermek felé mutat)`
        : `${relLabel} kapcsolat (nem vérszerinti, szaggatott ág): ${childNode.person.full_name} (a nyíl a gyermek felé mutat)`;

      const edge: LayoutChildEdge = {
        id: `${draft.id}-${childNode.person.id}`,
        busId: draft.id,
        childId: childNode.person.id,
        childName: childNode.person.full_name,
        parentIds: item.parentIds,
        unionId: draft.unionId,
        relationType: item.relationType,
        svgPath: `M ${cx} ${busY} L ${cx} ${endY}`,
        arrowX: cx,
        arrowY: cy,
        isBiological,
        tooltip,
      };
      busChildEdges.push(edge);
      childEdges.push(edge);
    }

    // Vízszintes gyűjtősín atomi szakaszokra bontása az X-megállók között
    const rawStops = [anchorX, ...busChildEdges.map((e) => e.arrowX)].sort((a, b) => a - b);
    const uniqueStops: number[] = [];
    for (const stop of rawStops) {
      if (uniqueStops.length === 0 || Math.abs(stop - uniqueStops[uniqueStops.length - 1]) >= 1) {
        uniqueStops.push(stop);
      }
    }

    const segments: LayoutBusSegment[] = [];
    for (let i = 0; i < uniqueStops.length - 1; i++) {
      const x1 = uniqueStops[i];
      const x2 = uniqueStops[i + 1];
      if (x2 - x1 < 1) continue;
      const mid = (x1 + x2) / 2;

      const carriedEdges = busChildEdges.filter((edge) => {
        if (mid < anchorX) {
          return edge.arrowX <= x1 + 0.9;
        }
        return edge.arrowX >= x2 - 0.9;
      });

      if (carriedEdges.length === 0) continue;

      segments.push({
        id: `${draft.id}-seg-${i}`,
        x1,
        x2,
        y: busY,
        svgPath: `M ${x1} ${busY} L ${x2} ${busY}`,
        edgeIds: carriedEdges.map((e) => e.id),
        isBiological: carriedEdges.some((e) => e.isBiological),
      });
    }

    const stemIsBiological = busChildEdges.some((e) => e.isBiological);
    const childCount = busChildEdges.length;

    buses.push({
      id: draft.id,
      corridorGen: draft.corridorGen,
      laneIndex: draft.laneIndex,
      anchorX,
      anchorY,
      busY,
      minX: uniqueStops[0] ?? anchorX,
      maxX: uniqueStops[uniqueStops.length - 1] ?? anchorX,
      unionId: draft.unionId,
      parentIds: draft.parentIds,
      childIds: busChildEdges.map((e) => e.childId),
      edgeIds: busChildEdges.map((e) => e.id),
      stemPath: `M ${anchorX} ${anchorY} L ${anchorX} ${busY}`,
      stemIsBiological,
      segments,
      children: busChildEdges,
      stemTooltip: `Leszármazási gerinc (${parentContext} · ${childCount} gyermek)`,
      busTooltip: `Gyűjtősín a gyermekek összekapcsolásához (${parentContext} · ${childCount} gyermek)`,
    });
  }

  const width = Math.max(960, maxRight + shiftX + CANVAS_PADDING);
  const height = Math.max(600, currentY + CANVAS_PADDING);

  return {
    nodes,
    nodeById,
    unions: layoutUnions,
    buses,
    childEdges,
    width,
    height,
    maxGeneration: maxGen,
  };
}

export interface DirectFocusSet {
  personIds: Set<string>;
  unionIds: Set<string>;
  edgeIds: Set<string>;
  busIds: Set<string>;
}

/**
 * Kijelölt vagy rámutatott személyhez tartozó közvetlen rokoni környezet
 * (szülők, partnerek, gyermekek) és az őket összekötő gyűjtősínek/vonalak kiemeléséhez.
 */
export function getDirectFocusSet(
  selectedId: string | null,
  layout: TreeLayoutResult,
): DirectFocusSet | null {
  if (!selectedId || !layout.nodeById.has(selectedId)) {
    return null;
  }

  const personIds = new Set<string>([selectedId]);
  const unionIds = new Set<string>();
  const edgeIds = new Set<string>();
  const busIds = new Set<string>();

  for (const lu of layout.unions) {
    const isP1 = lu.p1.person.id === selectedId;
    const isP2 = lu.p2?.person.id === selectedId;
    if (isP1 || isP2) {
      unionIds.add(lu.union.id);
      personIds.add(lu.p1.person.id);
      if (lu.p2) personIds.add(lu.p2.person.id);
    }
  }

  for (const edge of layout.childEdges) {
    if (edge.childId === selectedId || edge.parentIds.includes(selectedId)) {
      edgeIds.add(edge.id);
      busIds.add(edge.busId);
      personIds.add(edge.childId);
      for (const pid of edge.parentIds) {
        personIds.add(pid);
      }
      if (edge.unionId) {
        unionIds.add(edge.unionId);
      }
    }
  }

  return { personIds, unionIds, edgeIds, busIds };
}

