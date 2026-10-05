/**
 * 并发上架冲突测试：模拟两个标签页同时提交批次上架到只剩一格的窖位。
 * 验证：只有一个成功，另一个返回冲突，且最终占用数正确（不超占）。
 */
import 'fake-indexeddb/auto'
import { db, DB_VERSION } from './src/utils/db'
import type { Shelf, ShelfOp } from './src/types/shelf'
import type { Batch } from './src/types/batch'

async function main() {
  await db.open()

  // 准备：一个容量 1、占用 0 的窖位，两个未上架批次
  const now = Date.now()
  const shelf: Shelf = {
    id: 'shelf_test_1',
    room: '测试库',
    rackNo: 'T-01',
    layerNo: 1,
    tempZone: '中温区',
    capacity: 1,
    occupied: 0,
    createdAt: now,
    updatedAt: now
  }
  await db.shelves.put(shelf)

  const batchA: Batch = {
    id: 'batch_a',
    milkId: 'milk_1',
    curdedAt: '2025-03-01',
    cheeseType: '硬质',
    targetDays: 60,
    weightKg: 10,
    state: '熟成中',
    shelfId: null,
    conclusion: '',
    createdAt: now,
    updatedAt: now
  }
  const batchB: Batch = { ...batchA, id: 'batch_b' }
  await db.batches.bulkPut([batchA, batchB])

  // 模拟 runShelfOp 的核心逻辑（两阶段事务）
  async function runShelfOp(batchId: string, targetShelfId: string) {
    const opId = `op_${Math.random().toString(36).slice(2, 8)}`
    const ts = Date.now()

    // 阶段 1：占位
    const holdConflict = await db.transaction('rw', [db.shelves, db.batches, db.ops], async () => {
      const liveBatch = await db.batches.get(batchId)
      if (!liveBatch || liveBatch.shelfId) return { conflict: true, message: '批次已上架' }
      const liveShelf = await db.shelves.get(targetShelfId)
      if (!liveShelf) return { conflict: false, message: '窖位不存在' }
      const hosted = await db.batches.where('shelfId').equals(targetShelfId).count()
      const held = await db.ops
        .where('shelfId')
        .equals(targetShelfId)
        .filter(
          (item) =>
            item.status === 'held' &&
            item.expiresAt > ts &&
            item.id !== opId &&
            (item.op === 'assign' || item.op === 'change')
        )
        .count()
      const occupied = hosted + held
      if (occupied >= liveShelf.capacity) {
        return { conflict: true, message: `容量被抢（${occupied}/${liveShelf.capacity}）` }
      }
      const hold: ShelfOp = {
        id: opId,
        batchId,
        op: 'assign',
        shelfId: targetShelfId,
        fromShelfId: null,
        status: 'held',
        message: '',
        createdAt: ts,
        updatedAt: ts,
        expiresAt: ts + 60000
      }
      await db.ops.put(hold)
      return null
    })

    if (holdConflict) return { ok: false, conflict: holdConflict.conflict, message: holdConflict.message }

    // 阶段 2：核对回写
    const finalConflict = await db.transaction('rw', [db.shelves, db.batches, db.ops], async () => {
      const liveBatch = await db.batches.get(batchId)
      if (!liveBatch || liveBatch.shelfId) return { conflict: true, message: '批次已上架' }
      const liveShelf = await db.shelves.get(targetShelfId)
      if (!liveShelf) return { conflict: false, message: '窖位不存在' }
      const hosted = await db.batches.where('shelfId').equals(targetShelfId).count()
      const held = await db.ops
        .where('shelfId')
        .equals(targetShelfId)
        .filter(
          (item) =>
            item.status === 'held' &&
            item.expiresAt > ts &&
            item.id !== opId &&
            (item.op === 'assign' || item.op === 'change')
        )
        .count()
      const occupied = hosted + held
      if (occupied >= liveShelf.capacity) {
        return { conflict: true, message: `容量被抢（${occupied}/${liveShelf.capacity}）` }
      }
      await db.batches.update(batchId, { shelfId: targetShelfId, updatedAt: ts })
      const newHosted = await db.batches.where('shelfId').equals(targetShelfId).count()
      await db.shelves.update(targetShelfId, {
        occupied: Math.min(liveShelf.capacity, newHosted),
        updatedAt: ts
      })
      await db.ops.update(opId, { status: 'done', updatedAt: ts })
      return null
    })

    if (finalConflict) {
      await db.ops.update(opId, { status: 'conflict', message: finalConflict.message, updatedAt: ts })
      return { ok: false, conflict: true, message: finalConflict.message }
    }
    return { ok: true, conflict: false, message: '已上架' }
  }

  // 并发提交：两个标签页同时上架到同一窖位
  const [resultA, resultB] = await Promise.all([
    runShelfOp('batch_a', 'shelf_test_1'),
    runShelfOp('batch_b', 'shelf_test_1')
  ])

  console.log('批次 A 结果:', resultA)
  console.log('批次 B 结果:', resultB)

  // 验证
  const finalShelf = await db.shelves.get('shelf_test_1')
  const finalHosted = await db.batches.where('shelfId').equals('shelf_test_1').count()
  const conflictOps = await db.ops.filter((op) => op.status === 'conflict').toArray()
  const doneOps = await db.ops.filter((op) => op.status === 'done').toArray()

  console.log('最终窖位 occupied:', finalShelf?.occupied, '实际挂接:', finalHosted)
  console.log('done 占位数:', doneOps.length, 'conflict 占位数:', conflictOps.length)

  const oneSucceeded = resultA.ok !== resultB.ok
  const noOverOccupy = finalHosted <= (finalShelf?.capacity ?? 0)
  const occupiedMatches = finalShelf?.occupied === finalHosted

  console.log('\n--- 验证结果 ---')
  console.log('只有一个成功:', oneSucceeded ? 'PASS' : 'FAIL')
  console.log('不超占:', noOverOccupy ? 'PASS' : 'FAIL')
  console.log('占用数与实际一致:', occupiedMatches ? 'PASS' : 'FAIL')

  if (oneSucceeded && noOverOccupy && occupiedMatches) {
    console.log('\n✅ 并发上架冲突测试通过')
  } else {
    console.log('\n❌ 测试失败')
    process.exit(1)
  }

  await db.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
