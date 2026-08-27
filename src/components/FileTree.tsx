import { useCallback, useEffect, useRef, useState } from 'react';
import type { TreeNode } from '../types.ts';

interface FileTreeProps {
  node: TreeNode;
  /** Bundle id — scopes the persisted open/closed directory state. */
  bundleId: string;
  activePath: string;
  onSelect: (path: string) => void;
  /** Called when the user confirms deletion of a file. */
  onDelete?: (path: string) => void;
}

/** localStorage key holding the expanded-directory set for a bundle. */
function storageKeyFor(bundleId: string): string {
  return `nb-tree:${bundleId}`;
}

/** Load the persisted expanded-directory set; corrupted entries start fresh. */
function loadExpanded(bundleId: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKeyFor(bundleId));
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((p): p is string => typeof p === 'string'));
      }
    }
  } catch {
    // fall through — corrupted entry behaves like "nothing stored"
  }
  return new Set();
}

/** Directory paths from the root down to (excluding) the file. */
function ancestorDirs(path: string): string[] {
  const parts = path.split('/');
  const dirs: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    dirs.push(parts.slice(0, i).join('/'));
  }
  return dirs;
}

/**
 * Which directories are expanded, persisted per bundle in localStorage so the
 * tree starts exactly as the user left it (all closed on first visit).
 */
function useTreeExpansion(bundleId: string) {
  const [expanded, setExpanded] = useState<Set<string>>(() => loadExpanded(bundleId));

  // Persist every change (also covers the active-path reveal below).
  useEffect(() => {
    try {
      localStorage.setItem(storageKeyFor(bundleId), JSON.stringify([...expanded]));
    } catch {
      // Storage full or blocked — in-memory state still works for this mount.
    }
  }, [bundleId, expanded]);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  /** Expand all ancestors of `path` so the file is visible in the tree. */
  const reveal = useCallback((path: string) => {
    setExpanded((prev) => {
      const missing = ancestorDirs(path).filter((d) => !prev.has(d));
      if (missing.length === 0) return prev;
      const next = new Set(prev);
      for (const dir of missing) next.add(dir);
      return next;
    });
  }, []);

  return { expanded, toggle, reveal };
}

/** Pick an emoji for a file based on its OKF concept type or filename. */
function fileIcon(node: TreeNode): string {
  const conceptType = node.concept?.type;
  if (conceptType) {
    const lower = conceptType.toLowerCase();
    if (lower.includes('vehicle') || lower.includes('car') || lower.includes('auto')) {
      return '🚗';
    }
    if (lower.includes('student') || lower.includes('person') || lower.includes('contact')) {
      return '👤';
    }
    if (lower.includes('issue') || lower.includes('error') || lower.includes('bug')) {
      return '⚠️';
    }
    if (lower.includes('task') || lower.includes('todo') || lower.includes('project')) {
      return '✅';
    }
    if (lower.includes('note') || lower.includes('log')) {
      return '📝';
    }
    if (lower.includes('place') || lower.includes('location')) {
      return '📍';
    }
    return '🏷️';
  }
  if (node.name === 'index.md') return '🗂️';
  if (node.name === 'log.md') return '📜';
  if (node.name === 'AGENTS.md') return '🤖';
  return '📄';
}

interface TreeItemProps {
  node: TreeNode;
  activePath: string;
  onSelect: (path: string) => void;
  onDelete?: (path: string) => void;
  level: number;
  expandedDirs: ReadonlySet<string>;
  onToggleDir: (path: string) => void;
}

function TreeItem({
  node,
  activePath,
  onSelect,
  onDelete,
  level,
  expandedDirs,
  onToggleDir,
}: TreeItemProps) {
  const isDirectory = node.type === 'directory';
  const isActive = !isDirectory && node.path === activePath;
  const indent = level * 14 + 10;

  if (isDirectory) {
    const expanded = expandedDirs.has(node.path);
    return (
      <li className="tree-node" role="none">
        <button
          className="tree-row tree-row-dir"
          style={{ paddingLeft: `${indent}px` }}
          onClick={() => onToggleDir(node.path)}
          aria-expanded={expanded}
        >
          <span className="tree-chevron" aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
          <span className="tree-icon" aria-hidden="true">
            {expanded ? '📂' : '📁'}
          </span>
          <span className="tree-label">{node.name}</span>
        </button>
        {expanded && node.children && node.children.length > 0 && (
          <ul className="tree-group" role="group">
            {node.children.map((child) => (
              <TreeItem
                key={child.path}
                node={child}
                activePath={activePath}
                onSelect={onSelect}
                onDelete={onDelete}
                level={level + 1}
                expandedDirs={expandedDirs}
                onToggleDir={onToggleDir}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <FileItem
      node={node}
      isActive={isActive}
      indent={indent}
      onSelect={onSelect}
      onDelete={onDelete}
    />
  );
}

/** Auto-cancel window (ms) after which an armed delete reverts to idle. */
const CONFIRM_WINDOW = 1500;

/**
 * File row with an inline delete button using double-confirmation.
 *
 * Idle → click ✕ → armed (✓ visible) → click ✓ within `CONFIRM_WINDOW`
 * to delete, or wait to auto-cancel.
 */
function FileItem({
  node,
  isActive,
  indent,
  onSelect,
  onDelete,
}: {
  node: TreeNode;
  isActive: boolean;
  indent: number;
  onSelect: (path: string) => void;
  onDelete?: (path: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  function handleDeleteClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (confirming) {
      if (timerRef.current) clearTimeout(timerRef.current);
      setConfirming(false);
      onDelete?.(node.path);
      return;
    }
    setConfirming(true);
    timerRef.current = setTimeout(() => {
      setConfirming(false);
      timerRef.current = null;
    }, CONFIRM_WINDOW);
  }

  return (
    <li className="tree-node" role="none">
      <div
        className={`tree-row tree-row-file${isActive ? ' tree-row-active' : ''}`}
        style={{ paddingLeft: `${indent}px` }}
      >
        <button
          type="button"
          className="tree-row-main"
          onClick={() => onSelect(node.path)}
          title={node.concept?.title ?? node.name}
        >
          <span className="tree-icon" aria-hidden="true">
            {fileIcon(node)}
          </span>
          <span className="tree-label">{node.name}</span>
        </button>
        {onDelete && (
          <button
            type="button"
            className={`tree-delete-btn${confirming ? ' tree-delete-armed' : ''}`}
            onClick={handleDeleteClick}
            aria-label={confirming ? `Confirm delete ${node.name}` : `Delete ${node.name}`}
            title={confirming ? 'Click again to confirm' : 'Delete'}
          >
            {confirming ? '✓' : '✕'}
          </button>
        )}
      </div>
    </li>
  );
}

export function FileTree({ node, bundleId, activePath, onSelect, onDelete }: FileTreeProps) {
  const { expanded, toggle, reveal } = useTreeExpansion(bundleId);

  // When the active file changes (search result, chat link, deep link), expand
  // its ancestors so it is visible. Re-running only on activePath changes means
  // the user can still collapse a branch containing the active file afterwards.
  useEffect(() => {
    if (activePath) reveal(activePath);
  }, [activePath, reveal]);

  const children = node.children ?? [];
  return (
    <ul className="tree" role="tree">
      {children.map((child) => (
        <TreeItem
          key={child.path}
          node={child}
          activePath={activePath}
          onSelect={onSelect}
          onDelete={onDelete}
          level={0}
          expandedDirs={expanded}
          onToggleDir={toggle}
        />
      ))}
    </ul>
  );
}
