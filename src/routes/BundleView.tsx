import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { BundleConfig, FileContent, TreeNode } from '../types.ts';
import { getBundles, getBundleTree, readFile } from '../services/api.ts';
import { FileTree } from '../components/FileTree.tsx';
import { MarkdownViewer } from '../components/MarkdownViewer.tsx';
import { ChatPanel } from '../components/ChatPanel.tsx';

function toMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * Loads and renders a single file's content. Remounts whenever `filePath`
 * changes (via `key`), so its initial state acts as the reset — no synchronous
 * setState is needed inside the effect.
 */
function FilePane({
  bundleId,
  filePath,
  onNavigate,
}: {
  bundleId: string;
  filePath: string;
  onNavigate: (relativePath: string) => void;
}) {
  const [content, setContent] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    readFile(bundleId, filePath)
      .then((file) => {
        if (active) {
          setContent(file);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (active) setError(toMessage(err, 'Failed to load file'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [bundleId, filePath]);

  if (error) {
    return <div className="error-banner">{error}</div>;
  }

  if (loading) {
    return (
      <div className="centered-spinner">
        <div className="spinner" />
      </div>
    );
  }

  if (!content) {
    return null;
  }

  return (
    <article className="doc">
      <header className="doc-header">
        {content.type && <span className="doc-type">{content.type}</span>}
        <h1 className="doc-title">{content.title ?? content.path}</h1>
        <span className="doc-path">{content.path}</span>
      </header>
      <MarkdownViewer content={content.body} onNavigate={onNavigate} />
    </article>
  );
}

/** Slide-out reader panel that overlays the chat when a file is selected. */
function FileReaderPanel({
  bundleId,
  filePath,
  onClose,
  onNavigate,
}: {
  bundleId: string;
  filePath: string;
  onClose: () => void;
  onNavigate: (relativePath: string) => void;
}) {
  const fileName = filePath.split('/').pop() ?? filePath;

  return (
    <>
      <div
        className="file-reader-backdrop"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className="file-reader-panel"
        role="dialog"
        aria-label={`Reading ${fileName}`}
      >
        <header className="file-reader-header">
          <span className="file-reader-title" title={filePath}>
            📄 {fileName}
          </span>
          <button
            type="button"
            className="header-icon-btn"
            onClick={onClose}
            aria-label="Close reader"
            title="Close (Esc)"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path
                fill="currentColor"
                d="M18.3 5.71 12 12.01l-6.3-6.3-1.41 1.41L10.59 13.42 4.29 19.72l1.41 1.41 6.3-6.3 6.3 6.3 1.41-1.41-6.3-6.3 6.3-6.3z"
              />
            </svg>
          </button>
        </header>
        <div className="file-reader-body">
          <FilePane
            bundleId={bundleId}
            filePath={filePath}
            onNavigate={onNavigate}
          />
        </div>
      </aside>
    </>
  );
}

interface BundleWorkspaceProps {
  bundleId: string;
  filePath: string;
  onSelect: (path: string) => void;
  onNavigate: (relativePath: string) => void;
  onCloseFile: () => void;
}

function BundleWorkspace({
  bundleId,
  filePath,
  onSelect,
  onNavigate,
  onCloseFile,
}: BundleWorkspaceProps) {
  const [bundle, setBundle] = useState<BundleConfig | null>(null);
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    typeof window !== 'undefined' && window.innerWidth <= 760,
  );

  // Fetch the bundle tree + metadata. `bundleId` is stable for this mount
  // (the parent remounts via `key`), so this runs once per bundle.
  useEffect(() => {
    let active = true;
    Promise.all([getBundleTree(bundleId), getBundles()])
      .then(([treeNode, bundles]) => {
        if (!active) return;
        setTree(treeNode);
        setBundle(bundles.find((b) => b.id === bundleId) ?? null);
        setError(null);
      })
      .catch((err: unknown) => {
        if (active) setError(toMessage(err, 'Failed to load bundle'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [bundleId]);

  // Close the reader panel on Escape.
  useEffect(() => {
    if (!filePath) return;
    function handleKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onCloseFile();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [filePath, onCloseFile]);

  return (
    <div
      className={`bundle-view${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}
    >
      <aside className="bundle-sidebar">
        <div className="bundle-sidebar-header">
          <div className="bundle-sidebar-top">
            <Link to="/" className="bundle-back">
              ← All bundles
            </Link>
            <button
              type="button"
              className="sidebar-toggle"
              onClick={() => setSidebarCollapsed(true)}
              aria-label="Hide sidebar"
              title="Hide sidebar"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M14.7 5.3 8.4 12l6.3 6.7 1.5-1.4L11.2 12l5-5.3z"
                />
              </svg>
            </button>
          </div>
          {bundle && (
            <div className="bundle-meta">
              <span className="bundle-meta-icon" aria-hidden="true">
                {bundle.icon || '📚'}
              </span>
              <span className="bundle-meta-name">{bundle.name}</span>
            </div>
          )}
        </div>
        <div className="bundle-tree">
          {loading ? (
            <div className="centered-spinner">
              <div className="spinner spinner-sm" />
            </div>
          ) : tree ? (
            <FileTree node={tree} activePath={filePath} onSelect={onSelect} />
          ) : null}
        </div>
      </aside>

      {/* Mobile-only backdrop (hidden on desktop via CSS). Tapping it closes
          the overlay sidebar. */}
      <div
        className="sidebar-backdrop"
        onClick={() => setSidebarCollapsed(true)}
        aria-hidden="true"
      />

      {sidebarCollapsed && (
        <button
          type="button"
          className="sidebar-toggle sidebar-toggle-floating"
          onClick={() => setSidebarCollapsed(false)}
          aria-label="Show sidebar"
          title="Show sidebar"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              fill="currentColor"
              d="M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z"
            />
          </svg>
        </button>
      )}

      <section className="bundle-content">
        {error ? (
          <div className="error-banner">{error}</div>
        ) : (
          <ChatPanel
            bundleId={bundleId}
            bundleName={bundle?.name}
            bundleIcon={bundle?.icon}
          />
        )}
      </section>

      {filePath && (
        <FileReaderPanel
          bundleId={bundleId}
          filePath={filePath}
          onClose={onCloseFile}
          onNavigate={onNavigate}
        />
      )}
    </div>
  );
}

export function BundleView() {
  const { bundleId = '', '*': splat } = useParams();
  const navigate = useNavigate();
  const filePath = splat ?? '';

  const handleSelect = useCallback(
    (path: string) => {
      navigate(`/bundle/${bundleId}/file/${path}`);
    },
    [bundleId, navigate],
  );

  const handleNavigate = useCallback(
    (relativePath: string) => {
      navigate(`/bundle/${bundleId}/file/${relativePath}`);
    },
    [bundleId, navigate],
  );

  const handleCloseFile = useCallback(() => {
    navigate(`/bundle/${bundleId}`);
  }, [bundleId, navigate]);

  return (
    <BundleWorkspace
      key={bundleId}
      bundleId={bundleId}
      filePath={filePath}
      onSelect={handleSelect}
      onNavigate={handleNavigate}
      onCloseFile={handleCloseFile}
    />
  );
}
