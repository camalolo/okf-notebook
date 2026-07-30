import { Router } from 'express';
import {
  listChats,
  loadChat,
  createChat,
  saveChat,
  deleteChat,
} from '../chats.js';
import type { StoredEvent } from '../chats.js';

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
