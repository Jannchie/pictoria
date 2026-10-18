/**
 * 读线程池能调的函数：**唯一**的登记处。
 *
 * `inProcessReads`、`createReadPool` 返回的方法对象、读线程的分派表都从这一张表生成，
 * 加一个函数只改这里。它同时是白名单：读线程只认这里的自有键（`read-worker.ts`），
 * 所以池子不是一个任意执行器。登记的必须是只读查询 —— 线程的连接是
 * `SQLITE_OPEN_READONLY`，会写的函数在那边会当场报错。
 */
import type { SqliteHandle } from '@pictoria/db'
import { knn, searchByTextVector } from '@pictoria/db'

export const READ_FNS = { knn, searchByTextVector } satisfies Record<string, (db: SqliteHandle, ...args: any[]) => unknown>

export type ReadFnName = keyof typeof READ_FNS

/** 去掉第一个参数（连接）之后的参数表。可选参数保持可选。 */
export type ReadArgs<K extends ReadFnName> = Parameters<typeof READ_FNS[K]> extends [unknown, ...infer R] ? R : never

export type ReadResult<K extends ReadFnName> = ReturnType<typeof READ_FNS[K]>

export const READ_FN_NAMES = Object.keys(READ_FNS) as ReadFnName[]
