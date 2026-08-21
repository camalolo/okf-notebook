import { describe, it, expect } from 'vitest';
import { lintOkfFiles, formatOkfReport } from './okf-lint.js';

const CONFORMANT = [
  '---',
  'type: Reference',
  'title: Warranty',
  'description: Car warranty terms.',
  '---',
  '',
  'Details here.',
].join('\n');

function rules(files: { path: string; content: string }[], path: string) {
  const report = lintOkfFiles(files);
  return report.violations.filter((v) => v.path === path).map((v) => v.rule);
}

describe('lintOkfFiles', () => {
  it('passes a conformant concept file', () => {
    const report = lintOkfFiles([{ path: 'cars/warranty.md', content: CONFORMANT }]);
    expect(report).toEqual({ filesChecked: 1, violations: [], duplicates: [] });
  });

  it('skips reserved filenames (index.md / log.md)', () => {
    const report = lintOkfFiles([
      { path: 'index.md', content: '# Listing\n' },
      { path: 'log.md', content: '# Log\n' },
      { path: 'sub/index.md', content: '# Sub listing\n' },
    ]);
    expect(report.filesChecked).toBe(0);
    expect(report.violations).toEqual([]);
  });

  it('flags a file without frontmatter', () => {
    const r = rules([{ path: 'a.md', content: 'just prose, no frontmatter' }], 'a.md');
    expect(r).toContain('no_frontmatter');
    expect(r).toContain('missing_type');
    expect(r).toContain('missing_title');
    expect(r).toContain('missing_description');
  });

  it('flags unparseable frontmatter yaml', () => {
    const bad = ['---', 'type: [unclosed', '---', '', 'body'].join('\n');
    const r = rules([{ path: 'bad.md', content: bad }], 'bad.md');
    expect(r).toContain('invalid_frontmatter');
    expect(r).toContain('missing_type');
  });

  it('flags an empty or non-string type', () => {
    const emptyType = ['---', 'title: X', 'description: d', 'type: ""', '---', '', 'b'].join('\n');
    expect(rules([{ path: 'e.md', content: emptyType }], 'e.md')).toContain('empty_type');

    const numType = ['---', 'type: 42', 'title: X', 'description: d', '---', '', 'b'].join('\n');
    expect(rules([{ path: 'n.md', content: numType }], 'n.md')).toContain('empty_type');
  });

  it('flags an empty body as a deletion candidate', () => {
    const stub = ['---', 'type: Note', 'title: T', 'description: d', '---', ''].join('\n');
    expect(rules([{ path: 'stub.md', content: stub }], 'stub.md')).toContain('empty_body');
  });

  it('groups duplicate normalized titles', () => {
    const b = (title: string) =>
      ['---', 'type: Note', `title: ${title}`, 'description: d', '---', '', 'b'].join('\n');
    const report = lintOkfFiles([
      { path: 'x/a.md', content: b('Car  Service') },
      { path: 'y/b.md', content: b('car service') },
    ]);
    expect(report.duplicates).toEqual([{ title: 'car service', paths: ['x/a.md', 'y/b.md'] }]);
  });
});

describe('formatOkfReport', () => {
  it('renders a clean report explicitly', () => {
    const out = formatOkfReport({ filesChecked: 3, violations: [], duplicates: [] });
    expect(out).toContain('all 3 concept files pass');
  });

  it('groups violations by path and lists duplicate groups', () => {
    const out = formatOkfReport({
      filesChecked: 2,
      violations: [
        { path: 'b.md', rule: 'missing_type', message: 'required `type` field is missing' },
        { path: 'a.md', rule: 'missing_title', message: 'recommended `title` field is missing' },
        { path: 'b.md', rule: 'empty_body', message: 'empty body — candidate for deletion or merge' },
      ],
      duplicates: [{ title: 'warranty', paths: ['a.md', 'b.md'] }],
    });
    expect(out).toContain('a.md:');
    expect(out).toContain('b.md:');
    expect(out.indexOf('a.md:')).toBeLessThan(out.indexOf('b.md:')); // sorted
    expect(out).toContain('duplicate title "warranty" in: a.md, b.md');
  });
});
