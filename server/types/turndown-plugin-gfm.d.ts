/**
 * Minimal type declarations for turndown-plugin-gfm (no @types package exists).
 * Each export is a Turndown plugin: a function that registers rules on a
 * TurndownService instance (passed via `service.use(...)`).
 */
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';

  type GfmPlugin = (service: TurndownService) => void;

  /** All GFM plugins (tables, strikethrough, taskListItems). */
  export const gfm: GfmPlugin;
  export const tables: GfmPlugin;
  export const strikethrough: GfmPlugin;
  export const taskListItems: GfmPlugin;
  export const highlightedCodeBlock: GfmPlugin;
}
