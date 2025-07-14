import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { getConfig } from './config';
import * as schema from './schema';
import { ensureSeedData } from './seedData';
import fs from 'fs';
import path from 'path';

const config = getConfig();

export async function runMigrations() {
  const pool = new Pool({
    connectionString: config.database.postgresql_url,
  });

  const db = drizzle(pool, { schema });

  try {
    console.log('Running Drizzle migrations...');
    
    // Run Drizzle migrations
    await migrate(db, { migrationsFolder: './drizzle' });

    console.log('Running PostgreSQL-specific migrations...');

    // Check if PostgreSQL-specific features are already applied
    const triggerExists = await checkTriggerExists(pool);

    if (!triggerExists) {
      // Read and execute the custom SQL migrations
      const migrationsSQL = fs.readFileSync(path.join(__dirname, 'migrations.sql'), 'utf-8');

      await pool.query(migrationsSQL);
      console.log('PostgreSQL-specific migrations completed successfully');
    } else {
      console.log('PostgreSQL-specific migrations already applied');
    }

    console.log('Running seed data...');
    await ensureSeedData();
    console.log('Seed data completed');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    await pool.end();
  }
}


async function checkTriggerExists(pool: Pool): Promise<boolean> {
  try {
    const result = await pool.query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_trigger 
        WHERE tgname = 'credit_balance_tg'
      ) as trigger_exists
    `);

    return result.rows[0].trigger_exists;
  } catch (error) {
    console.log('Could not check trigger existence, proceeding with migration');
    return false;
  }
}

// Helper function to run migrations programmatically
export async function ensureMigrations() {
  try {
    await runMigrations();
  } catch (error) {
    console.error('Failed to run migrations:', error);
    process.exit(1);
  }
}
