// middleware/sanitize.js — Input validation & sanitization
'use strict';
const xss = require('xss');
const validator = require('validator');

// Recursively sanitize strings in an object (XSS-safe)
function sanitizeObject(obj) {
  if (typeof obj === 'string') {
    return xss(obj.trim(), {
      whiteList: {},          // no HTML tags allowed at all
      stripIgnoreTag: true,
      stripIgnoreTagBody: ['script','style']
    });
  }
  if (Array.isArray(obj)) return obj.map(sanitizeObject);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = sanitizeObject(obj[k]);
    return out;
  }
  return obj;
}

// Express middleware: sanitize req.body & req.params
const sanitizeInputs = (req, _res, next) => {
  if (req.body)   req.body   = sanitizeObject(req.body);
  if (req.params) req.params = sanitizeObject(req.params);
  if (req.query)  req.query  = sanitizeObject(req.query);
  next();
};

// ── Field validators ─────────────────────────────────────────────

function validateTripPartner(body) {
  const errors = [];
  if (!body.name  || body.name.length  < 2 || body.name.length  > 60)  errors.push('Name must be 2–60 chars');
  if (!body.from  || body.from.length  < 2 || body.from.length  > 80)  errors.push('From location required (max 80 chars)');
  if (!body.dest  || body.dest.length  < 2 || body.dest.length  > 80)  errors.push('Destination required (max 80 chars)');
  if (!body.date  || !validator.isDate(body.date, { format: 'YYYY-MM-DD', strictMode: true })) errors.push('Valid travel date required (YYYY-MM-DD)');
  const seats = parseInt(body.seats);
  if (isNaN(seats) || seats < 1 || seats > 20) errors.push('Seats must be 1–20');
  if (body.phone && !/^\+?[\d\s\-]{7,20}$/.test(body.phone)) errors.push('Invalid phone number');
  if (body.desc  && body.desc.length  > 400) errors.push('Description max 400 chars');
  return errors;
}

function validateMeetup(body) {
  const errors = [];
  if (!body.name  || body.name.length  < 2 || body.name.length  > 60)  errors.push('Your name must be 2–60 chars');
  if (!body.mname || body.mname.length < 2 || body.mname.length > 80)  errors.push('Meetup name must be 2–80 chars');
  if (!body.place || body.place.length < 2 || body.place.length > 80)  errors.push('Location required (max 80 chars)');
  if (!body.date  || !validator.isDate(body.date, { format: 'YYYY-MM-DD', strictMode: true })) errors.push('Valid date required (YYYY-MM-DD)');
  const max = parseInt(body.max);
  if (isNaN(max) || max < 2 || max > 100) errors.push('Max members must be 2–100');
  if (body.phone && !/^\+?[\d\s\-]{7,20}$/.test(body.phone)) errors.push('Invalid phone number');
  if (body.desc  && body.desc.length  > 400) errors.push('Description max 400 chars');
  return errors;
}

function validateChatMessage(body) {
  const errors = [];
  if (!body.text   || body.text.length   < 1 || body.text.length   > 500)  errors.push('Message must be 1–500 chars');
  if (!body.sender || body.sender.length < 1 || body.sender.length > 60)   errors.push('Sender name required (max 60 chars)');
  if (!body.uid    || body.uid.length    < 1 || body.uid.length    > 128)   errors.push('UID required');
  return errors;
}

function validateUID(uid) {
  if (!uid || typeof uid !== 'string') return false;
  // Allow alphanumeric + hyphens (UUID format from client)
  return /^[a-zA-Z0-9\-_]{4,128}$/.test(uid);
}

module.exports = { sanitizeInputs, validateTripPartner, validateMeetup, validateChatMessage, validateUID };
