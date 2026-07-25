import { useState } from 'react';
import type { ProposedChange } from '../types.ts';

interface ProposedChangeCardProps {
  change: ProposedChange;
}

// --- Minimal line-level diff (LCS) -----------------------------------------

interface DiffLine {
  type: 'added' | 'removed' | 'context';
  text: string;
}

function lineDiff(oldText: string, newText: string, context = 3): DiffLine[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const m = a.length;
  const n = b.length;
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= m; i++) dp.push(new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const raw: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      raw.push({ type: 'context', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw.push({ type: 'removed', text: a[i] });
      i++;
    } else {
      raw.push({ type: 'added', text: b[j] });
      j++;
    }
  }
  while (i < m) raw.push({ type: 'removed', text: a[i++] });
  while (j < n) raw.push({ type: 'added', text: b[j++] });
  const result: DiffLine[] = [];
  let contextRun = 0;
  for (let k = 0; k < raw.length; k++) {
    if (raw[k].type === 'context') {
      contextRun++;
    } else {
      if (contextRun > context * 2) {
        const start = k - context;
        for (let c = Math.max(0, k - contextRun); c < start; c++) {
          if (raw[c].type === 'context') {
            result.push({ type: 'context', text: '⋯' });
            break;
          }
        }
        for (let c = start; c < k; c++) result.push(raw[c]);
      } else {
        for (let c = k - contextRun; c < k; c++) {
          if (raw[c].type === 'context') result.push(raw[c]);
        }
      }
      contextRun = 0;
      result.push(raw[k]);
    }
  }
  if (contextRun > context) {
    for (let c = raw.length - contextRun; c < raw.length - context + contextRun; c++) {
      if (c >= 0 && c < raw.length && raw[c].type === 'context') {
        if (c === raw.length - contextRun) result.push({ type: 'context', text: '⋯' });
        if (c >= raw.length - context) result.push(raw[c]);
      }
    }
  } else {
    for (let c = raw.length - contextRun; c < raw.length; c++) {
      if (c >= 0 && raw[c].type === 'context') result.push(raw[c]);
    }
  }
  return result;
}

const MAX_DIFF_LINES = 300;

export function ProposedChangeCard({ change }: ProposedChangeCardProps) {
  const [expanded, setExpanded] = useState(false);

  const isCreate = change.type === 'create';
  const oldText = change.oldContent ?? '';
  const newText = change.newContent ?? '';

  const diffLines = isCreate
    ? newText.split('\n').map((text) => ({ type: 'added' as const, text }))
    : lineDiff(oldText, newText);

  const shown = diffLines.slice(0, MAX_DIFF_LINES);
  const truncated = diffLines.length > MAX_DIFF_LINES;

  const added = diffLines.filter((l) => l.type === 'added').length;
  const removed = diffLines.filter((l) => l.type === 'removed').length;

  return (
    <div className="proposed-change proposed-change-applied">
      <div
        role="button"
        tabIndex={0}
        className="pc-header pc-header-toggle"
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded((v) => !v); } }}
        aria-expanded={expanded}
      >
        <span className="pc-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span className={`pc-badge pc-badge-${change.type}`}>
          {isCreate ? '✨ Create' : '✏️ Edit'}
        </span>
        <code className="pc-path">{change.path}</code>
        {!isCreate && (
          <span className="pc-summary">
            <span className="pc-stat pc-stat-added">+{added}</span>
            <span className="pc-stat pc-stat-removed">−{removed}</span>
          </span>
        )}
        <span className="pc-status pc-status-applied">✓ Applied</span>
      </div>

      {expanded && shown.length > 0 && (
        <div className="pc-diff" role="region" aria-label={`Diff for ${change.path}`}>
          {shown.map((line, idx) => (
            <div className={`diff-line diff-${line.type}`} key={idx}>
              <span className="diff-sign">
                {line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '}
              </span>
              <span className="diff-text">{line.text || ' '}</span>
            </div>
          ))}
          {truncated && <div className="diff-truncated">⋯ {diffLines.length - MAX_DIFF_LINES} more lines</div>}
        </div>
      )}
    </div>
  );
}
