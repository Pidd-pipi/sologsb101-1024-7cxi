import { db } from '@/utils/db'
import type { Batch } from '@/types/batch'
import type { Shelf, ShelfAssignResult, ShelfConflictCode } from '@/types/shelf'

export interface ShelfMutationInput {
  batchId: string
  /** 目标窖位：上架/换架必填；下架时为 null */
  targetShelfId: string | null
  /**
   * 提交者打开表单时看到的批次所在窖位（事务提交前重新核对批次当前位置用）。
   * 上架（未上架批次）传 null；换架传原窖位 id；下架传当前所在窖位 id。
   */
  expectedShelfId: string | null
}

/**
 * 窖位变更事务的统一入口：上架 / 换架 / 下架共用同一套事务。
 *
 * 关键并发语义（IndexedDB readwrite 事务按表范围在所有连接/标签页间串行化）：
 * 1. 容量核对与写入在【同一个 readwrite 事务】内完成——后提交者打开事务时，
 *    必然读到先提交者已提交的挂接结果，因此「只剩一格、两个标签页同时上架」时
 *    后提交者会在事务内拿到真实占用并判定容量被抢走，事务直接中止、不写入任何数据。
 * 2. 提交前重新核对批次当前位置（batch.shelfId === expectedShelfId），
 *    被别的标签页抢先换架/下架时返回 BATCH_MOVED，本次占位随事务中止自动释放。
 * 3. 占用数不做自增，而是按事务内「实际仍挂接在窖位上的批次数」重算，
 *    从根上消除 occupied 少算 / 多算的漂移。
 */
export async function runShelfMutation(input: ShelfMutationInput): Promise<ShelfAssignResult> {
  const { batchId, targetShelfId, expectedShelfId } = input

  // 事务外只做存在性预检（给出友好文案）；真正的容量与位置核对全部在事务内
  const [batchRow, targetRow] = await Promise.all([
    db.batches.get(batchId),
    targetShelfId ? db.shelves.get(targetShelfId) : Promise.resolve(undefined)
  ])
  if (!batchRow) {
    return fail('BATCH_NOT_FOUND', '批次不存在或已被删除，请刷新后重试')
  }
  if (targetShelfId && !targetRow) {
    return fail('SHELF_NOT_FOUND', '目标窖位不存在或已被删除，请刷新后改选窖位')
  }
  if (batchRow.state === '已出库' || batchRow.state === '报废') {
    return fail('BATCH_TERMINAL', `批次状态为「${batchRow.state}」，不能再上架或换架`)
  }

  try {
    return await db.transaction('rw', [db.shelves, db.batches], async () => {
      // 事务内重新读取最新批次，核对「批次当前位置」是否还是提交者看到的位置
      const liveBatch = await db.batches.get(batchId)
      if (!liveBatch) {
        return fail('BATCH_NOT_FOUND', '批次不存在或已被删除，请刷新后重试')
      }
      const liveTarget = targetShelfId ? await db.shelves.get(targetShelfId) : undefined
      if (targetShelfId && !liveTarget) {
        return fail('SHELF_NOT_FOUND', '目标窖位不存在或已被删除，请刷新后改选窖位')
      }

      const currentShelfId = liveBatch.shelfId
      if (currentShelfId !== expectedShelfId) {
        // 容量 / 位置已被其它标签页（或本页其它操作）抢走：中止事务，保留提交者原选择
        const movedTo = currentShelfId
        if (targetShelfId) {
          const nowAt = currentShelfId ? labelOf(await db.shelves.get(currentShelfId)) : '未上架'
          return fail(
            'BATCH_MOVED',
            `提交前该批次已被换至「${nowAt}」，本次上架未生效，原选择已保留`,
            { movedTo }
          )
        }
        return fail(
          'BATCH_MOVED',
          `提交前该批次已不在原窖位（当前：${
            currentShelfId ? labelOf(await db.shelves.get(currentShelfId)) : '未上架'
          }），下架未生效`,
          { movedTo }
        )
      }

      const now = Date.now()
      const nextState: Batch['state'] = liveBatch.state === '凝乳' ? '熟成中' : liveBatch.state

      // ── 下架 ────────────────────────────────────────────────
      if (!targetShelfId) {
        if (!currentShelfId) {
          return fail('NOT_ON_SHELF', '该批次当前未上架，无需下架')
        }
        const source = await db.shelves.get(currentShelfId)
        await db.batches.update(batchId, { shelfId: null, updatedAt: now })
        if (source) {
          const remaining = await db.batches.where('shelfId').equals(currentShelfId).count()
          await db.shelves.update(source.id, {
            occupied: clamp(remaining, 0, source.capacity),
            updatedAt: now
          })
        }
        return {
          ok: true,
          message: `已下架，${labelOf(source)} 释放 1 块余量`,
          code: null
        }
      }

      // 目标窖位必然存在（前面已核对）
      const target = liveTarget as Shelf

      // ── 已在目标窖位（重复提交）────────────────────────────────
      if (currentShelfId === targetShelfId) {
        return fail('ALREADY_HERE', '该批次已在此窖位上')
      }

      // ── 容量核对：事务内统计目标窖位真实挂接数（此时一定能看到先提交事务的结果）──
      const hosted = await db.batches.where('shelfId').equals(targetShelfId).count()
      if (hosted >= target.capacity) {
        return fail(
          'CAPACITY_TAKEN',
          `${labelOf(target)} 余量已被其他操作占用（实际 ${hosted}/${target.capacity}），本次${
            currentShelfId ? '换架' : '上架'
          }未生效，请改选有余量的窖位`,
          { occupied: hosted, capacity: target.capacity, movedTo: currentShelfId }
        )
      }

      // ── 上架 / 换架：回写批次位置 + 目标窖位 +1（按真实挂接数重算）──
      await db.batches.update(batchId, {
        shelfId: targetShelfId,
        state: nextState,
        updatedAt: now
      })
      const targetHosted = await db.batches.where('shelfId').equals(targetShelfId).count()
      await db.shelves.update(targetShelfId, {
        occupied: clamp(targetHosted, 0, target.capacity),
        updatedAt: now
      })

      // 换架：原窖位释放一块（同样按真实挂接数重算，不做自减）
      if (currentShelfId) {
        const source = await db.shelves.get(currentShelfId)
        if (source) {
          const remaining = await db.batches.where('shelfId').equals(currentShelfId).count()
          await db.shelves.update(source.id, {
            occupied: clamp(remaining, 0, source.capacity),
            updatedAt: now
          })
        }
      }

      return {
        ok: true,
        message: `已${currentShelfId ? '换架至' : '上架至'} ${labelOf(target)}（${targetHosted}/${
          target.capacity
        }）`,
        code: null,
        occupied: targetHosted,
        capacity: target.capacity
      }
    })
  } catch (err) {
    // 事务异常中止：所有写入回滚，占位不会落库
    return {
      ok: false,
      message: `窖位事务已回滚：${err instanceof Error ? err.message : '未知错误'}，请重试`,
      code: 'SHELF_NOT_FOUND'
    }
  }
}

/** 删除批次时在级联事务内释放窖位占用（占用数按真实挂接数重算） */
export async function releaseShelfInTransaction(shelfId: string, now: number): Promise<void> {
  const shelf = await db.shelves.get(shelfId)
  if (!shelf) return
  const remaining = await db.batches.where('shelfId').equals(shelfId).count()
  await db.shelves.update(shelfId, {
    occupied: clamp(remaining, 0, shelf.capacity),
    updatedAt: now
  })
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function labelOf(shelf: Shelf | undefined): string {
  if (!shelf) return '窖位已删除'
  return `${shelf.room} ${shelf.rackNo} 第 ${shelf.layerNo} 层`
}

function fail(code: ShelfConflictCode, message: string, extra?: Partial<ShelfAssignResult>): ShelfAssignResult {
  return { ok: false, message, code, ...extra }
}
