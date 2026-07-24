import { useState } from 'react';
import type { TreeNode } from '../types.ts';

interface FileTreeProps {
  node: TreeNode;
  activePath: string;
  onSelect: (path: string) => void;
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
  level: number;
  defaultExpanded: boolean;
}

function TreeItem({ node, activePath, onSelect, level, defaultExpanded }: TreeItemProps) {
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
    <li className="tree-node" role="none">
      <button
        className={`tree-row tree-row-file${isActive ? ' tree-row-active' : ''}`}
        style={{ paddingLeft: `${indent}px` }}
        onClick={() => onSelect(node.path)}
        title={node.concept?.title ?? node.name}
      >
        <span className="tree-icon" aria-hidden="true">
          {fileIcon(node)}
        </span>
        <span className="tree-label">{node.name}</span>
      </button>
    </li>
  );
}

export function FileTree({ node, activePath, onSelect }: FileTreeProps) {
  const children = node.children ?? [];
  return (
    <ul className="tree" role="tree">
      {children.map((child, index) => (
        <TreeItem
          key={child.path}
          node={child}
          activePath={activePath}
          onSelect={onSelect}
          level={0}
          defaultExpanded={index === 0}
        />
      ))}
    </ul>
  );
}
