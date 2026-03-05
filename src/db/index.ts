import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { initSchema } from './schema';

let db: Database.Database | null = null;

export function getDbPath(): string {
  const dir = path.join(os.homedir(), '.opengauge');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, 'opengauge.db');
}

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = getDbPath();
  db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Try to load sqlite-vec extension
  try {
    db.loadExtension('vec0');
  } catch {
    // sqlite-vec may not be available; embeddings table will be skipped
    console.warn(
      'sqlite-vec extension not found. Vector search will be unavailable. ' +
      'Install sqlite-vec for full RAG support.'
    );
  }

  initSchema(db);

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
