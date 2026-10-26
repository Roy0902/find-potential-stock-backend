import pg from 'pg';
import type { AppConfig } from '../config.js';

const { Pool } = pg;

export type QueryResult<Row> = {
  rows: Row[];
  rowCount: number | null;
};

export type Queryable = {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
};

export type Database = Queryable & {
  transaction: <T>(fn: (tx: Queryable) => Promise<T>) => Promise<T>;
  end: () => Promise<void>;
  isAvailable: () => Promise<boolean>;
};

export function createDatabase(config: AppConfig): Database {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
  });

  // An idle-client error must not crash the API (scraper and API share the DB).
  pool.on('error', (error) => {
    console.error('database idle client error', error);
  });

  const query = async <Row>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>> => {
    const result = await pool.query(text, values as unknown[]);
    return { rows: result.rows as Row[], rowCount: result.rowCount };
  };

  const transaction = async <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tx: Queryable = {
        query: async <Row>(text: string, values?: readonly unknown[]) => {
          const result = await client.query(text, values as unknown[]);
          return { rows: result.rows as Row[], rowCount: result.rowCount };
        },
      };
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  return {
    query,
    transaction,
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
