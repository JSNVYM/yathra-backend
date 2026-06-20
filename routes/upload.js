// routes/upload.js — Secure listing submission via Apps Script proxy
// No googleapis needed — avoids Render free tier egress restrictions
'use strict';
const express  = require('express');
const rateLimit = require('express-rate-limit');
const xss      = require('xss');

const router = express.Router();

// ── Rate limiter: max 5 per IP per hour ──────────────────────────
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many submissions. Please try again in an hour.' }
});

// ── Sanitize helper ──────────────────────────────────────────────
function clean(val, max) {
  if (!val || typeof val !== 'string') return '';
  return xss(val.trim(), { whiteList: {}, stripIgnoreTag: true }).substring(0, max);
}

// ── POST /api/upload/submit ──────────────────────────────────────
router.post('/submit', uploadLimiter, async (req, res) => {
  try {
    const body = req.body || {};

    // ── Sanitize ─────────────────────────────────────────────────
    const category = clean(body.category, 40);
    const name     = clean(body.name,     60);
    const business = clean(body.business, 80);
    const location = clean(body.location, 80);
    const maplink  = clean(body.maplink,  500);
    const phone    = clean(body.phone,    20);
    const email    = clean(body.email,    80);
    const desc     = clean(body.desc,     400);

    // ── Validate ─────────────────────────────────────────────────
    const errors = [];
    if (!category)                                           errors.push('Category is required.');
    if (!name || name.length < 2)                            errors.push('Name is required.');
    if (!location || location.length < 2)                    errors.push('Location is required.');
    if (!phone || !/^\+?[\d\s\-]{7,20}$/.test(phone))       errors.push('Valid WhatsApp number required.');
    if (!desc || desc.length < 10)                           errors.push('Description required (min 10 chars).');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Invalid email format.');
    if (maplink && !maplink.startsWith('https://'))          errors.push('Map link must start with https://');
    if (errors.length) return res.status(400).json({ ok: false, errors });

    // ── Validate images ──────────────────────────────────────────
    const rawImages = Array.isArray(body.images) ? body.images.slice(0, 3) : [];
    const ALLOWED   = ['image/jpeg','image/jpg','image/png','image/webp','image/heic'];
    const MAX_BYTES = 5 * 1024 * 1024;

    for (const img of rawImages) {
      if (!img || !img.data || !img.type) continue;
      if (!ALLOWED.includes(img.type.toLowerCase()))
        return res.status(400).json({ ok: false, error: 'Only JPEG, PNG, WebP images allowed.' });
      if (Buffer.from(img.data, 'base64').length > MAX_BYTES)
        return res.status(400).json({ ok: false, error: 'Each image must be under 5MB.' });
    }

    // ── Check env vars ───────────────────────────────────────────
    const scriptUrl = process.env.APPS_SCRIPT_URL;
    const sheetId   = process.env.GOOGLE_SHEET_ID;
    const folderId  = process.env.GOOGLE_DRIVE_FOLDER_ID;

    if (!scriptUrl || !sheetId || !folderId) {
      console.error('[upload] Missing env vars: APPS_SCRIPT_URL, GOOGLE_SHEET_ID, or GOOGLE_DRIVE_FOLDER_ID');
      return res.status(500).json({ ok: false, error: 'Server configuration error.' });
    }

    // ── Forward to Apps Script ───────────────────────────────────
    const payload = {
      sheetId, folderId,
      secret:   process.env.UPLOAD_SECRET || '',
      category, name,
      business: business || category,
      location, maplink: maplink || '',
      phone, email: email || '',
      desc,
      images: rawImages,
      ts: new Date().toISOString()
    };

    const scriptRes = await fetch(scriptUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain' }, // text/plain avoids CORS preflight on Apps Script
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(30000) // 30 second timeout
    });

    const result = await scriptRes.json();

    if (!result.ok) {
      console.error('[upload] Apps Script error:', result.error);
      return res.status(500).json({ ok: false, error: 'Submission failed. Please try again.' });
    }

    console.log(`[upload/submit] ✅ ${category} — ${name} (${location})`);
    return res.status(201).json({ ok: true });

  } catch (e) {
    console.error('[upload/submit error]', e.message);
    return res.status(500).json({ ok: false, error: 'Submission failed. Please try again.' });
  }
});

module.exports = router;
