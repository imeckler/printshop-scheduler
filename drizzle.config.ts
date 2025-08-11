import { defineConfig } from 'drizzle-kit';
import { getConfig } from './src/lib/config';

const config = getConfig();

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/lib/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: config.database.postgresql_url,
  },
});