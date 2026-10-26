import { DataSource } from 'typeorm';
import type { QueryRunner } from 'typeorm';
import type { AppConfig } from '../config.js';

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

async function runQuery<Row>(
  runner: QueryRunner,
  text: string,
  values?: readonly unknown[],
): Promise<QueryResult<Row>> {
  const result = await runner.query(text, values as unknown[] | undefined, true);
  const rows = (Array.isArray(result.records) ? result.records : result.raw) as Row[];
  return {
    rows,
    rowCount: result.affected ?? rows.length,
  };
}

export function createDatabase(config: AppConfig): Database {
  const dataSource = new DataSource({
    type: 'postgres',
    url: config.databaseUrl,
    synchronize: false,
    logging: false,
    poolSize: 10,
    extra: {
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
    },
  });
  let initialization: Promise<DataSource> | null = null;

  const ensureReady = async (): Promise<void> => {
    if (dataSource.isInitialized) return;
    if (!initialization) {
      initialization = dataSource.initialize().finally(() => {
        initialization = null;
      });
    }
    await initialization;
  };

  const query = async <Row>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>> => {
    await ensureReady();
    const runner = dataSource.createQueryRunner();
    try {
      await runner.connect();
      return await runQuery<Row>(runner, text, values);
    } finally {
      await runner.release();
    }
  };

  const transaction = async <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> => {
    await ensureReady();
    const runner = dataSource.createQueryRunner();
    try {
      await runner.connect();
      await runner.startTransaction();
      const tx: Queryable = {
        query: <Row>(text: string, values?: readonly unknown[]) =>
          runQuery<Row>(runner, text, values),
      };
      const result = await fn(tx);
      await runner.commitTransaction();
      return result;
    } catch (error) {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction().catch(() => undefined);
      }
      throw error;
    } finally {
      await runner.release();
    }
  };

  return {
    query,
    transaction,
    end: async () => {
      await initialization?.catch(() => undefined);
      if (dataSource.isInitialized) await dataSource.destroy();
    },
    isAvailable: async () => {
      try {
        await query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
  };
}
