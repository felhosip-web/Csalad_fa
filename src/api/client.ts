import type {
  Gender,
  HealthResponse,
  ParentChild,
  Person,
  PersonBundle,
  RelationType,
  TreeMeta,
  TreeSnapshot,
  UnionRecord,
  UnionStatus,
  VersionResponse,
} from '../types/family';
import { translateBackendError } from '../utils/hungarian';

export class ApiError extends Error {
  status: number;
  code: string;
  hint?: string;

  constructor(message: string, status: number, code = 'api_error', hint?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

async function parseErrorResponse(res: Response): Promise<ApiError> {
  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const data = isJson ? await res.json().catch(() => null) : null;
  const rawMsg = data?.error?.message || res.statusText;
  const msg = translateBackendError(rawMsg, res.status);
  const code = typeof data?.error?.code === 'string' ? data.error.code : 'HTTP_ERROR';
  const hint =
    typeof data?.error?.hint === 'string' && data.error.hint.trim()
      ? translateBackendError(data.error.hint)
      : undefined;
  return new ApiError(msg, res.status, code, hint);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new ApiError(
      translateBackendError(err),
      0,
      'NETWORK_ERROR',
      'Ellenőrizd, hogy fut-e a helyi háttérprogram, majd próbáld meg újra.',
    );
  }

  if (!res.ok) {
    throw await parseErrorResponse(res);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const data = isJson ? await res.json().catch(() => null) : null;
  if (isJson && data === null) {
    throw new ApiError(
      'A háttérprogram válasza nem értelmezhető.',
      res.status,
      'INVALID_RESPONSE',
    );
  }
  return data as T;
}

export const familyApi = {
  health(): Promise<HealthResponse> {
    return request<HealthResponse>('/api/health');
  },

  version(): Promise<VersionResponse> {
    return request<VersionResponse>('/api/version');
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
      birth_name?: string;
      gender?: Gender;
      birth_date?: string;
      death_date?: string;
      is_living?: boolean;
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
      birth_name?: string;
      gender?: Gender;
      birth_date?: string;
      death_date?: string;
      is_living?: boolean;
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
      birth_name?: string;
      gender?: Gender;
      birth_date?: string;
      death_date?: string;
      is_living?: boolean;
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

  createUnion(payload: {
    partner1_id: string;
    partner2_id?: string | null;
    status?: UnionStatus;
    start_date?: string;
    end_date?: string;
    notes?: string;
  }): Promise<{ union: UnionRecord }> {
    return request<{ union: UnionRecord }>('/api/unions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
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

  upsertRelation(payload: {
    child_id: string;
    parent_id: string;
    union_id?: string | null;
    relation_type?: RelationType;
  }): Promise<{ relation: ParentChild }> {
    return request<{ relation: ParentChild }>('/api/relations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  deleteRelation(childId: string, parentId: string): Promise<void> {
    return request<void>(
      `/api/relations/${encodeURIComponent(childId)}/${encodeURIComponent(parentId)}`,
      { method: 'DELETE' },
    );
  },

  undo(): Promise<{ undone_label: string; message?: string; tree: TreeSnapshot }> {
    return request<{ undone_label: string; message?: string; tree: TreeSnapshot }>('/api/undo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
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

  importPackage(file: File): Promise<{ meta: TreeMeta; tree: TreeSnapshot; warning?: string | null }> {
    const form = new FormData();
    form.append('file', file);
    return request<{ meta: TreeMeta; tree: TreeSnapshot; warning?: string | null }>(
      '/api/package/import',
      {
        method: 'POST',
        body: form,
      },
    );
  },

  async exportPackageBlob(): Promise<Blob> {
    let res: Response;
    try {
      res = await fetch('/api/package/export');
    } catch (err) {
      throw new ApiError(
        translateBackendError(err),
        0,
        'NETWORK_ERROR',
        'Ellenőrizd a kapcsolatot, majd próbáld meg újra a mentést.',
      );
    }
    if (!res.ok) {
      throw await parseErrorResponse(res);
    }
    const blob = await res.blob();
    if (!blob || blob.size === 0) {
      throw new ApiError(
        'A letöltött .ftree mentési fájl üres.',
        res.status,
        'EMPTY_EXPORT',
      );
    }
    return blob;
  },
};
