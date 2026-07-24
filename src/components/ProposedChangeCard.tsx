import { useState } from 'react';
import type { ProposedChange } from '../types.ts';

interface ProposedChangeCardProps {
  change: ProposedChange;
  /** Apply the change on the backend. Resolves on success, rejects on error. */
  onAccept: (id: string) => Promise<void>;
  /** Mark the change as rejected (no backend call). */
  onReject: (id: string) => void;
}

// --- Minimal line-level diff (LCS) -----------------------------------------

interface DiffLine {
  type: 'added' | 'removed' | 'context';
  text: string;
}

/**
 * Compute a line-level diff using the classic LCS dynamic-programming
 * approach. Returns an array of context / added / removed lines.
 */
function lineDiff(oldText: string, newText: string, context = 3): DiffLine[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');

  // Build LCS table.
  const m = a.length;
  const n = b.length;
  // Use Uint32Array for performance on large inputs.
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= m; i++) dp.push(new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // Walk the table to produce raw diff lines.
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

  // Collapse consecutive context runs, keeping only `context` lines around
  // change boundaries.
  const result: DiffLine[] = [];
  let contextRun = 0;
  for (let k = 0; k < raw.length; k++) {
    if (raw[k].type === 'context') {
      contextRun++;
    } else {
      // We hit a change. Backfill context lines if we had skipped some.
      if (contextRun > context * 2) {
        // Keep the last `context` lines from the run.
        const start = k - context;
        for (let c = Math.max(0, k - contextRun); c < start; c++) {
          if (raw[c].type === 'context') {
            result.push({ type: 'context', text: '⋯' });
            break;
          }
        }
        for (let c = start; c < k; c++) result.push(raw[c]);
      } else {
        // Keep all context lines in this short run.
        for (let c = k - contextRun; c < k; c++) {
          if (raw[c].type === 'context') result.push(raw[c]);
        }
      }
      contextRun = 0;
      result.push(raw[k]);
    }
  }
  // Trailing context.
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

// --- Component --------------------------------------------------------------

/** Cap the number of diff lines rendered to keep the DOM light. */
const MAX_DIFF_LINES = 300;

export function ProposedChangeCard({ change, onAccept, onReject }: ProposedChangeCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCreate = change.type === 'create';
  const oldText = change.oldContent ?? '';
  const newText = change.newContent ?? '';

  const diffLines = isCreate
    ? newText.split('\n').map((text) => ({ type: 'added' as const, text }))
    : lineDiff(oldText, newText);

  const shown = diffLines.slice(0, MAX_DIFF_LINES);
  const truncated = diffLines.length > MAX_DIFF_LINES;

  // Count changes for the summary.
  const added = diffLines.filter((l) => l.type === 'added').length;
  const removed = diffLines.filter((l) => l.type === 'removed').length;

  const handleAccept = async () => {
    setBusy(true);
    setError(null);
    try {
      await onAccept(change.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply change');
    } finally {
      setBusy(false);
    }
  };

  const handleReject = () => {
    onReject(change.id);
  };

  const resolved = change.status === 'applied' || change.status === 'rejected';

  return (
    <div className={`proposed-change proposed-change-${change.status}`}>
      <div className="pc-header">
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
        {resolved && (
          <span
            className={`pc-status pc-status-${change.status}`}
            title={change.status === 'applied' ? 'Applied' : 'Rejected'}
          >
            {change.status === 'applied' ? '✓ Applied' : 'Rejected'}
          </span>
        )}
      </div>

      {!resolved && shown.length > 0 && (
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

      {error && <div className="pc-error">{error}</div>}

      {!resolved && (
        <div className="pc-actions">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={handleAccept}
            disabled={busy}
          >
            {busy ? 'Applying…' : '✓ Accept'}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={handleReject}
            disabled={busy}
          >
            Reject
          </button>
        </div>
      )}
    </div>
  );
}
