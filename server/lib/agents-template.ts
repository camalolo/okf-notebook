/**
 * Starter AGENTS.md template, seeded into every newly registered bundle that
 * lacks one (see `seedAgentsMd()` in server/bundles.ts).
 *
 * Unlike OKF.md there is no canonical per-bundle content — each AGENTS.md is
 * hand-written domain guidance — so this is a *starter*: it interpolates the
 * bundle's registered name/description and leaves clearly-marked TODO
 * sections for the owner (or the chat agent itself) to fill in. The full OKF
 * spec is NOT restated here: the chat system prompt already embeds OKF.md
 * verbatim (see buildSystemPrompt in server/routes/chat.ts).
 */

/** Build the starter AGENTS.md content for a newly registered bundle. */
export function agentsTemplate(name: string, description = ''): string {
  const desc = description.trim();
  const intro = desc
    ? `An **Open Knowledge Format (OKF v0.1)** knowledge bundle — ${desc}.`
    : 'An **Open Knowledge Format (OKF v0.1)** knowledge bundle.';
  return `# AGENTS.md — ${name}

> **Starter template** — generated when this bundle was registered. This file
> is included in the system prompt of every chat, so what you write here
> shapes how the agent behaves. Fill in the TODO sections below, or simply
> ask the chat agent to draft them from the bundle's contents.

## What This Bundle Is

${intro}

TODO: Describe the domain this bundle covers and what the owner uses it for.

## Organization

TODO: List the key files and directories and what each contains, e.g.:

| Path | Contents |
|------|----------|
| \`index.md\` | Bundle root index — progressive disclosure entry point. |
| \`log.md\` | Chronological update history (newest first). |
| TODO | … |

## OKF Conventions

- Every concept document (any \`.md\` except \`index.md\`/\`log.md\`) carries YAML
  frontmatter with a required \`type\` field; \`title\` and \`description\` are
  recommended. The full spec is in [OKF.md](OKF.md).
- Cross-link concepts with bundle-relative absolute links:
  \`[title](/dir/file.md)\`.
- When adding or updating content: add a dated entry to \`log.md\` (newest
  first), update the relevant \`index.md\`, and refresh the frontmatter
  \`timestamp\`.

## Domain Context for Agents

TODO: Facts the agent needs but cannot infer from the files — conventions,
units, currencies, language, external systems (calendars, accounts), and how
severity/urgency is classified in this domain.

## Working With This Bundle

- This is a pure markdown knowledge base — no build system, tests, or
  dependencies.
- Prefer editing existing concept documents over creating new ones.
- When unsure about format, consult [OKF.md](OKF.md).
- TODO: Behavioral expectations — what to do proactively, what to always
  verify before claiming success, what never to do.
`;
}
