import { defineStore } from 'pinia'
import { computed, ref, shallowRef, triggerRef } from 'vue'
import { db, readUiPrefs, writeUiPrefs } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { runShelfMutation } from '@/utils/shelfTransaction'
import {
  createEmptyShelfFilter,
  TEMP_ZONES,
  type Shelf,
  type ShelfAssignResult,
  type ShelfFilterState,
  type ShelfOccupancy,
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
 * 乐观占位：提交前在本标签页先扣一块余量，防止同一页连续点击/两个弹窗重复选择同一格。
 * 跨标签页的真实互斥由 IndexedDB 事务保证；占位失败（事务中止）时必须调用 releaseHold 释放。
 */
export interface ShelfHold {
  shelfId: string
  /** 换架时原窖位，释放占位时无需处理原窖位（真实释放由事务完成），仅用于调试与提示 */
  batchId: string
}

/**
 * 熟成库窖位 store：维护货架列表、占用率派生值、当前选中库房、上/换/下架动作与本页占位。
 * 占用率以批次表中真实挂接数为准；上 / 换 / 下架统一走 utils/shelfTransaction 的串行化事务。
 */
export const useShelfStore = defineStore('shelf', () => {
  const shelvesTable = useIdbTable<Shelf>((database) => database.shelves, {
    sortByUpdatedAt: false
  })
  const milkStore = useMilkStore()

  const prefs = readUiPrefs()
  const filter = ref<ShelfFilterState>(createEmptyShelfFilter())
  const currentRoom = ref<string>(prefs.lastRoom ?? '')
  const currentShelfId = ref<string | null>(null)

  /** 本标签页已预占、等待事务提交确认的窖位格（非响应式容器 + version 触发派生重算） */
  const holds = shallowRef<Map<string, ShelfHold>>(new Map())
  const holdsVersion = ref(0)

  const shelves = computed<Shelf[]>(() => shelvesTable.rows.value)
  const loading = computed(() => shelvesTable.loading.value)
  const ready = computed(() => shelvesTable.ready.value)
  const error = computed(() => shelvesTable.error.value)

  /** 库房选项（含「未指定」的空字符串过滤语义） */
  const roomOptions = computed<string[]>(() =>
    Array.from(new Set(shelves.value.map((shelf) => shelf.room))).sort()
  )

  /** 某窖位上的批次（以批次表当前挂接为准） */
  function batchesOfShelf(shelfId: string): Batch[] {
    return milkStore.batches.filter((batch) => batch.shelfId === shelfId)
  }

  /**
   * 占用率：occupied（真实挂接批次数）/ held（本页占位）/ free（真实余量）。
   * occupied 直接取批次挂接数——shelf.occupied 只是缓存，看板不再用它参与余量计算，
   * 只用来发现「少算一块」这类计数漂移并给出冲突标记。
   */
  const occupancies = computed<ShelfOccupancy[]>(() => {
    // 依赖 holdsVersion，使占位获取/释放后派生值重算
    void holdsVersion.value
    return shelves.value.map((shelf) => {
      const hosted = milkStore.batches.filter((batch) => batch.shelfId === shelf.id).length
      const held = holds.value.has(shelf.id) ? 1 : 0
      const effective = hosted + held
      const free = Math.max(0, shelf.capacity - effective)
      const percent =
        shelf.capacity === 0 ? 100 : Math.min(100, Math.round((effective / shelf.capacity) * 100))
      const overCapacity = hosted > shelf.capacity
      const drift = shelf.occupied !== hosted
      return {
        shelfId: shelf.id,
        capacity: shelf.capacity,
        occupied: hosted,
        held,
        free,
        percent,
        full: free === 0,
        tight: percent >= 85 && !overCapacity,
        overCapacity,
        drift,
        conflict: overCapacity || drift
      }
    })
  })

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
      (sum, shelf) => sum + (occupancyMap.value[shelf.id]?.occupied ?? 0),
      0
    )
  )
  const occupancyPercent = computed(() =>
    totalCapacity.value === 0 ? 0 : Math.round((totalOccupied.value / totalCapacity.value) * 100)
  )
  const fullShelfCount = computed(
    () => filteredShelves.value.filter((shelf) => occupancyMap.value[shelf.id]?.full).length
  )
  /** 存在冲突（超占 / 计数漂移）的窖位数，供看板顶部告警 */
  const conflictShelfCount = computed(
    () => filteredShelves.value.filter((shelf) => occupancyMap.value[shelf.id]?.conflict).length
  )
  const conflictShelves = computed<Shelf[]>(() =>
    filteredShelves.value.filter((shelf) => occupancyMap.value[shelf.id]?.conflict)
  )
  /** 未上架的批次（可分配窖位） */
  const unassignedBatches = computed<Batch[]>(() =>
    milkStore.batches.filter(
      (batch) => !batch.shelfId && batch.state !== '已出库' && batch.state !== '报废'
    )
  )
  /** 已上架、可换架的批次（终态批次不允许再换架） */
  const assignedBatches = computed<Batch[]>(() =>
    milkStore.batches.filter(
      (batch) => batch.shelfId && batch.state !== '已出库' && batch.state !== '报废'
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

  // ── 乐观占位 ───────────────────────────────────────────────────
  /**
   * 占位：提交事务前在本页先扣一块目标窖位余量。
   * 已被本页其它弹窗占位或真实余量不足时返回 null（调用方据此提示并保留选择）。
   */
  function acquireHold(shelfId: string, batchId: string): ShelfHold | null {
    const occupancy = occupancyMap.value[shelfId]
    if (!occupancy) return null
    if (holds.value.has(shelfId)) return null
    if (occupancy.occupied >= occupancy.capacity) return null
    const hold: ShelfHold = { shelfId, batchId }
    const next = new Map(holds.value)
    next.set(shelfId, hold)
    holds.value = next
    holdsVersion.value += 1
    triggerRef(holds)
    return hold
  }

  /** 释放占位：事务失败 / 取消 / 关闭弹窗时必须调用，失败操作不允许占着余量 */
  function releaseHold(shelfId: string): void {
    if (!holds.value.has(shelfId)) return
    const next = new Map(holds.value)
    next.delete(shelfId)
    holds.value = next
    holdsVersion.value += 1
    triggerRef(holds)
  }

  /** 释放全部占位（页面卸载、弹窗重置兜底） */
  function releaseAllHolds(): void {
    if (holds.value.size === 0) return
    holds.value = new Map()
    holdsVersion.value += 1
    triggerRef(holds)
  }

  function isHeld(shelfId: string): boolean {
    return holds.value.has(shelfId)
  }

  async function createShelf(payload: NewShelfInput): Promise<Shelf> {
    return shelvesTable.create({ ...payload }, 'shelf')
  }

  async function updateShelf(id: string, patch: Partial<Shelf>): Promise<void> {
    await shelvesTable.update(id, patch)
  }

  /** 级联删除：窖位 → 解除批次挂接（批次本身保留）；占用占位一并清理 */
  async function removeShelf(id: string): Promise<void> {
    await db.transaction('rw', [db.shelves, db.batches], async () => {
      const hosted = await db.batches.where('shelfId').equals(id).toArray()
      const now = Date.now()
      for (const batch of hosted) {
        await db.batches.update(batch.id, { shelfId: null, updatedAt: now })
      }
      await db.shelves.delete(id)
    })
    releaseHold(id)
    if (currentShelfId.value === id) currentShelfId.value = null
  }

  /**
   * 上架 / 换架统一入口：乐观占位 → 串行化事务内重新核对容量与批次当前位置 →
   * 成功保留占位（提交即真实占用，本页占位被真实数据覆盖）；失败释放占位并回传冲突码。
   *
   * @param batchId          批次 id
   * @param targetShelfId    目标窖位 id
   * @param expectedShelfId  提交者看到的批次当前位置：上架传 null，换架传原窖位 id；
   *                         缺省取 store 中该批次的当前挂接
   */
  async function assignBatch(
    batchId: string,
    targetShelfId: string,
    expectedShelfId?: string | null
  ): Promise<ShelfAssignResult> {
    const batch = milkStore.batches.find((item) => item.id === batchId)
    if (!batch) return { ok: false, message: '批次不存在，请刷新后重试', code: 'BATCH_NOT_FOUND' }
    if (batch.state === '已出库' || batch.state === '报废') {
      return { ok: false, message: `批次状态为「${batch.state}」，不能再上架`, code: 'BATCH_TERMINAL' }
    }
    if (batch.shelfId === targetShelfId) {
      return { ok: false, message: '该批次已在此窖位上', code: 'ALREADY_HERE' }
    }
    const fromShelfId = expectedShelfId === undefined ? batch.shelfId : expectedShelfId

    const hold = acquireHold(targetShelfId, batchId)
    if (!hold) {
      const occupancy = occupancyMap.value[targetShelfId]
      return {
        ok: false,
        message: occupancy
          ? `${shelfLabel(targetShelfId)} 已无余量或已被本页另一个上架操作占位（${occupancy.occupied}/${occupancy.capacity}），请改选窖位`
          : '目标窖位不存在，请刷新后重试',
        code: 'CAPACITY_TAKEN',
        occupied: occupancy?.occupied,
        capacity: occupancy?.capacity,
        movedTo: batch.shelfId
      }
    }

    const result = await runShelfMutation({
      batchId,
      targetShelfId,
      expectedShelfId: fromShelfId
    })

    // 无论成功失败都释放本页占位：成功后真实挂接数已经 +1，占位继续挂着会重复扣减
    releaseHold(targetShelfId)
    return result
  }

  /** 换架语义别名，语义上 expectedShelfId 必传（打开换架弹窗时的原窖位） */
  async function reassignBatch(
    batchId: string,
    targetShelfId: string,
    expectedShelfId: string
  ): Promise<ShelfAssignResult> {
    return assignBatch(batchId, targetShelfId, expectedShelfId)
  }

  /** 下架：事务内重新核对批次当前位置，确认仍挂在提交者看到的窖位才释放 */
  async function releaseBatch(
    batchId: string,
    expectedShelfId?: string | null
  ): Promise<ShelfAssignResult> {
    const batch = milkStore.batches.find((item) => item.id === batchId)
    if (!batch) return { ok: false, message: '批次不存在，请刷新后重试', code: 'BATCH_NOT_FOUND' }
    if (!batch.shelfId) return { ok: false, message: '该批次尚未上架', code: 'NOT_ASSIGNED' }
    const fromShelfId = expectedShelfId === undefined ? batch.shelfId : expectedShelfId
    return runShelfMutation({ batchId, targetShelfId: null, expectedShelfId: fromShelfId })
  }

  /** 按温区阈值给出窖位可用性说明，用于卡片提示 */
  function zoneOptions(): TempZone[] {
    return TEMP_ZONES
  }

  return {
    shelves,
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
    conflictShelfCount,
    conflictShelves,
    unassignedBatches,
    assignedBatches,
    occupancyOf,
    shelfLabel,
    batchesOfShelf,
    setCurrentRoom,
    setCurrentShelf,
    patchFilter,
    resetFilter,
    acquireHold,
    releaseHold,
    releaseAllHolds,
    isHeld,
    createShelf,
    updateShelf,
    removeShelf,
    assignBatch,
    reassignBatch,
    releaseBatch,
    zoneOptions
  }
})

export type ShelfStore = ReturnType<typeof useShelfStore>
