// routes/listings.js — Trip Partner & Meetup REST endpoints
'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const { TripPartner, Meetup, Room } = require('../src/models');
const { validateTripPartner, validateMeetup, validateUID } = require('../middleware/sanitize');

const router = express.Router();

const LISTING_LIMIT = parseInt(process.env.LISTING_QUERY_LIMIT) || 30;

// Per-route rate limiter for create endpoints (stricter)
const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 10,                     // max 10 listings per IP per hour
  message: { error: 'Too many listings created. Try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false
});

// ── GET /api/listings/partners ───────────────────────────────────
router.get('/partners', async (req, res) => {
  try {
    const docs = await TripPartner
      .find({})
      .sort({ createdAt: -1 })
      .limit(LISTING_LIMIT)
      .select('-phone -uid')  // never expose phone/uid to listing view
      .lean();
    return res.json({ ok: true, data: docs });
  } catch (e) {
    console.error('[GET /partners]', e.message);
    return res.status(500).json({ ok: false, error: 'Could not fetch listings.' });
  }
});

// ── GET /api/listings/meetups ────────────────────────────────────
router.get('/meetups', async (req, res) => {
  try {
    const docs = await Meetup
      .find({})
      .sort({ createdAt: -1 })
      .limit(LISTING_LIMIT)
      .select('-phone -uid')
      .lean();
    return res.json({ ok: true, data: docs });
  } catch (e) {
    console.error('[GET /meetups]', e.message);
    return res.status(500).json({ ok: false, error: 'Could not fetch meetups.' });
  }
});

// ── POST /api/listings/partners ──────────────────────────────────
router.post('/partners', createLimiter, async (req, res) => {
  const errors = validateTripPartner(req.body);
  if (errors.length) return res.status(400).json({ ok: false, errors });

  const { uid } = req.body;
  if (!validateUID(uid)) return res.status(400).json({ ok: false, errors: ['Invalid session UID.'] });

  try {
    const doc = await TripPartner.create({
      name:  req.body.name,
      phone: req.body.phone || '',
      from:  req.body.from,
      dest:  req.body.dest,
      date:  req.body.date,
      seats: parseInt(req.body.seats),
      desc:  req.body.desc || '',
      emoji: '🧭',
      uid
    });

    // Create a Room record so chat knows the title
    await Room.findByIdAndUpdate(
      doc._id.toString(),
      { _id: doc._id.toString(), name: doc.name, type: 'partner' },
      { upsert: true }
    );

    return res.status(201).json({ ok: true, id: doc._id.toString() });
  } catch (e) {
    console.error('[POST /partners]', e.message);
    return res.status(500).json({ ok: false, error: 'Failed to create listing.' });
  }
});

// ── POST /api/listings/meetups ───────────────────────────────────
router.post('/meetups', createLimiter, async (req, res) => {
  const errors = validateMeetup(req.body);
  if (errors.length) return res.status(400).json({ ok: false, errors });

  const { uid } = req.body;
  if (!validateUID(uid)) return res.status(400).json({ ok: false, errors: ['Invalid session UID.'] });

  try {
    const doc = await Meetup.create({
      name:    req.body.name,
      mname:   req.body.mname,
      place:   req.body.place,
      date:    req.body.date,
      max:     parseInt(req.body.max),
      members: 1,
      type:    req.body.type || 'General',
      desc:    req.body.desc || '',
      emoji:   '🎯',
      uid
    });

    await Room.findByIdAndUpdate(
      doc._id.toString(),
      { _id: doc._id.toString(), name: doc.mname, type: 'meetup' },
      { upsert: true }
    );

    return res.status(201).json({ ok: true, id: doc._id.toString() });
  } catch (e) {
    console.error('[POST /meetups]', e.message);
    return res.status(500).json({ ok: false, error: 'Failed to create meetup.' });
  }
});

module.exports = router;
