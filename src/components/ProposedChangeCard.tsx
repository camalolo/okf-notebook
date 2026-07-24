import { useState } from 'react';
import type { ProposedChange } from '../types.ts';

interface ProposedChangeCardProps {
  change: ProposedChange;
  /** Apply the change on the backend. Resolves on success, rejects on error. */
  onAccept: (id: string) => Promise<void>;
  /** Mark the change as rejected (no backend call). */
  onReject: (id: string) => void;
}

/** Cap the number of diff lines rendered to keep the DOM light. */
const MAX_DIFF_LINES = 200;

export function ProposedChangeCard({ change, onAccept, onReject }: ProposedChangeCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCreate = change.type === 'create';
  const oldLines = (change.oldContent ?? '').split('\n');
  const newLines = change.newContent.split('\n');

  const shownOld = oldLines.slice(0, MAX_DIFF_LINES);
  const shownNew = newLines.slice(0, MAX_DIFF_LINES);
  const truncated = oldLines.length + newLines.length > MAX_DIFF_LINES * 2;

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
        {resolved && (
          <span
            className={`pc-status pc-status-${change.status}`}
            title={change.status === 'applied' ? 'Applied' : 'Rejected'}
          >
            {change.status === 'applied' ? '✓ Applied' : 'Rejected'}
          </span>
        )}
      </div>

      {!resolved && (
        <div className="pc-diff" role="region" aria-label={`Diff for ${change.path}`}>
          {!isCreate &&
            shownOld.map((line, i) => (
              <div className="diff-line diff-removed" key={`o${i}`}>
                <span className="diff-sign">-</span>
                <span className="diff-text">{line}</span>
              </div>
            ))}
          {shownNew.map((line, i) => (
            <div className="diff-line diff-added" key={`n${i}`}>
              <span className="diff-sign">+</span>
              <span className="diff-text">{line}</span>
            </div>
          ))}
          {truncated && <div className="diff-truncated">… diff truncated</div>}
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
