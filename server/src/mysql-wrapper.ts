import { RunResult } from 'sqlite3';
import { AsyncDatabase, AsyncStatement } from 'promised-sqlite3';
import { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export class AsyncDatabaseWrapperForMySQL extends AsyncDatabase {
  constructor(private connection: Connection) {
    super(null as any);
  }

  override get inner(): never { throw new Error('Not implemented'); }

  override async close(): Promise<void> {
    this.connection.end();
  }

  // Converts SQLite-style positional params (?1, ?2, plain ?) to MySQL plain ?
  // Plain ? gets index = highest explicit index seen so far + 1 (SQLite rules).
  // Params are reordered/duplicated in the output array to match the new ? order.
  //
  // Also replaces MAX(a, b, ...) / MIN(a, b, ...) with GREATEST / LEAST when
  // called with multiple arguments (single-arg aggregate form is left unchanged).
  //
  private static adaptParamsAndSyntax(sql: string, params: unknown[]): [string, unknown[]] {
    params.forEach((v, i) => v === undefined && (params[i] = null));

    sql = sql.replace(/\bINSERT\s+OR\s+REPLACE\s+INTO\b/im, 'REPLACE INTO');

    let result = '';
    let i = 0;
    let highestIndex = 0;
    const outParams: unknown[] = [];

    // Returns true if the argument list starting just after '(' at sql[start]
    // contains more than one top-level argument (i.e., has a top-level comma).
    const hasMultipleArgs = (start: number): boolean => {
      let depth = 1, k = start;
      while (k < sql.length && depth > 0) {
        const c = sql[k];
        if (c === '(') depth++;
        else if (c === ')') { if (--depth === 0) break; }
        else if (c === ',' && depth === 1) return true;
        else if (c === "'") {
          k++;
          while (k < sql.length) {
            if (sql[k] === '\\') k++;
            else if (sql[k] === "'" && sql[k + 1] === "'") k++;
            else if (sql[k] === "'") break;
            k++;
          }
        }
        k++;
      }
      return false;
    };

    while (i < sql.length) {
      const ch = sql[i];

      // Single-quoted string: handle '' and \' escaping
      if (ch === "'") {
        result += ch; i++;
        while (i < sql.length) {
          if (sql[i] === '\\') { result += sql[i] + sql[i + 1]; i += 2; }
          else if (sql[i] === "'" && sql[i + 1] === "'") { result += "''"; i += 2; }
          else if (sql[i] === "'") { result += "'"; i++; break; }
          else { result += sql[i++]; }
        }
        continue;
      }

      // Double-quoted or backtick identifier
      if (ch === '"' || ch === '`') {
        const close = ch;
        result += ch; i++;
        while (i < sql.length && sql[i] !== close) result += sql[i++];
        if (i < sql.length) { result += sql[i++]; }
        continue;
      }

      // Line comment
      if (ch === '-' && sql[i + 1] === '-') {
        while (i < sql.length && sql[i] !== '\n') result += sql[i++];
        continue;
      }

      // Block comment
      if (ch === '/' && sql[i + 1] === '*') {
        result += sql[i] + sql[i + 1]; i += 2;
        while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) result += sql[i++];
        if (i < sql.length) { result += '*/'; i += 2; }
        continue;
      }

      // Identifier: check for MAX/MIN with multiple args → GREATEST/LEAST
      if (/[_A-Z]/i.test(ch)) {
        let ident = '';
        while (i < sql.length && /[_A-Z0-9]/i.test(sql[i])) ident += sql[i++];
        const upper = ident.toUpperCase();
        if (upper === 'MAX' || upper === 'MIN') {
          let j = i;
          while (j < sql.length && (sql[j] === ' ' || sql[j] === '\t')) j++;
          if (sql[j] === '(' && hasMultipleArgs(j + 1)) {
            result += upper === 'MAX' ? 'GREATEST' : 'LEAST';
            continue;
          }
        }
        result += ident;
        continue;
      }

      // Placeholder
      if (ch === '?') {
        i++;
        let index: number;
        if (i < sql.length && /[1-9]/i.test(sql[i])) {
          let numStr = '';
          while (i < sql.length && /[0-9]/i.test(sql[i])) numStr += sql[i++];
          index = parseInt(numStr, 10);
          if (index > highestIndex) highestIndex = index;
        }
        else {
          index = ++highestIndex;
        }
        outParams.push(params[index - 1] ?? null);
        result += '?';
        continue;
      }

      result += ch; i++;
    }

    return [result, outParams];
  }

  override async run(sql: string, ...params: unknown[]): Promise<RunResult> {
    const [adaptedSql, adaptedParams] = AsyncDatabaseWrapperForMySQL.adaptParamsAndSyntax(sql, params);
    const [result] = await this.connection.execute(adaptedSql, adaptedParams as any);
    const ok = result as ResultSetHeader;
    return { lastID: ok.insertId, changes: ok.affectedRows } as RunResult;
  }

  override async get<T>(sql: string, ...params: unknown[]): Promise<T> {
    const [adaptedSql, adaptedParams] = AsyncDatabaseWrapperForMySQL.adaptParamsAndSyntax(sql, params);
    const [rows] = await this.connection.execute<RowDataPacket[]>(adaptedSql, adaptedParams as any);
    return rows[0] as T;
  }

  override async all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    const [adaptedSql, adaptedParams] = AsyncDatabaseWrapperForMySQL.adaptParamsAndSyntax(sql, params);
    const [rows] = await this.connection.execute<RowDataPacket[]>(adaptedSql, adaptedParams as any);
    return rows as T[];
  }

  override async each<T>(sql: string, params: any, callback: (row: T) => void): Promise<number> {
    const [adaptedSql, adaptedParams] = AsyncDatabaseWrapperForMySQL.adaptParamsAndSyntax(sql, params);
    const [rows] = await this.connection.execute<RowDataPacket[]>(adaptedSql, adaptedParams as any);
    for (const row of rows)
      callback(row as T);
    return rows.length;
  }

  override async exec(sql: string): Promise<void> {
    await this.connection.execute(sql);
  }

  override prepare(_sql: string, ..._params: unknown[]): Promise<AsyncStatement> {
    throw new Error('Not implemented');
  }
}
