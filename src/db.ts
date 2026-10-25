import pg from 'pg';
import type { AppConfig } from './config.js';

const { Pool } = pg;

export type QueryResult<Row> = {
  rows: Row[];
  rowCount: number | null;
};

export type Database = {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  end: () => Promise<void>;
  isAvailable: () => Promise<boolean>;
};

export function createDatabase(config: AppConfig): Database {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  // An idle-client error must not crash the API (scraper and API share the DB).
  pool.on('error', (error) => {
    console.error('database idle client error', error);
  });

  return {
    query: async <Row>(text: string, values?: readonly unknown[]) => {
      const result = await pool.query(text, values as unknown[]);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    },
    end: () => pool.end(),
    isAvailable: async () => {
      try {
        await pool.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
  };
}
