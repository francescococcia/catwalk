# Vigil demo app

Minimal Next.js + SQLite shop (SQLite via Node's built-in `node:sqlite`, no native deps)
used as the attack target for Vigil. It has login and
`GET /api/orders/[id]`, and that route **deliberately skips the ownership check** —
any logged-in user can read any order by changing the ID (IDOR). This is intentional:
`engine/proof/attack.py` proves it at runtime.

Seeded demo users (public, demo-only): `alice` / `alice123`, `bob` / `bob123`.
Bob owns order `ord_b1`, which contains a secret note.

## Run it (port 3001)

```bash
npm install && npm run dev:3001
```

Then open http://localhost:3001 (log in as alice, press "Attack: read ord_b1 as alice"),
or point the attack client at it:

```bash
VIGIL_TARGET_URL=http://localhost:3001 uv run --project engine proof/attack.py
```

## API

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/login` | no | body `{"username","password"}`, sets HttpOnly session cookie |
| GET | `/api/orders` | yes | returns only the session user's orders (correct) |
| GET | `/api/orders/[id]` | yes | **no ownership check — the demo vulnerability** |

## Layout

```
app/api/login/route.ts        credential check, signs session cookie
app/api/orders/route.ts       correctly scoped list
app/api/orders/[id]/route.ts  session check but NO ownership check (vulnerable)
lib/db.ts                     node:sqlite init + seed (data/demo.db)
lib/session.ts                HMAC-signed cookie helpers
```
