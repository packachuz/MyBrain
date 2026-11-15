import { mkdirSync } from "node:fs";
import { PGlite, type Results } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

/** Normalized query result returned by `DbClient` and `DbTransactionClient`. */
export interface DbQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount?: number;
  affectedRows?: number;
}

/** Query and script execution interface available both inside and outside a transaction. */
export interface DbTransactionClient {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<DbQueryResult<T>>;
  exec(sql: string): Promise<void>;
}

/** Database client abstraction decoupling knowledge operations from the underlying Postgres driver. */
export interface DbClient extends DbTransactionClient {
  transaction<T>(fn: (tx: DbTransactionClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function toDbQueryResult<T>(res: Results<T>): DbQueryResult<T> {
  return {
    rows: res.rows,
    rowCount: res.rowCount,
    affectedRows: res.affectedRows,
  };
}

/**
 * Create an embedded PGlite client with the `pgvector` extension enabled.
 * All database operations are serialized through an in-process async mutex
 * to protect single-owner PGlite state from concurrent write races.
 */
export async function createPgliteClient(dataDir?: string): Promise<DbClient> {
  // PGlite's NodeFS creates only a single directory level; ensure nested dataDir paths exist first.
  if (dataDir && !/^[a-z][a-z0-9+.-]*:\/\//i.test(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const pg = await PGlite.create({
    ...(dataDir ? { dataDir } : {}),
    extensions: { vector },
  });

  // Promise-chain mutex ensures every operation runs sequentially even after prior rejections.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return {
    query<T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<DbQueryResult<T>> {
      return enqueue(async () => toDbQueryResult(await pg.query<T>(sql, params)));
    },

    exec(sql: string): Promise<void> {
      return enqueue(async () => {
        await pg.exec(sql);
      });
    },

    transaction<T>(fn: (tx: DbTransactionClient) => Promise<T>): Promise<T> {
      return enqueue(() =>
        pg.transaction((pgTx) => {
          const txClient: DbTransactionClient = {
            async query<R = Record<string, unknown>>(
              sql: string,
              params?: unknown[],
            ): Promise<DbQueryResult<R>> {
              return toDbQueryResult(await pgTx.query<R>(sql, params));
            },
            async exec(sql: string): Promise<void> {
              await pgTx.exec(sql);
            },
          };
          return fn(txClient);
        }),
      );
    },

    close(): Promise<void> {
      return enqueue(() => pg.close());
    },
  };
}
