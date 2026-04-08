import { defineConfig } from 'drizzle-kit';
import { getDataDir } from './src/core/config.js';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: `${getDataDir()}/copyhunter.db`,
  },
});
