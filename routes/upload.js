// routes/upload.js — Secure listing submission to Google Sheets + Drive
'use strict';
const express      = require('express');
const rateLimit    = require('express-rate-limit');
const xss          = require('xss');
const { Readable } = require('stream');

const router = express.Router();

// ── Rate limiter ─────────────────────────────────────────────────
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many submissions. Please try again in an hour.' }
});

// ── Cached auth client — reuse across requests to avoid repeated token fetches ──
let _cachedAuth = null;

function getAuth() {
  const { google } = require('googleapis');

  if (_cachedAuth) return _cachedAuth;

  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const projectId   = process.env.GOOGLE_PROJECT_ID;

  // Handle both escaped \n (from Render) and real newlines
  let privateKey = process.env.GOOGLE_PRIVATE_KEY || '';
  if (!privateKey.includes('\n')) {
    privateKey = privateKey.replace(/\\n/g, '\n');
  }

  if (!clientEmail || !privateKey) {
    throw new Error('Missing GOOGLE_CLIENT_EMAIL or GOOGLE_PRIVATE_KEY');
  }

  _cachedAuth = new google.auth.GoogleAuth({
    credentials: {
      type:         'service_account',
      project_id:   projectId   || '',
      client_email: clientEmail,
      private_key:  privateKey
    },
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.file'
    ]
  });

  return _cachedAuth;
}

// ── Retry helper — retries on network errors up to 3 times ───────
async function withRetry(fn, retries = 3, delayMs = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      const isNetworkErr = e.message && (
        e.message.includes('Premature close') ||
        e.message.includes('ECONNRESET') ||
        e.message.includes('ETIMEDOUT') ||
        e.message.includes('fetch failed') ||
        e.message.includes('network')
      );
      if (isNetworkErr && i < retries - 1) {
        console.warn(`[upload] Network error, retry ${i + 1}/${retries - 1}: ${e.message}`);
        // Reset cached auth on network error so token is refreshed
        _cachedAuth = null;
        await new Promise(r => setTimeout(r, delayMs * (i + 1)));
      } else {
        throw e;
      }
    }
  }
}

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
    if (!name || name.length < 2)                            errors.push('Name is required (min 2 chars).');
    if (!location || location.length < 2)                    errors.push('Location is required.');
    if (!phone || !/^\+?[\d\s\-]{7,20}$/.test(phone))       errors.push('Valid WhatsApp number is required.');
    if (!desc || desc.length < 10)                           errors.push('Description is required (min 10 chars).');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Invalid email format.');
    if (maplink && !maplink.startsWith('https://'))          errors.push('Map link must start with https://');
    if (errors.length) return res.status(400).json({ ok: false, errors });

    // ── Validate images ──────────────────────────────────────────
    const rawImages = Array.isArray(body.images) ? body.images.slice(0, 3) : [];
    const ALLOWED   = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic'];
    const MAX_BYTES = 5 * 1024 * 1024;

    for (const img of rawImages) {
      if (!img || !img.data || !img.type) continue;
      if (!ALLOWED.includes(img.type.toLowerCase()))
        return res.status(400).json({ ok: false, error: 'Only JPEG, PNG, WebP images allowed.' });
      if (Buffer.from(img.data, 'base64').length > MAX_BYTES)
        return res.status(400).json({ ok: false, error: 'Each image must be under 5MB.' });
    }

    // ── Google clients ───────────────────────────────────────────
    const { google } = require('googleapis');
    const auth   = getAuth();
    const drive  = google.drive({ version: 'v3', auth });
    const sheets = google.sheets({ version: 'v4', auth });
    const imgLinks = [];

    // ── Upload images to Drive (with retry) ──────────────────────
    for (let i = 0; i < rawImages.length; i++) {
      const img = rawImages[i];
      if (!img || !img.data) continue;

      const buf     = Buffer.from(img.data, 'base64');
      const ext     = (img.ext && /^[a-z0-9]{2,5}$/.test(img.ext)) ? img.ext : 'jpg';
      const safeName = `${name}_${category}_${Date.now()}_${i + 1}.${ext}`
        .replace(/[^a-zA-Z0-9._\-]/g, '_');

      const created = await withRetry(() => drive.files.create({
        requestBody: {
          name: safeName,
          parents: [process.env.GOOGLE_DRIVE_FOLDER_ID]
        },
        media: { mimeType: img.type, body: Readable.from(buf) },
        fields: 'id,webViewLink'
      }));

      await withRetry(() => drive.permissions.create({
        fileId: created.data.id,
        requestBody: { role: 'reader', type: 'anyone' }
      }));

      imgLinks.push(created.data.webViewLink || '');
    }

    // ── Append to Google Sheet (with retry) ──────────────────────
    await withRetry(() => sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:J',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          new Date().toISOString(),
          category,
          name,
          business || category,
          location,
          maplink  || '',
          phone,
          email    || '',
          desc,
          imgLinks.join('\n')
        ]]
      }
    }));

    console.log(`[upload/submit] ✅ ${category} — ${name} (${location})`);
    return res.status(201).json({ ok: true });

  } catch (e) {
    console.error('[upload/submit error]', e.message);
    return res.status(500).json({ ok: false, error: 'Submission failed. Please try again.' });
  }
});

module.exports = router;
