// routes/listings.js — Trip Partner & Meetup REST endpoints
'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const { TripPartner, Meetup, Room, ChatMessage } = require('../src/models');
const { validateTripPartner, validateMeetup, validateUID } = require('../middleware/sanitize');

const router = express.Router();
const LISTING_LIMIT = parseInt(process.env.LISTING_QUERY_LIMIT) || 30;

const createLimiter = rateLimit({ windowMs: 60*60*1000, max: 10, message: { error: 'Too many listings created.' }, standardHeaders: true, legacyHeaders: false });
const deleteLimiter = rateLimit({ windowMs: 15*60*1000, max: 20, message: { error: 'Too many delete requests.' }, standardHeaders: true, legacyHeaders: false });

// GET /api/listings/partners — uid included so frontend can detect owner
router.get('/partners', async (req, res) => {
  try {
    const docs = await TripPartner.find({}).sort({ createdAt: -1 }).limit(LISTING_LIMIT).select('-phone').lean();
    return res.json({ ok: true, data: docs });
  } catch (e) { return res.status(500).json({ ok: false, error: 'Could not fetch listings.' }); }
});

// GET /api/listings/meetups
router.get('/meetups', async (req, res) => {
  try {
    const docs = await Meetup.find({}).sort({ createdAt: -1 }).limit(LISTING_LIMIT).select('-phone').lean();
    return res.json({ ok: true, data: docs });
  } catch (e) { return res.status(500).json({ ok: false, error: 'Could not fetch meetups.' }); }
});

// POST /api/listings/partners
router.post('/partners', createLimiter, async (req, res) => {
  const errors = validateTripPartner(req.body);
  if (errors.length) return res.status(400).json({ ok: false, errors });
  const { uid } = req.body;
  if (!validateUID(uid)) return res.status(400).json({ ok: false, errors: ['Invalid session UID.'] });
  try {
    console.log('[POST /partners] received:', JSON.stringify({ mode: req.body.mode, budget: req.body.budget, gender: req.body.gender, age: req.body.age }));
    const doc = await TripPartner.create({ name: req.body.name, phone: req.body.phone||'', from: req.body.from, dest: req.body.dest, date: req.body.date, seats: parseInt(req.body.seats), mode: req.body.mode||'Any', budget: req.body.budget||'', gender: req.body.gender||'Any', age: req.body.age||'', desc: req.body.desc||'', emoji: '🧭', uid });
    await Room.findByIdAndUpdate(doc._id.toString(), { _id: doc._id.toString(), name: doc.name, type: 'partner' }, { upsert: true });
    return res.status(201).json({ ok: true, id: doc._id.toString() });
  } catch (e) { console.error('[POST /partners]', e.message); return res.status(500).json({ ok: false, error: 'Failed to create listing.' }); }
});

// POST /api/listings/meetups
router.post('/meetups', createLimiter, async (req, res) => {
  const errors = validateMeetup(req.body);
  if (errors.length) return res.status(400).json({ ok: false, errors });
  const { uid } = req.body;
  if (!validateUID(uid)) return res.status(400).json({ ok: false, errors: ['Invalid session UID.'] });
  try {
    const doc = await Meetup.create({
      name:      req.body.name,
      phone:     req.body.phone     || '',
      mname:     req.body.mname,
      place:     req.body.place,
      date:      req.body.date,
      max:       parseInt(req.body.max),
      members:   1,
      type:      req.body.type      || 'General',
      meetpoint: req.body.meetpoint || '',
      cost:      req.body.cost      || '',
      agegroup:  req.body.agegroup  || '',
      lang:      req.body.lang      || '',
      desc:      req.body.desc      || '',
      emoji:     '🎯',
      uid
    });
    await Room.findByIdAndUpdate(doc._id.toString(), { _id: doc._id.toString(), name: doc.mname, type: 'meetup' }, { upsert: true });
    return res.status(201).json({ ok: true, id: doc._id.toString() });
  } catch (e) { console.error('[POST /meetups]', e.message); return res.status(500).json({ ok: false, error: 'Failed to create meetup.' }); }
});

// DELETE /api/listings/partners/:id — only creator can delete
router.delete('/partners/:id', deleteLimiter, async (req, res) => {
  const { id } = req.params;
  const { uid } = req.body;
  if (!id || !/^[a-f0-9]{24}$/.test(id)) return res.status(400).json({ ok: false, error: 'Invalid listing ID.' });
  if (!validateUID(uid)) return res.status(400).json({ ok: false, error: 'Invalid UID.' });
  try {
    const doc = await TripPartner.findById(id).lean();
    if (!doc)            return res.status(404).json({ ok: false, error: 'Listing not found.' });
    if (doc.uid !== uid) return res.status(403).json({ ok: false, error: 'Not authorised.' });
    await TripPartner.deleteOne({ _id: id });
    await Room.deleteOne({ _id: id });
    await ChatMessage.deleteMany({ roomId: id });
    return res.json({ ok: true });
  } catch (e) { console.error('[DELETE /partners/:id]', e.message); return res.status(500).json({ ok: false, error: 'Failed to delete.' }); }
});

// DELETE /api/listings/meetups/:id — only creator can delete
router.delete('/meetups/:id', deleteLimiter, async (req, res) => {
  const { id } = req.params;
  const { uid } = req.body;
  if (!id || !/^[a-f0-9]{24}$/.test(id)) return res.status(400).json({ ok: false, error: 'Invalid listing ID.' });
  if (!validateUID(uid)) return res.status(400).json({ ok: false, error: 'Invalid UID.' });
  try {
    const doc = await Meetup.findById(id).lean();
    if (!doc)            return res.status(404).json({ ok: false, error: 'Listing not found.' });
    if (doc.uid !== uid) return res.status(403).json({ ok: false, error: 'Not authorised.' });
    await Meetup.deleteOne({ _id: id });
    await Room.deleteOne({ _id: id });
    await ChatMessage.deleteMany({ roomId: id });
    return res.json({ ok: true });
  } catch (e) { console.error('[DELETE /meetups/:id]', e.message); return res.status(500).json({ ok: false, error: 'Failed to delete.' }); }
});

module.exports = router;
