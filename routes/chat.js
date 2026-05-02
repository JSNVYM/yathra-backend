// routes/chat.js — Chat history REST endpoint (WebSocket handled in server.js)
'use strict';
const express = require('express');
const { ChatMessage, Room } = require('../src/models');

const router = express.Router();

const MSG_LIMIT = parseInt(process.env.CHAT_MESSAGE_LIMIT) || 200;

// ── GET /api/chat/:roomId/messages ───────────────────────────────
// Returns the last N messages for a room (chronological order)
router.get('/:roomId/messages', async (req, res) => {
  const { roomId } = req.params;
  if (!roomId || !/^[a-f0-9]{24}$/.test(roomId)) {
    return res.status(400).json({ ok: false, error: 'Invalid room ID.' });
  }

  try {
    // Verify room exists
    const room = await Room.findById(roomId).lean();
    if (!room) return res.status(404).json({ ok: false, error: 'Room not found.' });

    const msgs = await ChatMessage
      .find({ roomId })
      .sort({ ts: -1 })
      .limit(MSG_LIMIT)
      .select('-__v')
      .lean();

    // Return in chronological order
    msgs.reverse();

    return res.json({ ok: true, data: msgs, roomName: room.name });
  } catch (e) {
    console.error('[GET /chat/:roomId/messages]', e.message);
    return res.status(500).json({ ok: false, error: 'Could not load messages.' });
  }
});

module.exports = router;
