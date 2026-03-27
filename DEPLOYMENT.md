# Mission Board Deployment Guide

## Current Status

✅ **Code:** Ready and committed (commit `993b2ef2`)  
⚠️ **Production:** Needs platform service setup on web VPS

---

## Prerequisites

1. Node.js v22+ installed
2. Supabase project credentials
3. Nginx configured (already done)
4. Port 3001 available

---

## Environment Variables Required

Create `/root/mrdelegate/platform/.env`:

```bash
# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_KEY=your-service-key

# Server
PORT=3001
NODE_ENV=production

# Mission Board
MISSION_BOARD_SECRET=your-secret-key
```

---

## Installation Steps

### 1. Install Dependencies

```bash
cd /root/mrdelegate/platform
npm install
```

### 2. Test Locally

```bash
PORT=3001 node src/server.js
```

Should see:
```
✓ Mission Board API running on http://localhost:3001
```

### 3. Create Systemd Service

Create `/etc/systemd/system/mrdelegate-platform.service`:

```ini
[Unit]
Description=MrDelegate Platform
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/mrdelegate/platform
EnvironmentFile=/root/mrdelegate/platform/.env
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=10
StandardOutput=append:/var/log/mrdelegate-platform.log
StandardError=append:/var/log/mrdelegate-platform.log

[Install]
WantedBy=multi-user.target
```

### 4. Enable and Start Service

```bash
systemctl daemon-reload
systemctl enable mrdelegate-platform
systemctl start mrdelegate-platform
systemctl status mrdelegate-platform
```

### 5. Verify

```bash
# Check service is running
curl http://localhost:3001/ops/mission-board/api/health

# Check from web
curl https://mrdelegate.ai/ops/mission-board

# Check logs
tail -f /var/log/mrdelegate-platform.log
```

---

## Nginx Configuration

Already configured at `/etc/nginx/sites-available/mrdelegate.ai`:

```nginx
location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_cache_bypass $http_upgrade;
}
```

No changes needed.

---

## Database Setup

Mission Board uses Supabase for task storage.

### Required Tables

1. **tasks**
   - id (uuid, primary key)
   - title (text)
   - description (text)
   - status (enum: pending, running, completed, blocked)
   - priority (enum: P0, P1, P2)
   - agentId (text)
   - goalStream (text)
   - createdAt (timestamp)
   - updatedAt (timestamp)
   - startedAt (timestamp, nullable)
   - completedAt (timestamp, nullable)
   - estimatedCompletionMinutes (integer, nullable)
   - error (jsonb, nullable)
   - metadata (jsonb, nullable)

2. **agents**
   - id (text, primary key)
   - name (text)
   - status (enum: idle, working)
   - createdAt (timestamp)

### SQL Schema

```sql
-- Tasks table
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT,
  description TEXT,
  status TEXT CHECK (status IN ('pending', 'running', 'completed', 'blocked')),
  priority TEXT CHECK (priority IN ('P0', 'P1', 'P2')),
  agentId TEXT,
  goalStream TEXT,
  createdAt TIMESTAMPTZ DEFAULT NOW(),
  updatedAt TIMESTAMPTZ DEFAULT NOW(),
  startedAt TIMESTAMPTZ,
  completedAt TIMESTAMPTZ,
  estimatedCompletionMinutes INTEGER,
  error JSONB,
  metadata JSONB
);

-- Agents table
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT CHECK (status IN ('idle', 'working')) DEFAULT 'idle',
  createdAt TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_priority ON tasks(priority);
CREATE INDEX idx_tasks_agentId ON tasks(agentId);
CREATE INDEX idx_tasks_createdAt ON tasks(createdAt DESC);
CREATE INDEX idx_tasks_completedAt ON tasks(completedAt DESC);

-- Seed agents
INSERT INTO agents (id, name) VALUES
  ('ceo', 'CEO'),
  ('mr-seo', 'Mr. SEO'),
  ('mr-copy', 'Mr. Copy'),
  ('mr-email', 'Mr. Email'),
  ('mr-analytics', 'Mr. Analytics'),
  ('mr-support', 'Mr. Support'),
  ('mr-web', 'Mr. Web'),
  ('mr-design', 'Mr. Design'),
  ('mr-infra', 'Mr. Infra'),
  ('mr-qa', 'Mr. QA'),
  ('mr-leadgen', 'Mr. LeadGen'),
  ('miami-carlos', 'MiamiCarlos');
```

---

## Troubleshooting

### Service won't start

```bash
# Check logs
journalctl -u mrdelegate-platform -n 50 --no-pager

# Check env vars loaded
systemctl show mrdelegate-platform | grep Environment

# Test manually
cd /root/mrdelegate/platform
source .env
node src/server.js
```

### Database connection fails

```bash
# Test Supabase connection
curl https://your-project.supabase.co/rest/v1/tasks \
  -H "apikey: your-anon-key"
```

### Nginx 502 error

```bash
# Check platform service is running
systemctl status mrdelegate-platform

# Check port 3001 is listening
lsof -i :3001

# Restart nginx
systemctl restart nginx
```

---

## Maintenance

### Update Code

```bash
cd /root/mrdelegate/platform
git pull origin main
npm install
systemctl restart mrdelegate-platform
```

### View Logs

```bash
# Platform logs
tail -f /var/log/mrdelegate-platform.log

# Nginx logs
tail -f /var/log/nginx/access.log
tail -f /var/log/nginx/error.log

# Systemd logs
journalctl -u mrdelegate-platform -f
```

### Monitor Performance

```bash
# Check service status
systemctl status mrdelegate-platform

# Check resource usage
top -p $(pgrep -f "node src/server.js")

# Check response time
time curl https://mrdelegate.ai/ops/mission-board/api/tasks
```

---

## Security

### Auth

Mission Board requires login:
- Uses localStorage token: `md_admin_token`
- Redirects to `/ops` if not authenticated

### HTTPS

- All traffic over HTTPS (Nginx handles SSL)
- Certbot configured for auto-renewal

### Database

- Service key only in server-side env
- Anon key for client-side (limited permissions)
- Row-level security policies recommended

---

## Next Steps

1. Set up Supabase project
2. Run SQL schema
3. Configure `.env` file
4. Install dependencies
5. Create systemd service
6. Start service
7. Verify deployment
8. Test mission board at https://mrdelegate.ai/ops/mission-board

---

## Contact

**Issues:** Report in `/root/mrdelegate/life/`  
**Code:** `/root/mrdelegate/platform/src/`  
**Commit:** `993b2ef2` (Mission Board P0/P1 improvements)

---

**Status:** Ready to deploy once environment is configured ✅
