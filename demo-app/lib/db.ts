import { DatabaseSync } from "node:sqlite";
import { createHash } from "crypto";
import { mkdirSync } from "fs";
import path from "path";

// DEMO ONLY: seeded credentials below are public knowledge for the hackathon demo.
// This app exists to be attacked by engine/proof/attack.py.
// SQLite via Node's built-in node:sqlite (Node >= 22.5, no native deps).

const DATA_DIR = path.join(process.cwd(), "data");
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, "demo.db"));
db.exec("PRAGMA journal_mode = WAL;");

function hashPassword(password: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${password}`).digest("hex");
}

export interface User {
  id: number;
  username: string;
  password_hash: string;
  salt: string;
}

export interface Order {
  id: string;
  user_id: number;
  item: string;
  total: number;
  secret_note: string;
}

export function initDb(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      item TEXT NOT NULL,
      total REAL NOT NULL,
      secret_note TEXT NOT NULL
    );
  `);

  const userCount = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number | bigint };
  if (Number(userCount.n) > 0) return;

  const insertUser = db.prepare("INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)");
  const insertOrder = db.prepare(
    "INSERT INTO orders (id, user_id, item, total, secret_note) VALUES (?, ?, ?, ?, ?)"
  );

  db.exec("BEGIN");
  try {
    // DEMO-ONLY seeded passwords: alice123 / bob123 (hackathon demo, not real secrets).
    const aliceSalt = "demo-salt-alice";
    const bobSalt = "demo-salt-bob";
    const aliceId = Number(insertUser.run("alice", hashPassword("alice123", aliceSalt), aliceSalt).lastInsertRowid);
    const bobId = Number(insertUser.run("bob", hashPassword("bob123", bobSalt), bobSalt).lastInsertRowid);

    insertOrder.run("ord_a1", aliceId, "Sticker pack (Mistral)", 9.99, "alice's private note: gift for mom");
    insertOrder.run("ord_a2", aliceId, "Vibe hoodie", 59.0, "alice's private note: size M");
    insertOrder.run("ord_b1", bobId, "Le Chonk plush", 29.99, "BOB'S SECRET: surprise party budget £200");
    insertOrder.run("ord_b2", bobId, "Conference ticket", 120.0, "BOB'S SECRET: talk accepted, title TBD");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function verifyLogin(username: string, password: string): User | null {
  const user = db
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(username) as User | undefined;
  if (!user) return null;
  if (user.password_hash !== hashPassword(password, user.salt)) return null;
  return user;
}

export function getOrderById(id: string): Order | undefined {
  return db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as Order | undefined;
}

export function getOrdersForUser(userId: number): Order[] {
  return db
    .prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY id")
    .all(userId) as Order[];
}

export function getUserById(id: number): User | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User | undefined;
}
