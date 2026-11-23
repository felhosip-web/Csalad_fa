import type {
  Gender,
  HealthResponse,
  Person,
  PersonBundle,
  RelationType,
  TreeMeta,
  TreeSnapshot,
  UnionRecord,
  UnionStatus,
} from '../types/family';

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code = 'api_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const data = isJson ? await res.json() : null;

  if (!res.ok) {
    const msg = data?.error?.message || `Szerverhiba (${res.status})`;
    const code = data?.error?.code || 'http_error';
    throw new ApiError(msg, res.status, code);
  }
  return data as T;
}

export const familyApi = {
  health(): Promise<HealthResponse> {
    return request<HealthResponse>('/api/health');
  },

  getTree(search = ''): Promise<TreeSnapshot> {
    const qs = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
    return request<TreeSnapshot>(`/api/tree${qs}`);
  },

  renameTree(treeName: string): Promise<{ meta: TreeMeta }> {
    return request<{ meta: TreeMeta }>('/api/tree/meta', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tree_name: treeName }),
    });
  },

  getPersonBundle(personId: string): Promise<PersonBundle> {
    return request<PersonBundle>(`/api/persons/${encodeURIComponent(personId)}`);
  },

  createPerson(payload: {
    full_name: string;
    birth_name?: string;
    gender?: Gender;
    birth_date?: string;
    death_date?: string;
    is_living?: boolean;
    notes?: string;
  }): Promise<{ person: Person }> {
    return request<{ person: Person }>('/api/persons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  updatePerson(
    personId: string,
    payload: Partial<{
      full_name: string;
      birth_name: string;
      gender: Gender;
      birth_date: string;
      death_date: string;
      is_living: boolean;
      notes: string;
    }>,
  ): Promise<{ person: Person }> {
    return request<{ person: Person }>(`/api/persons/${encodeURIComponent(personId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  deletePerson(personId: string): Promise<{ deleted: Person }> {
    return request<{ deleted: Person }>(`/api/persons/${encodeURIComponent(personId)}`, {
      method: 'DELETE',
    });
  },

  uploadAvatar(personId: string, file: File): Promise<{ person: Person }> {
    const form = new FormData();
    form.append('file', file);
    return request<{ person: Person }>(`/api/persons/${encodeURIComponent(personId)}/avatar`, {
      method: 'POST',
      body: form,
    });
  },

  removeAvatar(personId: string): Promise<{ person: Person }> {
    return request<{ person: Person }>(`/api/persons/${encodeURIComponent(personId)}/avatar`, {
      method: 'DELETE',
    });
  },

  quickAddParent(
    childId: string,
    payload: {
      full_name: string;
      gender?: Gender;
      birth_date?: string;
      relation_type?: RelationType;
      union_id?: string | null;
    },
  ): Promise<{ person: Person }> {
    return request<{ person: Person }>(
      `/api/persons/${encodeURIComponent(childId)}/quick-parent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
  },

  quickAddChild(
    parentId: string,
    payload: {
      full_name: string;
      gender?: Gender;
      birth_date?: string;
      relation_type?: RelationType;
      union_id?: string | null;
      link_both_partners?: boolean;
    },
  ): Promise<{ person: Person }> {
    return request<{ person: Person }>(
      `/api/persons/${encodeURIComponent(parentId)}/quick-child`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
  },

  quickAddPartner(
    personId: string,
    payload: {
      full_name: string;
      gender?: Gender;
      birth_date?: string;
      status?: UnionStatus;
      start_date?: string;
      end_date?: string;
    },
  ): Promise<{ person: Person; union: UnionRecord }> {
    return request<{ person: Person; union: UnionRecord }>(
      `/api/persons/${encodeURIComponent(personId)}/quick-partner`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
  },

  updateUnion(
    unionId: string,
    payload: Partial<{
      status: UnionStatus;
      start_date: string;
      end_date: string;
      notes: string;
    }>,
  ): Promise<{ union: UnionRecord }> {
    return request<{ union: UnionRecord }>(`/api/unions/${encodeURIComponent(unionId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  deleteUnion(unionId: string): Promise<void> {
    return request<void>(`/api/unions/${encodeURIComponent(unionId)}`, {
      method: 'DELETE',
    });
  },

  deleteRelation(childId: string, parentId: string): Promise<void> {
    return request<void>(
      `/api/relations/${encodeURIComponent(childId)}/${encodeURIComponent(parentId)}`,
      { method: 'DELETE' },
    );
  },

  seedSample(): Promise<TreeSnapshot> {
    return request<TreeSnapshot>('/api/package/seed-sample', { method: 'POST' });
  },

  createNewTree(treeName: string): Promise<TreeSnapshot> {
    return request<TreeSnapshot>('/api/package/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tree_name: treeName }),
    });
  },

  importPackage(file: File): Promise<{ meta: TreeMeta; tree: TreeSnapshot }> {
    const form = new FormData();
    form.append('file', file);
    return request<{ meta: TreeMeta; tree: TreeSnapshot }>('/api/package/import', {
      method: 'POST',
      body: form,
    });
  },
};
