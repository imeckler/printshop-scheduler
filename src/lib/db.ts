import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { getConfig } from './config';
import { ensureMigrations } from './migrate';
import { pgPoolConfig } from './sslConfig';
import * as schema from './schema';

const config = getConfig();
const pool = new Pool(pgPoolConfig(config.database.postgresql_url));

export const db = drizzle(pool, { schema });

// Initialize database with migrations
export async function initializeDatabase() {
  if (process.env.NODE_ENV !== 'test') {
    await ensureMigrations();
  }
}
