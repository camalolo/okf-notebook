import { useEffect, useRef, useState } from 'react';
import type { TreeNode } from '../types.ts';

interface FileTreeProps {
  node: TreeNode;
  activePath: string;
  onSelect: (path: string) => void;
  /** Called when the user confirms deletion of a file. */
  onDelete?: (path: string) => void;
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
  defaultExpanded: boolean;
}

function TreeItem({ node, activePath, onSelect, onDelete, level, defaultExpanded }: TreeItemProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const isDirectory = node.type === 'directory';
  const isActive = !isDirectory && node.path === activePath;
  const indent = level * 14 + 10;

  if (isDirectory) {
    return (
      <li className="tree-node" role="none">
        <button
          className="tree-row tree-row-dir"
          style={{ paddingLeft: `${indent}px` }}
          onClick={() => setExpanded((open) => !open)}
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
                defaultExpanded={false}
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

export function FileTree({ node, activePath, onSelect, onDelete }: FileTreeProps) {
  const children = node.children ?? [];
  return (
    <ul className="tree" role="tree">
      {children.map((child, index) => (
        <TreeItem
          key={child.path}
          node={child}
          activePath={activePath}
          onSelect={onSelect}
          onDelete={onDelete}
          level={0}
          defaultExpanded={index === 0}
        />
      ))}
    </ul>
  );
}
