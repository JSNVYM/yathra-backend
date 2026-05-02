// models/index.js — Mongoose schemas
'use strict';
const mongoose = require('mongoose');

// ── Trip Partner (Find Travel Partner) ──────────────────────────
const TripPartnerSchema = new mongoose.Schema({
  name:      { type: String, required: true, maxlength: 60, trim: true },
  phone:     { type: String, default: '', maxlength: 20, trim: true },
  from:      { type: String, required: true, maxlength: 80, trim: true },
  dest:      { type: String, required: true, maxlength: 80, trim: true },
  date:      { type: String, required: true, maxlength: 20, trim: true },
  seats:     { type: Number, required: true, min: 1, max: 20 },
  desc:      { type: String, default: '', maxlength: 400, trim: true },
  emoji:     { type: String, default: '🧭', maxlength: 8 },
  uid:       { type: String, required: true, maxlength: 128 },
  createdAt: { type: Date, default: Date.now, index: true }
}, { versionKey: false });

// ── Meetup ───────────────────────────────────────────────────────
const MeetupSchema = new mongoose.Schema({
  name:    { type: String, required: true, maxlength: 60, trim: true },
  mname:   { type: String, required: true, maxlength: 80, trim: true },
  place:   { type: String, required: true, maxlength: 80, trim: true },
  date:    { type: String, required: true, maxlength: 20, trim: true },
  max:     { type: Number, required: true, min: 2, max: 100 },
  members: { type: Number, default: 1, min: 1 },
  type:    { type: String, default: 'General', maxlength: 40 },
  desc:    { type: String, default: '', maxlength: 400, trim: true },
  emoji:   { type: String, default: '🎯', maxlength: 8 },
  uid:     { type: String, required: true, maxlength: 128 },
  createdAt: { type: Date, default: Date.now, index: true }
}, { versionKey: false });

// ── Chat Message ─────────────────────────────────────────────────
const ChatMessageSchema = new mongoose.Schema({
  roomId: { type: String, required: true, maxlength: 128, index: true },
  text:   { type: String, required: true, maxlength: 500, trim: true },
  sender: { type: String, required: true, maxlength: 60, trim: true },
  uid:    { type: String, required: true, maxlength: 128 },
  ts:     { type: Date, default: Date.now, index: true }
}, { versionKey: false });

// Compound index so room queries are fast
ChatMessageSchema.index({ roomId: 1, ts: 1 });

// ── Room metadata (tracks active members, name, type) ───────────
const RoomSchema = new mongoose.Schema({
  _id:      { type: String },          // same as tripPartner/meetup _id
  name:     { type: String, maxlength: 80, trim: true },
  type:     { type: String, enum: ['partner','meetup'], default: 'partner' },
  createdAt:{ type: Date, default: Date.now }
}, { versionKey: false });

module.exports = {
  TripPartner: mongoose.model('TripPartner', TripPartnerSchema),
  Meetup:      mongoose.model('Meetup',      MeetupSchema),
  ChatMessage: mongoose.model('ChatMessage', ChatMessageSchema),
  Room:        mongoose.model('Room',        RoomSchema)
};
