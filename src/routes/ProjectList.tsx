import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BundleConfig, User } from '../types.ts';
import { getBundles } from '../services/api.ts';

interface ProjectListProps {
  user: User;
}

export function ProjectList({ user }: ProjectListProps) {
  const [bundles, setBundles] = useState<BundleConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
        if (active) {
          setError(err instanceof Error ? err.message : 'Failed to load bundles');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="page page-scroll">
      <div className="page-header">
        <h1>Knowledge Bundles</h1>
        <p>Select a bundle to browse its documents.</p>
      </div>

      {loading && (
        <div className="centered-spinner">
          <div className="spinner" />
        </div>
      )}

      {error && !loading && <div className="error-banner">{error}</div>}

      {!loading && !error && bundles.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon">📦</div>
          <h2>No bundles yet</h2>
          <p>
            {user.role === 'full'
              ? 'Add a bundle directory from Settings to get started.'
              : 'Ask an administrator to register a bundle.'}
          </p>
        </div>
      )}

      {!loading && !error && bundles.length > 0 && (
        <div className="card-grid">
          {bundles.map((bundle) => (
            <Link key={bundle.id} to={`/bundle/${bundle.id}`} className="bundle-card">
              <span className="bundle-card-icon" aria-hidden="true">
                {bundle.icon || '📚'}
              </span>
              <span className="bundle-card-name">{bundle.name}</span>
              {bundle.description && (
                <span className="bundle-card-desc">{bundle.description}</span>
              )}
            </Link>
          ))}
          {user.role === 'full' && (
            <Link to="/settings" className="bundle-card bundle-card-add">
              <span className="bundle-card-icon" aria-hidden="true">＋</span>
              <span className="bundle-card-name">Add Bundle</span>
              <span className="bundle-card-desc">Register a new directory</span>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
