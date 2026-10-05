import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, readUiPrefs, writeUiPrefs } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  createEmptyShelfFilter,
  TEMP_ZONES,
  type Shelf,
  type ShelfAssignResult,
  type ShelfFilterState,
  type ShelfOccupancy,
  type ShelfOp,
  type ShelfOpType,
  type TempZone
} from '@/types/shelf'
import type { Batch } from '@/types/batch'
import { useMilkStore } from '@/stores/milkStore'

export interface NewShelfInput {
  room: string
  rackNo: string
  layerNo: number
  tempZone: TempZone
  capacity: number
  occupied: number
}

/**
 * 熟成库窖位 store：维护货架列表、占用率派生值、当前选中库房与上架分配。
 * 上架 / 换架 / 下架统一走 runShelfOp 事务：提交时在事务内重新核对容量与批次当前位置，
 * 容量被抢则置 conflict 释放占位，后提交者保留原选择并展示冲突。
 */
export const useShelfStore = defineStore('shelf', () => {
  const shelvesTable = useIdbTable<Shelf>((database) => database.shelves, {
    sortByUpdatedAt: false
  })
  const opsTable = useIdbTable<ShelfOp>((database) => database.ops, {
    sortByUpdatedAt: false
  })
  const milkStore = useMilkStore()

  const prefs = readUiPrefs()
  const filter = ref<ShelfFilterState>(createEmptyShelfFilter())
  const currentRoom = ref<string>(prefs.lastRoom ?? '')
  const currentShelfId = ref<string | null>(null)

  const shelves = computed<Shelf[]>(() => shelvesTable.rows.value)
  const ops = computed<ShelfOp[]>(() => opsTable.rows.value)
  const loading = computed(() => shelvesTable.loading.value)
  const ready = computed(() => shelvesTable.ready.value)
  const error = computed(() => shelvesTable.error.value)

  /** 占位有效期：60 秒，超时未完成的 held 占位自动失效（防标签页关闭后泄漏余量） */
  const HOLD_TTL_MS = 60_000

  /** 当前仍有效的 held 占位（未过期），提交时锁定目标窖位余量 */
  const heldOps = computed<ShelfOp[]>(() => {
    const now = Date.now()
    return ops.value.filter((op) => op.status === 'held' && op.expiresAt > now)
  })

  /** 未关闭的冲突记录（容量被抢或批次位置已变），供批次台账与看板展示冲突状态 */
  const conflictOps = computed<ShelfOp[]>(() =>
    ops.value
      .filter((op) => op.status === 'conflict')
      .sort((a, b) => b.updatedAt - a.updatedAt)
  )

  /** 存在未关闭冲突的批次 id 集合 */
  const conflictBatchIds = computed<Set<string>>(() => {
    const ids = new Set<string>()
    conflictOps.value.forEach((op) => ids.add(op.batchId))
    return ids
  })

  /** 库房选项（含「未指定」的空字符串过滤语义） */
  const roomOptions = computed<string[]>(() =>
    Array.from(new Set(shelves.value.map((shelf) => shelf.room))).sort()
  )

  /** 某窖位上的批次 */
  function batchesOfShelf(shelfId: string): Batch[] {
    return milkStore.batches.filter((batch) => batch.shelfId === shelfId)
  }

  /**
   * 占用率：以「实际挂接的批次数」为底数，并计入 held 占位锁定的余量，
   * 让看板显示真实余量（含其他标签页正在提交的占位），避免超占。
   */
  const occupancies = computed<ShelfOccupancy[]>(() =>
    shelves.value.map((shelf) => {
      const hosted = batchesOfShelf(shelf.id).length
      const held = heldOps.value.filter(
        (op) => op.shelfId === shelf.id && (op.op === 'assign' || op.op === 'change')
      ).length
      const occupied = Math.max(shelf.occupied, hosted) + held
      const free = Math.max(0, shelf.capacity - occupied)
      const percent = shelf.capacity === 0 ? 100 : Math.round((occupied / shelf.capacity) * 100)
      return {
        shelfId: shelf.id,
        capacity: shelf.capacity,
        occupied,
        free,
        percent,
        full: free === 0,
        tight: percent >= 85
      }
    })
  )

  const occupancyMap = computed<Record<string, ShelfOccupancy>>(() => {
    const map: Record<string, ShelfOccupancy> = {}
    occupancies.value.forEach((item) => {
      map[item.shelfId] = item
    })
    return map
  })

  /** 当前选中库房下的窖位 */
  const roomShelves = computed<Shelf[]>(() =>
    currentRoom.value ? shelves.value.filter((shelf) => shelf.room === currentRoom.value) : shelves.value
  )

  const filteredShelves = computed<Shelf[]>(() =>
    shelves.value.filter((shelf) => {
      if (currentRoom.value && shelf.room !== currentRoom.value) return false
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${shelf.room}${shelf.rackNo}${shelf.layerNo}${shelf.tempZone}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.rooms.length > 0 && !filter.value.rooms.includes(shelf.room)) return false
      if (filter.value.tempZones.length > 0 && !filter.value.tempZones.includes(shelf.tempZone)) {
        return false
      }
      return true
    })
  )

  const totalCapacity = computed(() =>
    filteredShelves.value.reduce((sum, shelf) => sum + shelf.capacity, 0)
  )
  const totalOccupied = computed(() =>
    filteredShelves.value.reduce(
      (sum, shelf) => sum + (occupancyMap.value[shelf.id]?.occupied ?? shelf.occupied),
      0
    )
  )
  const occupancyPercent = computed(() =>
    totalCapacity.value === 0 ? 0 : Math.round((totalOccupied.value / totalCapacity.value) * 100)
  )
  const fullShelfCount = computed(
    () => filteredShelves.value.filter((shelf) => occupancyMap.value[shelf.id]?.full).length
  )
  /** 未上架的批次（可分配窖位） */
  const unassignedBatches = computed<Batch[]>(() =>
    milkStore.batches.filter(
      (batch) => !batch.shelfId && batch.state !== '已出库' && batch.state !== '报废'
    )
  )

  function occupancyOf(shelfId: string | null): ShelfOccupancy | null {
    if (!shelfId) return null
    return occupancyMap.value[shelfId] ?? null
  }

  function shelfLabel(shelfId: string | null): string {
    if (!shelfId) return '未上架'
    const shelf = shelves.value.find((item) => item.id === shelfId)
    if (!shelf) return '窖位已删除'
    return `${shelf.room} ${shelf.rackNo} 第 ${shelf.layerNo} 层`
  }

  function setCurrentRoom(room: string): void {
    currentRoom.value = room
    writeUiPrefs({ ...readUiPrefs(), lastRoom: room || null })
  }

  function setCurrentShelf(id: string | null): void {
    currentShelfId.value = id
  }

  function patchFilter(patch: Partial<ShelfFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyShelfFilter()
  }

  async function createShelf(payload: NewShelfInput): Promise<Shelf> {
    return shelvesTable.create({ ...payload }, 'shelf')
  }

  async function updateShelf(id: string, patch: Partial<Shelf>): Promise<void> {
    await shelvesTable.update(id, patch)
  }

  /** 级联删除：窖位 → 解除批次挂接（批次本身保留） */
  async function removeShelf(id: string): Promise<void> {
    await db.transaction('rw', [db.shelves, db.batches], async () => {
      const hosted = await db.batches.where('shelfId').equals(id).toArray()
      for (const batch of hosted) {
        await db.batches.update(batch.id, { shelfId: null, updatedAt: Date.now() })
      }
      await db.shelves.delete(id)
    })
    if (currentShelfId.value === id) currentShelfId.value = null
  }

  /**
   * 统一的窖位操作事务：上架 / 换架 / 下架共用同一套核对逻辑。
   *
   * 阶段 1（占位）：在事务内重新读取批次当前位置与窖位余量，核对通过后写入一条
   *   held 占位锁定目标窖位余量（其他标签页据此看到真实余量）；核对失败直接返回冲突。
   * 阶段 2（核对回写）：在事务内再次核对批次当前位置与窖位余量，通过则回写批次 shelfId
   *   并重算受影响窖位的 occupied，占位置 done；失败则置 conflict 释放占位，
   *   调用方保留原选择并展示冲突。
   */
  async function runShelfOp(input: {
    batchId: string
    op: ShelfOpType
    targetShelfId: string | null
  }): Promise<ShelfAssignResult> {
    const { batchId, op } = input
    const targetShelfId = input.targetShelfId

    const batch = milkStore.batches.find((item) => item.id === batchId)
    if (!batch) return { ok: false, conflict: false, message: '批次不存在，请刷新后重试' }
    if (batch.state === '已出库' || batch.state === '报废') {
      return {
        ok: false,
        conflict: false,
        message: `批次状态为「${batch.state}」，不能${op === 'release' ? '下架' : '上架'}`
      }
    }

    const now = Date.now()
    const opId = createId('shelfop')

    // 目标窖位（上架 / 换架）或原窖位（下架）
    let shelfId: string
    let fromShelfId: string | null = null
    if (op === 'release') {
      if (!batch.shelfId) return { ok: false, conflict: false, message: '该批次尚未上架' }
      shelfId = batch.shelfId
    } else {
      if (!targetShelfId) return { ok: false, conflict: false, message: '请选择目标窖位' }
      const target = shelves.value.find((item) => item.id === targetShelfId)
      if (!target) return { ok: false, conflict: false, message: '目标窖位不存在，请刷新后重试' }
      shelfId = targetShelfId
      if (op === 'change') fromShelfId = batch.shelfId
    }

    /** 事务内核对批次当前位置是否与操作预期一致 */
    function expectBatchPosition(liveBatch: Batch): string | null {
      if (liveBatch.state === '已出库' || liveBatch.state === '报废') {
        return `批次状态为「${liveBatch.state}」，不能操作`
      }
      if (op === 'assign' && liveBatch.shelfId) {
        return `该批次已在 ${shelfLabel(liveBatch.shelfId)}，请改用换架或先下架`
      }
      if (op === 'change' && !liveBatch.shelfId) {
        return '该批次尚未上架，无法换架，请先上架'
      }
      if (op === 'change' && liveBatch.shelfId !== fromShelfId) {
        return `批次当前位置已变为 ${shelfLabel(liveBatch.shelfId)}，原选择已失效`
      }
      if (op === 'release' && !liveBatch.shelfId) {
        return '该批次已被其他操作下架'
      }
      if (op === 'release' && liveBatch.shelfId !== shelfId) {
        return '批次当前位置已变化，下架失败'
      }
      return null
    }

    /** 事务内核对目标窖位余量（实际挂接批次 + 其他 held 占位），返回冲突文案或 null */
    async function expectCapacity(
      liveShelfId: string,
      excludeOpId: string
    ): Promise<{
      conflict: boolean
      message: string
      shelfId: string
      free: number
      capacity: number
      occupied: number
    } | null> {
      const liveShelf = await db.shelves.get(liveShelfId)
      if (!liveShelf) {
        return {
          conflict: false,
          message: '目标窖位不存在，请刷新后重试',
          shelfId: liveShelfId,
          free: 0,
          capacity: 0,
          occupied: 0
        }
      }
      const hosted = await db.batches.where('shelfId').equals(liveShelfId).count()
      const held = await db.ops
        .where('shelfId')
        .equals(liveShelfId)
        .filter(
          (item) =>
            item.status === 'held' &&
            item.expiresAt > now &&
            item.id !== excludeOpId &&
            (item.op === 'assign' || item.op === 'change')
        )
        .count()
      const occupied = hosted + held
      if (occupied >= liveShelf.capacity) {
        return {
          conflict: true,
          message: `${liveShelf.room} ${liveShelf.rackNo} 第 ${liveShelf.layerNo} 层余量已被抢走（${occupied}/${liveShelf.capacity}），请改选窖位或稍后重试`,
          shelfId: liveShelfId,
          free: Math.max(0, liveShelf.capacity - occupied),
          capacity: liveShelf.capacity,
          occupied
        }
      }
      return null
    }

    // 阶段 1：创建 held 占位（事务内核对容量与批次位置）
    const holdConflict = await db.transaction('rw', [db.shelves, db.batches, db.ops], async () => {
      const liveBatch = await db.batches.get(batchId)
      if (!liveBatch) return { message: '批次不存在，请刷新后重试', conflict: false }
      const positionError = expectBatchPosition(liveBatch)
      if (positionError) return { message: positionError, conflict: true }

      if (op !== 'release') {
        const capacityError = await expectCapacity(shelfId, opId)
        if (capacityError) return { ...capacityError }
      }

      const hold: ShelfOp = {
        id: opId,
        batchId,
        op,
        shelfId,
        fromShelfId,
        status: 'held',
        message: '',
        createdAt: now,
        updatedAt: now,
        expiresAt: now + HOLD_TTL_MS
      }
      await db.ops.put(hold)
      return null
    })

    if (holdConflict) {
      return {
        ok: false,
        conflict: holdConflict.conflict,
        message: holdConflict.message,
        ...('shelfId' in holdConflict
          ? {
              shelfId: holdConflict.shelfId,
              free: holdConflict.free,
              capacity: holdConflict.capacity,
              occupied: holdConflict.occupied
            }
          : {})
      }
    }

    // 阶段 2：事务内重新核对并回写批次位置
    const finalConflict = await db.transaction('rw', [db.shelves, db.batches, db.ops], async () => {
      const liveBatch = await db.batches.get(batchId)
      if (!liveBatch) return { message: '批次不存在，请刷新后重试', conflict: false }
      const positionError = expectBatchPosition(liveBatch)
      if (positionError) return { message: positionError, conflict: true }

      if (op !== 'release') {
        const capacityError = await expectCapacity(shelfId, opId)
        if (capacityError) return { ...capacityError }
      }

      // 核对通过：回写批次 shelfId
      const nextShelfId = op === 'release' ? null : shelfId
      await db.batches.update(batchId, {
        shelfId: nextShelfId,
        state: liveBatch.state === '凝乳' && op !== 'release' ? '熟成中' : liveBatch.state,
        updatedAt: now
      })

      // 重算受影响窖位的 occupied（以实际挂接批次数为准）
      const affectedShelfIds = new Set<string>()
      if (fromShelfId) affectedShelfIds.add(fromShelfId)
      if (nextShelfId) affectedShelfIds.add(nextShelfId)
      if (op === 'release') affectedShelfIds.add(shelfId)
      for (const sid of affectedShelfIds) {
        const s = await db.shelves.get(sid)
        if (s) {
          const hosted = await db.batches.where('shelfId').equals(sid).count()
          await db.shelves.update(sid, { occupied: Math.min(s.capacity, hosted), updatedAt: now })
        }
      }

      // 占位置 done
      await db.ops.update(opId, { status: 'done', message: '', updatedAt: now })
      return null
    })

    if (finalConflict) {
      // 核对失败：占位置 conflict 释放余量
      await db.ops.update(opId, {
        status: 'conflict',
        message: finalConflict.message,
        updatedAt: now
      })
      return {
        ok: false,
        conflict: true,
        message: finalConflict.message,
        ...('shelfId' in finalConflict
          ? {
              shelfId: finalConflict.shelfId,
              free: finalConflict.free,
              capacity: finalConflict.capacity,
              occupied: finalConflict.occupied
            }
          : {})
      }
    }

    const targetLabel = shelfLabel(shelfId)
    return {
      ok: true,
      conflict: false,
      message:
        op === 'assign'
          ? `已上架至 ${targetLabel}`
          : op === 'change'
            ? `已换架至 ${targetLabel}`
            : `已下架，${targetLabel} 释放 1 块余量`
    }
  }

  /**
   * 上架 / 换架：批次未上架时上架，已在别的窖位时换架。
   * 统一走 runShelfOp 事务，提交时重新核对容量与批次当前位置。
   */
  async function assignBatch(batchId: string, shelfId: string): Promise<ShelfAssignResult> {
    const batch = milkStore.batches.find((item) => item.id === batchId)
    if (!batch) return { ok: false, conflict: false, message: '批次不存在，请刷新后重试' }
    return runShelfOp({ batchId, op: batch.shelfId ? 'change' : 'assign', targetShelfId: shelfId })
  }

  /** 换架：把批次从当前窖位换到目标窖位（显式调用） */
  async function changeBatch(batchId: string, targetShelfId: string): Promise<ShelfAssignResult> {
    return runShelfOp({ batchId, op: 'change', targetShelfId })
  }

  /** 下架：释放窖位占用并清空批次 shelfId，走同一套事务核对批次当前位置 */
  async function releaseBatch(batchId: string): Promise<ShelfAssignResult> {
    return runShelfOp({ batchId, op: 'release', targetShelfId: null })
  }

  /** 关闭冲突提示：把 conflict 占位置为 cancelled，批次台账不再展示冲突标记 */
  async function dismissConflict(opId: string): Promise<void> {
    await db.ops.update(opId, { status: 'cancelled', updatedAt: Date.now() })
  }

  /** 清理过期的 held 占位与很久以前的冲突记录，避免表膨胀 */
  async function purgeExpiredOps(): Promise<void> {
    const now = Date.now()
    const staleConflict = now - 24 * 60 * 60 * 1000
    await db.transaction('rw', db.ops, async () => {
      await db.ops
        .filter(
          (op) =>
            (op.status === 'held' && op.expiresAt <= now) ||
            (op.status === 'conflict' && op.updatedAt < staleConflict)
        )
        .delete()
    })
  }

  /** 批次是否存在未关闭的冲突 */
  function batchHasConflict(batchId: string): boolean {
    return conflictBatchIds.value.has(batchId)
  }

  /** 批次最近一条未关闭的冲突记录 */
  function batchConflictOf(batchId: string): ShelfOp | null {
    return conflictOps.value.find((op) => op.batchId === batchId) ?? null
  }

  // 启动时清理过期的 held 占位与很久以前的冲突记录，避免表膨胀
  void purgeExpiredOps()

  /** 按温区阈值给出窖位可用性说明，用于卡片提示 */
  function zoneOptions(): TempZone[] {
    return TEMP_ZONES
  }

  return {
    shelves,
    ops,
    heldOps,
    conflictOps,
    conflictBatchIds,
    loading,
    ready,
    error,
    filter,
    currentRoom,
    currentShelfId,
    roomOptions,
    occupancies,
    occupancyMap,
    roomShelves,
    filteredShelves,
    totalCapacity,
    totalOccupied,
    occupancyPercent,
    fullShelfCount,
    unassignedBatches,
    occupancyOf,
    shelfLabel,
    batchesOfShelf,
    setCurrentRoom,
    setCurrentShelf,
    patchFilter,
    resetFilter,
    createShelf,
    updateShelf,
    removeShelf,
    runShelfOp,
    assignBatch,
    changeBatch,
    releaseBatch,
    dismissConflict,
    purgeExpiredOps,
    batchHasConflict,
    batchConflictOf,
    zoneOptions
  }
})

export type ShelfStore = ReturnType<typeof useShelfStore>
