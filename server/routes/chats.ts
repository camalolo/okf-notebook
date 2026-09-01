import { Router } from 'express';
import {
  UNDO_ERRORS,
  listChats,
  loadChat,
  createChat,
  saveChat,
  deleteChat,
  undoLastTurn,
} from '../chats.js';
import type { StoredEvent } from '../chats.js';
import { hasActiveTurn, turnKey } from '../lib/turn-stream.js';

const router = Router();

/** GET /:bundleId — list chat summaries for a bundle. */
router.get('/:bundleId', async (req, res, next) => {
  try {
    const summaries = await listChats(req.params.bundleId, req.user!.email);
    res.json(summaries);
  } catch (err) {
    next(err);
  }
});

/** POST /:bundleId — create a new chat session. */
router.post('/:bundleId', async (req, res, next) => {
  try {
    const chat = await createChat(req.params.bundleId, req.user!.email);
    res.status(201).json(chat);
  } catch (err) {
    next(err);
  }
});

/** GET /:bundleId/:chatId — load a full chat session. */
router.get('/:bundleId/:chatId', async (req, res, next) => {
  try {
    const chat = await loadChat(req.params.bundleId, req.params.chatId, req.user!.email);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    res.json(chat);
  } catch (err) {
    next(err);
  }
});

/** PUT /:bundleId/:chatId — save (replace) a chat session's data. */
router.put('/:bundleId/:chatId', async (req, res, next) => {
  try {
    const { title, events } = req.body ?? {};
    if (!Array.isArray(events)) {
      return res.status(400).json({ error: 'events (array) is required' });
    }
    const chat = await saveChat(
      req.params.bundleId,
      req.params.chatId,
      req.user!.email,
      {
        title: typeof title === 'string' ? title : undefined,
        events: events as StoredEvent[],
      },
    );
    res.json(chat);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /:bundleId/:chatId/undo-turn — delete the last user turn (the user
 * message + its assistant reply, tool calls, and recorded edits) from the
 * timeline. Refused with 409 while a turn is still running: the in-memory
 * registry catches turns that haven't persisted a user event yet, and
 * `undoLastTurn` itself re-checks the persisted timeline's termination —
 * truncating under a live loop would strand its subsequent appends.
 * File edits already applied to the bundle are NOT reverted.
 */
router.post('/:bundleId/:chatId/undo-turn', async (req, res, next) => {
  try {
    const bundleId = req.params.bundleId as string;
    const chatId = req.params.chatId as string;
    if (hasActiveTurn(turnKey(bundleId, chatId))) {
      return res.status(409).json({ error: UNDO_ERRORS.running });
    }
    const chat = await undoLastTurn(bundleId, chatId, req.user!.email);
    res.json(chat);
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg === UNDO_ERRORS.notFound) return res.status(404).json({ error: msg });
    if (msg === UNDO_ERRORS.nothingToUndo || msg === UNDO_ERRORS.running) {
      return res.status(409).json({ error: msg });
    }
    next(err);
  }
});

/** DELETE /:bundleId/:chatId — delete a chat session. */
router.delete('/:bundleId/:chatId', async (req, res, next) => {
  try {
    await deleteChat(req.params.bundleId, req.params.chatId, req.user!.email);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
