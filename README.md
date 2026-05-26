# LTP Business Suite

Business management web app for Luminary Technology & Productions.

## Stack

- **Frontend**: Vanilla JS + React 18 via CDN (no build step)
- **Backend**: Python FastAPI + SQLAlchemy (async)
- **Database**: PostgreSQL (Railway managed)
- **Deployment**: Railway

## Deploy to Railway

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USER/ltp-app.git
git push -u origin main
```

### 2. Create Railway project

1. Go to [railway.com](https://railway.com) and create a new project
2. Click **"Deploy from GitHub repo"** and select your repo
3. Click **"+ New"** → **"Database"** → **"PostgreSQL"**
4. Railway auto-provisions the database and sets `DATABASE_URL`

### 3. Connect the database

In your FastAPI service's **Variables** tab, add a reference:
- `DATABASE_URL` → click **"Add Reference"** → select the PostgreSQL service's `DATABASE_URL`

Railway will inject the connection string automatically.

### 4. Deploy

Railway will:
1. Detect `requirements.txt` and install Python dependencies
2. Run `build.sh` to copy frontend files to `frontend/`
3. Start the server with `uvicorn backend.main:app`

The app will be live at your Railway domain.

## Local Development

```bash
# Install dependencies
pip install -r requirements.txt

# Build frontend
bash build.sh

# Run server (uses SQLite locally)
uvicorn backend.main:app --reload --port 8000
```

Open http://localhost:8000

## API Endpoints

All entities follow REST conventions:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/{entity}` | List all |
| GET | `/api/{entity}/{id}` | Get one |
| POST | `/api/{entity}` | Create |
| PUT | `/api/{entity}/{id}` | Update |
| DELETE | `/api/{entity}/{id}` | Delete |

Entities: `companies`, `contacts`, `projects`, `quotes`, `invoices`, `equipment`, `products`, `services`

Special endpoints:
- `GET/PUT /api/settings` — App settings (singleton)
- `POST /api/sync` — Bulk import from localStorage

## Migrating Data from localStorage

Open the browser console on your current app and run:

```javascript
fetch('/api/sync', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    companies: JSON.parse(localStorage.getItem('ltp_companies') || '[]'),
    contacts: JSON.parse(localStorage.getItem('ltp_contacts') || '[]'),
    projects: JSON.parse(localStorage.getItem('ltp_projects') || '[]'),
    quotes: JSON.parse(localStorage.getItem('ltp_quotes') || '[]'),
    invoices: JSON.parse(localStorage.getItem('ltp_invoices') || '[]'),
    equipment: JSON.parse(localStorage.getItem('ltp_equipment') || '[]'),
    products: JSON.parse(localStorage.getItem('ltp_products') || '[]'),
    services: JSON.parse(localStorage.getItem('ltp_services') || '[]'),
    settings: JSON.parse(localStorage.getItem('ltp_settings') || '{}'),
  })
}).then(r => r.json()).then(console.log);
```

## Project Structure

```
ltp-app/
├── backend/
│   ├── main.py           # FastAPI app entry point
│   ├── database.py        # Async SQLAlchemy setup
│   ├── models.py          # Database models (9 tables)
│   └── routes/
│       └── api.py         # REST API routes + /sync
├── components/            # Frontend: shared React components
├── modules/               # Frontend: page modules
├── data/                  # Frontend: default/seed data
├── index.html             # Frontend: entry point
├── app.js                 # Frontend: root React component
├── theme.js               # Frontend: theme + global utilities
├── router.js              # Frontend: hash router
├── build.sh               # Copies frontend → frontend/ for serving
├── requirements.txt       # Python dependencies
├── railway.json           # Railway deployment config
├── nixpacks.toml          # Build configuration
└── README.md
```
