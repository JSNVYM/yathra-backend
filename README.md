# Yathra Map — Travel Partner Backend
## Production-ready Node.js + WebSocket + MongoDB

---

## 📁 File Structure

```
yathra-backend/
├── server.js                          ← Main server (Express + WebSocket)
├── package.json
├── .env.example                       ← Copy to .env with real values
├── src/
│   └── models.js                      ← MongoDB schemas
├── middleware/
│   └── sanitize.js                    ← XSS / validation
├── routes/
│   ├── listings.js                    ← REST: POST/GET trips & meetups
│   └── chat.js                        ← REST: GET chat history
└── FRONTEND_TRAVEL_PARTNER_SCRIPT.html ← Drop-in frontend replacement
```

---

## 🚀 Step 1 — Setup MongoDB Atlas (Free tier works)

1. Go to https://cloud.mongodb.com → Create free cluster
2. Create database user with a strong password
3. Allow IP: `0.0.0.0/0` (or your server's IP for tighter security)
4. Click **Connect → Drivers** → copy the connection string
5. Replace `<password>` in the string with your DB user's password

---

## 🔑 Step 2 — Configure .env

```bash
cp .env.example .env
nano .env
```

Fill in:
```env
PORT=3001
NODE_ENV=production
MONGODB_URI=mongodb+srv://user:pass@cluster.xxxxx.mongodb.net/yathra?retryWrites=true&w=majority
ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
```

---

## 📦 Step 3 — Install & Run

```bash
npm install
npm start
```

For development with auto-reload:
```bash
npm run dev
```

---

## ☁️ Step 4 — Deploy to a server

### Option A: Railway (easiest — free tier available)
1. Go to https://railway.app → New Project → Deploy from GitHub
2. Add environment variables in Railway dashboard
3. Railway gives you a URL like `https://yathra-backend.up.railway.app`

### Option B: Render
1. https://render.com → New Web Service → connect your repo
2. Start command: `node server.js`
3. Add env vars in Render dashboard

### Option C: VPS (DigitalOcean, Hetzner)
```bash
# Install Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Use PM2 for process management
npm install -g pm2
pm2 start server.js --name yathra-backend
pm2 save
pm2 startup

# Nginx reverse proxy (example)
# /etc/nginx/sites-available/yathra
server {
    listen 80;
    server_name api.yourdomain.com;
    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";   # Required for WebSocket
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then add SSL with Certbot:
```bash
sudo certbot --nginx -d api.yourdomain.com
```

---

## 🌐 Step 5 — Update your frontend (train.html)

Open `FRONTEND_TRAVEL_PARTNER_SCRIPT.html`.

1. **In your train.html**, find this comment on ~line 3875:
   ```
   <!-- ===== TRAVEL PARTNER POPUP ===== -->
   ```

2. **Delete** everything from that comment down to the closing `</script>` on ~line 4161.

3. **Paste** the entire contents of `FRONTEND_TRAVEL_PARTNER_SCRIPT.html` in its place.

4. **Update the two config lines** at the top of the pasted script:
   ```javascript
   const API_BASE = 'https://YOUR_BACKEND_URL';   // ← your deployed URL
   const WS_BASE  = 'wss://YOUR_BACKEND_URL/ws';  // ← same URL, wss:// protocol
   ```

5. The popup HTML (lines 4282–4371 in the original) **stays the same** — no changes needed there.

---

## 🔐 Security Features Built-In

| Feature | Implementation |
|---------|---------------|
| XSS prevention | `xss` library strips all HTML from inputs |
| NoSQL injection | `express-mongo-sanitize` blocks `$` and `.` in keys |
| Rate limiting | Global: 100 req/15min. Create: 10 listings/hour/IP |
| WebSocket rate limit | 10 messages per 5 seconds per connection |
| CORS | Strict allowlist — only your domain |
| Helmet | Secure HTTP headers |
| HPP | HTTP parameter pollution protection |
| Input validation | Field-by-field validation with max lengths |
| Message pruning | Rooms auto-prune to last 200 messages |
| Graceful shutdown | SIGTERM / SIGINT handled cleanly |

---

## 🔥 Firestore Security Rules (if you want to keep Firebase too)

If you don't switch backends and just want to fix your Firebase, here are proper Firestore rules:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    match /tripPartners/{doc} {
      allow read: if request.auth != null;
      allow create: if request.auth != null
        && request.resource.data.uid == request.auth.uid
        && request.resource.data.name is string
        && request.resource.data.name.size() <= 60
        && request.resource.data.from is string
        && request.resource.data.dest is string
        && request.resource.data.seats is int
        && request.resource.data.seats >= 1
        && request.resource.data.seats <= 20;
      allow update, delete: if false;
    }

    match /meetups/{doc} {
      allow read: if request.auth != null;
      allow create: if request.auth != null
        && request.resource.data.uid == request.auth.uid
        && request.resource.data.mname is string
        && request.resource.data.mname.size() <= 80;
      allow update, delete: if false;
    }

    match /chats/{roomId}/messages/{msgId} {
      allow read: if request.auth != null;
      allow create: if request.auth != null
        && request.resource.data.uid == request.auth.uid
        && request.resource.data.text is string
        && request.resource.data.text.size() <= 500
        && request.resource.data.sender is string
        && request.resource.data.sender.size() <= 60;
      allow update, delete: if false;
    }
  }
}
```

---

## 📡 API Reference

```
GET  /health                          → server status

GET  /api/listings/partners           → list trip partners (latest 30)
POST /api/listings/partners           → create trip partner listing
GET  /api/listings/meetups            → list meetups (latest 30)
POST /api/listings/meetups            → create meetup

GET  /api/chat/:roomId/messages       → fetch last 200 messages

WS   wss://your-domain/ws            → real-time chat
  send: { type: "join", roomId, uid }
  send: { type: "message", text, sender, uid }
  recv: { type: "message", _id, roomId, text, sender, uid, ts, mine? }
  recv: { type: "joined", roomId }
  recv: { type: "error", error }
```

---

## ❓ Common Issues

**WebSocket connection fails in browser**
→ Make sure Nginx has `proxy_set_header Upgrade` and `Connection "upgrade"` — required for WS.

**CORS error**
→ Add your exact domain (with https://) to `ALLOWED_ORIGINS` in `.env`.

**MongoDB connection timeout**
→ Check IP whitelist in Atlas. Add `0.0.0.0/0` or your server IP.
