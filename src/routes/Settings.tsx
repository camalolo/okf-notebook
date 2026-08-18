import { useEffect, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import type { BundleConfig, User } from '../types.ts';
import { addBundle, getBundles, getMcps, getSettings, removeBundle, updateBundle, updateModel } from '../services/api.ts';
import type { AppSettingsInfo, McpServerInfo } from '../services/api.ts';

interface SettingsProps {
  user: User;
}

interface AddFormState {
  path: string;
  name: string;
  icon: string;
  description: string;
}

const EMPTY_FORM: AddFormState = { path: '', name: '', icon: '📚', description: '' };

function toMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function Settings({ user }: SettingsProps) {
  const [bundles, setBundles] = useState<BundleConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<AddFormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [accessEditId, setAccessEditId] = useState<string | null>(null);
  const [accessDraft, setAccessDraft] = useState('');
  const [accessSaving, setAccessSaving] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [detailsEditId, setDetailsEditId] = useState<string | null>(null);
  const [detailsDraft, setDetailsDraft] = useState({ name: '', icon: '', description: '' });
  const [detailsSaving, setDetailsSaving] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
  const [mcpsEditId, setMcpsEditId] = useState<string | null>(null);
  const [mcpsDraft, setMcpsDraft] = useState<Set<string>>(new Set());
  const [mcpsSaving, setMcpsSaving] = useState(false);
  const [mcpsError, setMcpsError] = useState<string | null>(null);
  const [settingsInfo, setSettingsInfo] = useState<AppSettingsInfo | null>(null);
  const [modelDraft, setModelDraft] = useState('');
  const [modelSaving, setModelSaving] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);

  const handleSaveModel = async () => {
    if (!modelDraft) return;
    setModelSaving(true);
    setModelError(null);
    try {
      const info = await updateModel(modelDraft);
      setSettingsInfo(info);
      setModelDraft(info.model);
    } catch (err: unknown) {
      setModelError(toMessage(err, 'Failed to update model'));
    } finally {
      setModelSaving(false);
    }
  };

  const refresh = () => {
    setLoading(true);
    setError(null);
    getBundles()
      .then((list) => setBundles(list))
      .catch((err: unknown) => setError(toMessage(err, 'Failed to load bundles')))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    let active = true;
    getBundles()
      .then((list) => {
        if (active) {
          setBundles(list);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (active) setError(toMessage(err, 'Failed to load bundles'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    getSettings()
      .then((info) => {
        if (active) {
          setSettingsInfo(info);
          setModelDraft(info.model);
          setModelError(info.models === null ? 'Could not load the model list from the API.' : null);
        }
      })
      .catch((err: unknown) => {
        if (active) setModelError(toMessage(err, 'Failed to load settings'));
      });
    getMcps()
      .then((list) => {
        if (active) setMcpServers(list);
      })
      .catch(() => {
        // Non-fatal — the MCP editor shows a hint when the list is empty.
      });
    return () => {
      active = false;
    };
  }, []);

  // Readonly users must not reach this page.
  if (user.role !== 'full') {
    return <Navigate to="/" replace />;
  }

  const update = (key: keyof AddFormState, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const path = form.path.trim();
    const name = form.name.trim();
    if (!path || !name) {
      setFormError('Directory path and display name are required.');
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      await addBundle({
        path,
        name,
        icon: form.icon.trim() || undefined,
        description: form.description.trim() || undefined,
      });
      setForm(EMPTY_FORM);
      refresh();
    } catch (err: unknown) {
      setFormError(toMessage(err, 'Failed to add bundle'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async (id: string) => {
    try {
      await removeBundle(id);
      setConfirmId(null);
      refresh();
    } catch (err: unknown) {
      setError(toMessage(err, 'Failed to remove bundle'));
      setConfirmId(null);
    }
  };

  const openAccessEditor = (b: BundleConfig) => {
    setDetailsEditId(null);
    setMcpsEditId(null);
    setAccessEditId(b.id);
    setAccessDraft((b.allowedUsers ?? []).join(', '));
    setAccessError(null);
  };

  const openDetailsEditor = (b: BundleConfig) => {
    setAccessEditId(null);
    setMcpsEditId(null);
    setConfirmId(null);
    setDetailsEditId(b.id);
    setDetailsDraft({ name: b.name, icon: b.icon ?? '', description: b.description ?? '' });
    setDetailsError(null);
  };

  const openMcpsEditor = (b: BundleConfig) => {
    setAccessEditId(null);
    setDetailsEditId(null);
    setConfirmId(null);
    setMcpsEditId(b.id);
    // `undefined` mcps = all servers (the default for legacy bundles).
    setMcpsDraft(new Set(b.mcps ?? mcpServers.map((s) => s.name)));
    setMcpsError(null);
  };

  const handleSaveMcps = async (id: string) => {
    setMcpsSaving(true);
    setMcpsError(null);
    try {
      await updateBundle(id, { mcps: [...mcpsDraft].sort() });
      setMcpsEditId(null);
      refresh();
    } catch (err: unknown) {
      setMcpsError(toMessage(err, 'Failed to update MCP tools'));
    } finally {
      setMcpsSaving(false);
    }
  };

  const handleSaveDetails = async (id: string) => {
    const name = detailsDraft.name.trim();
    if (!name) {
      setDetailsError('Display name is required.');
      return;
    }
    setDetailsSaving(true);
    setDetailsError(null);
    try {
      await updateBundle(id, {
        name,
        icon: detailsDraft.icon.trim(),
        description: detailsDraft.description.trim(),
      });
      setDetailsEditId(null);
      refresh();
    } catch (err: unknown) {
      setDetailsError(toMessage(err, 'Failed to update bundle'));
    } finally {
      setDetailsSaving(false);
    }
  };

  const handleSaveAccess = async (id: string) => {
    const allowedUsers = [
      ...new Set(
        accessDraft
          .split(/[\s,;]+/)
          .map((e) => e.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    setAccessSaving(true);
    setAccessError(null);
    try {
      await updateBundle(id, { allowedUsers });
      setAccessEditId(null);
      refresh();
    } catch (err: unknown) {
      setAccessError(toMessage(err, 'Failed to update access'));
    } finally {
      setAccessSaving(false);
    }
  };

  return (
    <div className="page page-scroll">
      <div className="page-header">
        <h1>Settings</h1>
        <p>Manage the knowledge bundles available in Notebook.</p>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <section className="settings-section">
        <h2 className="settings-section-title">AI model</h2>
        <p className="settings-section-hint">
          The model used for every LLM feature across all bundles — chats, digests, uploads. The list
          comes straight from the API; changes apply to new requests immediately.
        </p>
        <div className="form-row">
          <label className="form-field">
            <span className="form-label">Model</span>
            <select
              className="form-input"
              value={modelDraft}
              onChange={(e) => setModelDraft(e.target.value)}
              disabled={modelSaving || !settingsInfo || settingsInfo.models === null}
            >
              {settingsInfo?.models === null ? (
                <option value={settingsInfo.model}>{settingsInfo.model}</option>
              ) : (
                // Union so a deprecated saved model still shows as selected.
                [...new Set([settingsInfo?.model, ...(settingsInfo?.models ?? [])] as string[])]
                  .filter(Boolean)
                  .map((m) => (
                    <option key={m} value={m}>
                      {m}
                      {m === settingsInfo?.defaultModel ? ' (default)' : ''}
                    </option>
                  ))
              )}
            </select>
          </label>
          <div className="form-actions model-actions">
            <button
              className="btn btn-primary"
              onClick={handleSaveModel}
              disabled={modelSaving || !modelDraft || modelDraft === settingsInfo?.model || settingsInfo?.models === null}
            >
              {modelSaving ? 'Saving…' : 'Save model'}
            </button>
          </div>
        </div>
        {modelError && <div className="error-banner error-banner-sm">{modelError}</div>}
      </section>

      <section className="settings-section">
        <h2 className="settings-section-title">Add bundle</h2>
        <p className="settings-section-hint">
          Register an existing directory of markdown files. Files on disk are never deleted when
          a bundle is removed.
        </p>

        <form className="settings-form" onSubmit={handleAdd}>
          <div className="form-row">
            <label className="form-field">
              <span className="form-label">Directory path</span>
              <input
                className="form-input"
                type="text"
                value={form.path}
                onChange={(e) => update('path', e.target.value)}
                placeholder="/home/user/Sources/MyProject"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <label className="form-field form-field-narrow">
              <span className="form-label">Icon</span>
              <input
                className="form-input"
                type="text"
                value={form.icon}
                onChange={(e) => update('icon', e.target.value)}
                placeholder="📚"
                maxLength={4}
              />
            </label>
          </div>
          <label className="form-field">
            <span className="form-label">Display name</span>
            <input
              className="form-input"
              type="text"
              value={form.name}
              onChange={(e) => update('name', e.target.value)}
              placeholder="My Project"
            />
          </label>
          <label className="form-field">
            <span className="form-label">Description</span>
            <textarea
              className="form-textarea"
              value={form.description}
              onChange={(e) => update('description', e.target.value)}
              placeholder="A short summary of what this bundle contains."
              rows={3}
            />
          </label>
          {formError && <div className="error-banner error-banner-sm">{formError}</div>}
          <div className="form-actions">
            <button className="btn btn-primary" type="submit" disabled={submitting}>
              {submitting ? 'Adding…' : 'Add bundle'}
            </button>
          </div>
        </form>
      </section>

      <section className="settings-section">
        <h2 className="settings-section-title">Registered bundles</h2>
        {loading ? (
          <div className="centered-spinner">
            <div className="spinner spinner-sm" />
          </div>
        ) : bundles.length === 0 ? (
          <p className="settings-section-hint">No bundles registered yet.</p>
        ) : (
          <ul className="bundle-list">
            {bundles.map((b) => (
              <li key={b.id} className="bundle-list-item-wrap">
                <div className="bundle-list-item">
                  <span className="bundle-list-icon" aria-hidden="true">
                    {b.icon || '📚'}
                  </span>
                  <div className="bundle-list-info">
                    <span className="bundle-list-name">{b.name}</span>
                    <span className="bundle-list-path">{b.path}</span>
                    <span className="bundle-list-access">
                      {(b.allowedUsers?.length ?? 0) === 0
                        ? 'Readonly access: none'
                        : `Readonly access: ${b.allowedUsers!.join(', ')}`}
                    </span>
                    <span className="bundle-list-access">
                      MCP tools:{' '}
                      {b.mcps === undefined
                        ? 'all servers'
                        : b.mcps.length === 0
                          ? 'none'
                          : b.mcps.join(', ')}
                    </span>
                  </div>
                  {confirmId === b.id ? (
                    <div className="bundle-list-actions">
                      <span className="confirm-text">Remove from Notebook?</span>
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() => handleRemove(b.id)}
                      >
                        Confirm
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setConfirmId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : accessEditId === b.id ? (
                    <div className="bundle-list-actions">
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setAccessEditId(null)}
                        disabled={accessSaving}
                      >
                        Cancel
                      </button>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => handleSaveAccess(b.id)}
                        disabled={accessSaving}
                      >
                        {accessSaving ? 'Saving…' : 'Save access'}
                      </button>
                    </div>
                  ) : detailsEditId === b.id ? (
                    <div className="bundle-list-actions">
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setDetailsEditId(null)}
                        disabled={detailsSaving}
                      >
                        Cancel
                      </button>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => handleSaveDetails(b.id)}
                        disabled={detailsSaving}
                      >
                        {detailsSaving ? 'Saving…' : 'Save details'}
                      </button>
                    </div>
                  ) : mcpsEditId === b.id ? (
                    <div className="bundle-list-actions">
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setMcpsEditId(null)}
                        disabled={mcpsSaving}
                      >
                        Cancel
                      </button>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => handleSaveMcps(b.id)}
                        disabled={mcpsSaving}
                      >
                        {mcpsSaving ? 'Saving…' : 'Save tools'}
                      </button>
                    </div>
                  ) : (
                    <div className="bundle-list-actions">
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => openDetailsEditor(b)}
                      >
                        Details…
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => openAccessEditor(b)}
                      >
                        Access…
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => openMcpsEditor(b)}
                        disabled={mcpServers.length === 0}
                        title={mcpServers.length === 0 ? 'No MCP servers configured' : undefined}
                      >
                        Tools…
                      </button>
                      <button
                        className="btn btn-danger-ghost btn-sm"
                        onClick={() => setConfirmId(b.id)}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>
                {accessEditId === b.id && (
                  <div className="bundle-access-editor">
                    <span className="form-label">
                      Readonly users who can see this bundle (emails, comma- or space-separated)
                    </span>
                    <textarea
                      className="form-textarea"
                      value={accessDraft}
                      onChange={(e) => setAccessDraft(e.target.value)}
                      placeholder="user@example.com"
                      rows={2}
                      spellCheck={false}
                    />
                    <span className="settings-section-hint">
                      Users with the full role always see every bundle. Leave empty to hide this
                      bundle from all readonly users. Invalid emails are dropped on save.
                    </span>
                    {accessError && <div className="error-banner error-banner-sm">{accessError}</div>}
                  </div>
                )}
                {detailsEditId === b.id && (
                  <div className="bundle-access-editor">
                    <div className="form-row">
                      <label className="form-field">
                        <span className="form-label">Display name</span>
                        <input
                          className="form-input"
                          type="text"
                          value={detailsDraft.name}
                          onChange={(e) =>
                            setDetailsDraft((prev) => ({ ...prev, name: e.target.value }))
                          }
                        />
                      </label>
                      <label className="form-field form-field-narrow">
                        <span className="form-label">Icon</span>
                        <input
                          className="form-input"
                          type="text"
                          value={detailsDraft.icon}
                          onChange={(e) =>
                            setDetailsDraft((prev) => ({ ...prev, icon: e.target.value }))
                          }
                          placeholder="📚"
                          maxLength={4}
                        />
                      </label>
                    </div>
                    <label className="form-field">
                      <span className="form-label">Description</span>
                      <textarea
                        className="form-textarea"
                        value={detailsDraft.description}
                        onChange={(e) =>
                          setDetailsDraft((prev) => ({ ...prev, description: e.target.value }))
                        }
                        placeholder="A short summary of what this bundle contains."
                        rows={3}
                      />
                    </label>
                    <span className="settings-section-hint">
                      The directory path cannot be changed after registration. Removing and
                      re-adding the bundle is the way to repoint it.
                    </span>
                    {detailsError && (
                      <div className="error-banner error-banner-sm">{detailsError}</div>
                    )}
                  </div>
                )}
                {mcpsEditId === b.id && (
                  <div className="bundle-access-editor">
                    <span className="form-label">MCP tool servers enabled for this bundle</span>
                    {mcpServers.length === 0 ? (
                      <span className="settings-section-hint">
                        No MCP servers are configured on this Notebook instance.
                      </span>
                    ) : (
                      <div className="mcp-check-list">
                        {mcpServers.map((s) => (
                          <label key={s.name} className="mcp-check">
                            <input
                              type="checkbox"
                              checked={mcpsDraft.has(s.name)}
                              onChange={(e) =>
                                setMcpsDraft((prev) => {
                                  const next = new Set(prev);
                                  if (e.target.checked) next.add(s.name);
                                  else next.delete(s.name);
                                  return next;
                                })
                              }
                            />
                            <span>
                              {s.name}
                              <em className="mcp-check-meta">
                                {' '}
                                · {s.toolCount} tool{s.toolCount === 1 ? '' : 's'}
                                {!s.running ? ' · not running' : ''}
                              </em>
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                    <span className="settings-section-hint">
                      Enabled servers expose their tools to the chat assistant inside this notebook
                      (web_search and file tools are always available). Uncheck everything to
                      disable MCP tools entirely. Changes apply to the next chat request.
                    </span>
                    {mcpsError && <div className="error-banner error-banner-sm">{mcpsError}</div>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
