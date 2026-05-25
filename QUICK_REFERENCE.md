# Nulldown - Quick Reference

## Installation

```bash
npm install  # or bun install
```

## Development

### Local Development (with Functions)

```bash
npm run pages:dev
```

Opens `http://localhost:8788`
Uses local R2 emulation (`.wrangler/state/r2/`)

### Local Development (Frontend Only)

```bash
npm run dev
```

Opens `http://localhost:5173`
WARNING: API calls will fail (no Functions)

### Remote R2 Testing

```bash
npm run pages:dev:remote
```

Uses production R2 bucket
Requires `wrangler login`

## Deployment

```bash
npm run deploy
```

## Environment Variables

### Local (`.dev.vars`)

```env
PUBLIC_BASE_URL=http://localhost:8788
```

### Production (Cloudflare Dashboard)

- `PUBLIC_BASE_URL` - Your domain (e.g., `https://nulldown.pages.dev`)
- `R2_BUCKET` - R2 binding (Settings > Functions > R2 bucket bindings)

## R2 Buckets Setup

```bash
wrangler r2 bucket create nulldown
wrangler r2 bucket create nulldown-preview
```

## Project Structure

```
functions/
  api/
    store.ts         - POST /api/store (create drop)
    get/[id].ts      - GET /api/get/:id (fetch drop)
src/
  pages/
    EditorPage.tsx   - Main editor (/)
    DropViewPage.tsx - View drop (/d/:id)
```

## Configuration Files

- `wrangler.toml` - Cloudflare Pages + R2 config [FIXED]
- `.dev.vars` - Local environment variables [CREATED]
- `_redirects` - SPA routing for `/d/:id`
- `_headers` - Security headers

## Pre-Deployment Checklist

- [ ] Test locally: `npm run pages:dev`
- [ ] Create R2 buckets (see above)
- [ ] Set `PUBLIC_BASE_URL` in dashboard
- [ ] Configure `R2_BUCKET` binding in dashboard
- [ ] Run `npm run deploy`
- [ ] Test on production URL

## Troubleshooting

### "R2_BUCKET binding is required"

Use `npm run pages:dev` (not `npm run dev`)
Configure binding in dashboard for production

### "PUBLIC_BASE_URL environment variable is required"

Check `.dev.vars` exists locally
Set in dashboard for production

### Port 8788 already in use

```bash
pkill -f wrangler
```

## Documentation

- `CLOUDFLARE_SETUP.md` - Complete setup guide
- `CHANGES.md` - What was fixed

## API Endpoints

### Create Drop

```bash
POST /api/store
Content-Type: text/plain
Body: <markdown content>

Response: { "id": "abc123", "url": "https://...//d/abc123" }
```

### Get Drop

```bash
GET /api/get/:id

Response: <markdown content as plain text>
```

---

**Everything is configured and ready to go**
