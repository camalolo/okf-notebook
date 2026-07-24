import type { BundleConfig, TreeNode, FileContent } from '../types.ts';

const API_BASE = '/api/notebook';

/** Read the response body once and try to surface a meaningful error message. */
async function extractError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'string') return parsed;
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.error === 'string') return obj.error;
        if (typeof obj.message === 'string') return obj.message;
      }
    } catch {
      return text;
    }
  }
  return `${res.status} ${res.statusText}`;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    throw new Error(await extractError(res));
  }
  if (res.status === 204) {
    return undefined as unknown as T;
  }
  return (await res.json()) as T;
}

function jsonOptions(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** Encode a slash-delimited path while preserving the separators. */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function getBundles(): Promise<BundleConfig[]> {
  return request<BundleConfig[]>(`${API_BASE}/bundles`);
}

export async function getBundleTree(id: string): Promise<TreeNode> {
  const nodes = await request<TreeNode[]>(`${API_BASE}/bundles/${encodeURIComponent(id)}/tree`);
  // Wrap the array in a synthetic root node so FileTree can use node.children.
  return { name: 'root', path: '', type: 'directory', children: nodes };
}

export function addBundle(data: {
  name: string;
  path: string;
  icon?: string;
  description?: string;
}): Promise<BundleConfig> {
  return request<BundleConfig>(
    `${API_BASE}/bundles`,
    jsonOptions(data),
  );
}

export function updateBundle(
  id: string,
  data: { name?: string; icon?: string; description?: string },
): Promise<BundleConfig> {
  return request<BundleConfig>(`${API_BASE}/bundles/${encodeURIComponent(id)}`, {
    ...jsonOptions(data),
    method: 'PATCH',
  });
}

export function removeBundle(id: string): Promise<void> {
  return request<void>(`${API_BASE}/bundles/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export function readFile(bundleId: string, filePath: string): Promise<FileContent> {
  return request<FileContent>(
    `${API_BASE}/bundles/${encodeURIComponent(bundleId)}/files/${encodePath(filePath)}`,
  );
}

/** Overwrite an existing file's raw contents. */
export function updateFileRaw(bundleId: string, filePath: string, raw: string): Promise<void> {
  return request<void>(
    `${API_BASE}/bundles/${encodeURIComponent(bundleId)}/files/${encodePath(filePath)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    },
  );
}

/** Create a new file with the given path and raw contents. */
export function createFileRaw(bundleId: string, filePath: string, raw: string): Promise<void> {
  return request<void>(`${API_BASE}/bundles/${encodeURIComponent(bundleId)}/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, raw }),
  });
}
