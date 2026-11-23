export type Gender = 'male' | 'female' | 'other' | 'unknown';

export type UnionStatus =
  | 'married'
  | 'divorced'
  | 'partner'
  | 'widowed'
  | 'separated'
  | 'unknown';

export type RelationType = 'biological' | 'adoptive' | 'step' | 'foster' | 'guardian';

export interface Person {
  id: string;
  full_name: string;
  birth_name: string;
  gender: Gender;
  birth_date: string;
  death_date: string;
  is_living: boolean;
  avatar_path: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface UnionRecord {
  id: string;
  partner1_id: string;
  partner2_id: string | null;
  status: UnionStatus;
  start_date: string;
  end_date: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface ParentChild {
  child_id: string;
  parent_id: string;
  union_id: string | null;
  relation_type: RelationType;
  created_at: string;
}

export interface TreeMeta {
  format: string;
  format_version: number;
  schema_version: number;
  tree_name: string;
  app_version: string;
  created_at: string;
  updated_at: string;
  person_count: number;
  union_count: number;
  relation_count: number;
  checksum_algorithm?: string;
  checksums?: Record<string, string>;
}

export interface UndoState {
  can_undo: boolean;
  last_label: string;
  steps_available?: number;
}

export interface AppErrorInfo {
  title?: string;
  message: string;
  hint?: string;
  code?: string;
  status?: number;
  onRetry?: () => void | Promise<void>;
}

export type SourceType = 'registry' | 'photo' | 'oral_history' | 'document' | 'other';

export interface SourceRecord {
  id: string;
  source_type: SourceType;
  title: string;
  reference: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface PersonSourceItem {
  person_id: string;
  source_id: string;
  citation_note: string;
  created_at: string;
  source: SourceRecord;
}

export interface TreeSnapshot {
  meta: TreeMeta;
  persons: Person[];
  unions: UnionRecord[];
  parent_child: ParentChild[];
  sources?: SourceRecord[];
  undo?: UndoState;
}

export interface GedcomImportResponse {
  meta: TreeMeta;
  tree: TreeSnapshot;
  imported: {
    person_count: number;
    union_count: number;
    relation_count: number;
    source_count: number;
  };
}

export interface PersonBundle {
  person: Person;
  parents: Array<ParentChild & { person: Person }>;
  unions: Array<
    UnionRecord & {
      partner: Person | null;
      children: Array<ParentChild & { person: Person }>;
    }
  >;
  children: Array<ParentChild & { person: Person }>;
  siblings: Array<{
    person: Person;
    shared_parent_ids: string[];
    sibling_type: 'full' | 'half';
  }>;
  sources?: PersonSourceItem[];
}

export interface HealthResponse {
  status: string;
  engine: string;
  version: string;
  backend_version?: string;
  pillow_available: boolean;
}

export interface VersionResponse {
  backend_version: string;
  engine: string;
  schema_version: number;
}

export const GENDER_LABELS: Record<Gender, string> = {
  female: 'Nő',
  male: 'Férfi',
  other: 'Egyéb',
  unknown: 'Ismeretlen',
};

export const UNION_STATUS_LABELS: Record<UnionStatus, string> = {
  married: 'Házas',
  divorced: 'Elvált',
  partner: 'Élettárs',
  widowed: 'Megözvegyült',
  separated: 'Különélő',
  unknown: 'Ismeretlen',
};

export const UNION_STATUS_CANVAS_LABELS: Record<UnionStatus, string> = {
  married: 'Házasok',
  divorced: 'Elváltak',
  partner: 'Élettársak',
  widowed: 'Megözvegyült',
  separated: 'Különélnek',
  unknown: '',
};

export const RELATION_TYPE_LABELS: Record<RelationType, string> = {
  biological: 'Vér szerinti',
  adoptive: 'Örökbefogadó',
  step: 'Mostoha',
  foster: 'Nevelő',
  guardian: 'Gyám',
};

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  registry: 'Anyakönyv',
  photo: 'Fénykép',
  oral_history: 'Családi elbeszélés',
  document: 'Dokumentum',
  other: 'Egyéb',
};

export const SOURCE_TYPE_TOOLTIPS: Record<SourceType, string> = {
  registry: 'Állami vagy egyházi anyakönyvi kivonat, keresztelési, házassági vagy halotti bejegyzés',
  photo: 'Régi családi fénykép, portré, hátoldali felirat vagy albumbejegyzés',
  oral_history: 'Nagyszülőktől, rokonoktól hallott családi történet, interjú vagy hangfelvétel',
  document: 'Személyi irat, bizonyítvány, katonakönyv, levél, birtoklevél vagy újságcikk',
  other: 'Minden más olyan forrás, amely alátámasztja a személy adatait',
};
