#!/usr/bin/env node

import { runMigrations } from '../lib/migrate';

console.log('Starting database migrations...');

runMigrations()
  .then(() => {
    console.log('All migrations completed successfully');
    process.exit(0);
  })
  .catch(error => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
