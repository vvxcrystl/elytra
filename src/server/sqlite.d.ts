// The project currently uses @types/node 20; Node 26 provides this built-in module.
declare module "node:sqlite" {
  type SQLInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;
  type SQLRow = Record<string, null | number | bigint | string | Uint8Array>;
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    function(name: string, options: { deterministic?: boolean }, fn: (...args: unknown[]) => string): void;
    prepare(sql: string): {
      all(...params: SQLInputValue[]): SQLRow[];
      get(...params: SQLInputValue[]): SQLRow | undefined;
      run(...params: SQLInputValue[]): { changes: number; lastInsertRowid: number | bigint };
    };
    close(): void;
  }
}
