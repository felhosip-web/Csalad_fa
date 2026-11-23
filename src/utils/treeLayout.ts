import type {
  ParentChild,
  Person,
  RelationType,
  UnionRecord,
  UnionStatus,
} from '../types/family';
import { UNION_STATUS_CANVAS_LABELS, UNION_STATUS_LABELS } from '../types/family';
import { extractDisplayYear, formatHungarianDate } from './hungarian';

export const CARD_WIDTH = 228;
export const CARD_HEIGHT = 96;
export const UNION_GAP = 92;
export const SIBLING_GAP = 40;
export const ROW_STEP = 204; // CARD_HEIGHT + 108px jelölő- és vonalfolyosó
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
  childId: string;
  parentIds: string[];
  unionId: string | null;
  relationType: RelationType;
  svgPath: string;
  arrowX: number;
  arrowY: number;
  isBiological: boolean;
}

export interface TreeLayoutResult {
  nodes: LayoutNode[];
  nodeById: Map<string, LayoutNode>;
  unions: LayoutUnion[];
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

  const nodes: LayoutNode[] = [];
  const nodeById = new Map<string, LayoutNode>();

  for (let g = 0; g <= maxGen; g++) {
    const rowIds = rows.get(g) ?? [];
    for (const id of rowIds) {
      const person = personById.get(id);
      if (!person) continue;
      const node: LayoutNode = {
        person,
        generation: g,
        x: (xPos.get(id) ?? CANVAS_PADDING) + shiftX,
        y: CANVAS_PADDING + g * ROW_STEP,
      };
      nodes.push(node);
      nodeById.set(id, node);
    }
  }

  // Párkapcsolati vonalak felépítése
  const layoutUnions: LayoutUnion[] = [];
  const unionById = new Map<string, LayoutUnion>();

  // Segédtérkép annak eldöntésére, szomszédos-e két partner a sorban
  const rowSortedOrder = new Map<number, string[]>();
  for (let g = 0; g <= maxGen; g++) {
    const sorted = (rows.get(g) ?? [])
      .slice()
      .sort((a, b) => (nodeById.get(a)?.x ?? 0) - (nodeById.get(b)?.x ?? 0));
    rowSortedOrder.set(g, sorted);
  }

  let nonAdjacentOffsetIdx = 0;

  for (const u of unions) {
    const n1 = nodeById.get(u.partner1_id);
    if (!n1) continue;
    const n2 = u.partner2_id ? nodeById.get(u.partner2_id) ?? null : null;

    if (!n2) {
      const anchorX = n1.x + CARD_WIDTH / 2;
      const anchorY = n1.y + CARD_HEIGHT;
      const lu: LayoutUnion = {
        union: u,
        p1: n1,
        p2: null,
        isAdjacent: true,
        sameRow: true,
        anchorX,
        anchorY,
        label: buildOrthogonalUnionLabel(u),
        tooltip: buildUnionTooltip(u),
        status: u.status,
        svgPath: '',
        labelX: anchorX,
        labelY: anchorY,
      };
      layoutUnions.push(lu);
      unionById.set(u.id, lu);
      continue;
    }

    const left = n1.x <= n2.x ? n1 : n2;
    const right = n1.x <= n2.x ? n2 : n1;
    const sameRow = left.generation === right.generation;
    let isAdjacent = false;

    if (sameRow) {
      const sortedRow = rowSortedOrder.get(left.generation) ?? [];
      const i1 = sortedRow.indexOf(left.person.id);
      const i2 = sortedRow.indexOf(right.person.id);
      isAdjacent = Math.abs(i1 - i2) === 1;
    }

    let svgPath = '';
    let anchorX = (left.x + CARD_WIDTH / 2 + right.x + CARD_WIDTH / 2) / 2;
    let anchorY = left.y + CARD_HEIGHT / 2;
    let labelX = anchorX;
    let labelY = anchorY;

    if (sameRow && isAdjacent) {
      const x1 = left.x + CARD_WIDTH;
      const x2 = right.x;
      const y = left.y + CARD_HEIGHT / 2;
      svgPath = `M ${x1} ${y} L ${x2} ${y}`;
      anchorX = (x1 + x2) / 2;
      anchorY = y;
      labelX = anchorX;
      labelY = y;
    } else {
      const x1 = left.x + CARD_WIDTH / 2;
      const y1 = left.y + CARD_HEIGHT;
      const x2 = right.x + CARD_WIDTH / 2;
      const y2 = right.y + CARD_HEIGHT;
      const dropLevel = Math.max(y1, y2) + 20 + (nonAdjacentOffsetIdx % 3) * 10;
      nonAdjacentOffsetIdx += 1;
      svgPath = `M ${x1} ${y1} V ${dropLevel} H ${x2} V ${y2}`;
      anchorX = (x1 + x2) / 2;
      anchorY = dropLevel;
      labelX = anchorX;
      labelY = dropLevel;
    }

    const lu: LayoutUnion = {
      union: u,
      p1: left,
      p2: right,
      isAdjacent,
      sameRow,
      anchorX,
      anchorY,
      label: buildOrthogonalUnionLabel(u),
      tooltip: buildUnionTooltip(u),
      status: u.status,
      svgPath,
      labelX,
      labelY,
    };
    layoutUnions.push(lu);
    unionById.set(u.id, lu);
  }

  // Szülő-gyermek élek csoportosítása union / szülőpárok szerint
  const relationsByChild = new Map<string, ParentChild[]>();
  for (const rel of relations) {
    if (!nodeById.has(rel.child_id) || !nodeById.has(rel.parent_id)) continue;
    if (!relationsByChild.has(rel.child_id)) relationsByChild.set(rel.child_id, []);
    relationsByChild.get(rel.child_id)!.push(rel);
  }

  // Segéd: két szülő között létezik-e union, ha union_id nincs kitöltve
  const findUnionForParents = (pA: string, pB: string): LayoutUnion | undefined => {
    for (const lu of layoutUnions) {
      if (!lu.p2) continue;
      const ids = [lu.p1.person.id, lu.p2.person.id];
      if (ids.includes(pA) && ids.includes(pB)) return lu;
    }
    return undefined;
  };

  interface AnchorGroup {
    anchorX: number;
    anchorY: number;
    unionId: string | null;
    items: Array<{
      childNode: LayoutNode;
      parentIds: string[];
      relationType: RelationType;
    }>;
  }

  const anchorGroups = new Map<string, AnchorGroup>();

  for (const [childId, childRels] of relationsByChild.entries()) {
    const childNode = nodeById.get(childId)!;
    const explicitUnionRel = childRels.find((r) => r.union_id && unionById.has(r.union_id));

    if (explicitUnionRel && explicitUnionRel.union_id) {
      const lu = unionById.get(explicitUnionRel.union_id)!;
      const key = `u:${lu.union.id}`;
      if (!anchorGroups.has(key)) {
        anchorGroups.set(key, {
          anchorX: lu.anchorX,
          anchorY: lu.anchorY,
          unionId: lu.union.id,
          items: [],
        });
      }
      anchorGroups.get(key)!.items.push({
        childNode,
        parentIds: childRels.map((r) => r.parent_id),
        relationType: explicitUnionRel.relation_type,
      });
      continue;
    }

    if (childRels.length === 2) {
      const matchedUnion = findUnionForParents(childRels[0].parent_id, childRels[1].parent_id);
      if (matchedUnion) {
        const key = `u:${matchedUnion.union.id}`;
        if (!anchorGroups.has(key)) {
          anchorGroups.set(key, {
            anchorX: matchedUnion.anchorX,
            anchorY: matchedUnion.anchorY,
            unionId: matchedUnion.union.id,
            items: [],
          });
        }
        anchorGroups.get(key)!.items.push({
          childNode,
          parentIds: childRels.map((r) => r.parent_id),
          relationType: childRels[0].relation_type,
        });
        continue;
      }
    }

    // Egyedülálló szülő vagy union nélküli szülő-kapcsolat
    for (const rel of childRels) {
      const parentNode = nodeById.get(rel.parent_id)!;
      const key = `p:${parentNode.person.id}`;
      if (!anchorGroups.has(key)) {
        anchorGroups.set(key, {
          anchorX: parentNode.x + CARD_WIDTH / 2,
          anchorY: parentNode.y + CARD_HEIGHT,
          unionId: null,
          items: [],
        });
      }
      anchorGroups.get(key)!.items.push({
        childNode,
        parentIds: [rel.parent_id],
        relationType: rel.relation_type,
      });
    }
  }

  const childEdges: LayoutChildEdge[] = [];
  let busLaneOffset = 0;

  for (const group of anchorGroups.values()) {
    const laneDelta = (busLaneOffset % 4) * 8;
    busLaneOffset += 1;

    for (const item of group.items) {
      const cx = item.childNode.x + CARD_WIDTH / 2;
      const cy = item.childNode.y;
      const endY = cy - 6;
      const busY = Math.min(endY - 22 - laneDelta, Math.max(group.anchorY + 28, endY - 30));
      const path =
        Math.abs(group.anchorX - cx) < 1
          ? `M ${group.anchorX} ${group.anchorY} L ${cx} ${endY}`
          : `M ${group.anchorX} ${group.anchorY} V ${busY} H ${cx} V ${endY}`;

      childEdges.push({
        id: `${group.unionId ?? group.items[0].parentIds.join('-')}-${item.childNode.person.id}`,
        childId: item.childNode.person.id,
        parentIds: item.parentIds,
        unionId: group.unionId,
        relationType: item.relationType,
        svgPath: path,
        arrowX: cx,
        arrowY: cy,
        isBiological: item.relationType === 'biological',
      });
    }
  }

  const width = Math.max(960, maxRight + shiftX + CANVAS_PADDING);
  const height = Math.max(600, (maxGen + 1) * ROW_STEP + CANVAS_PADDING);

  return {
    nodes,
    nodeById,
    unions: layoutUnions,
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
}

/**
 * Kijelölt személyhez tartozó közvetlen rokoni környezet (szülők, partnerek, gyermekek)
 * és az őket összekötő vonalak összegyűjtése kiemeléshez.
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
      personIds.add(edge.childId);
      for (const pid of edge.parentIds) {
        personIds.add(pid);
      }
      if (edge.unionId) {
        unionIds.add(edge.unionId);
      }
    }
  }

  return { personIds, unionIds, edgeIds };
}

