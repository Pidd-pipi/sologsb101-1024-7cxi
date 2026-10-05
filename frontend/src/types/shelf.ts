/**
 * 熟成窖位：库房 → 货架 → 层号三级定位的一个可放奶酪的位置。
 * 占用数（occupied）是「实际挂接批次数」的缓存值，所有上/换/下架事务提交时都会按真实挂接数重算。
 */
export type TempZone = '冷区' | '中温区' | '常温区'

export interface Shelf {
  id: string
  /** 库房名称，如「一号熟成库」 */
  room: string
  /** 货架号 */
  rackNo: string
  /** 层号 */
  layerNo: number
  /** 温区：冷区 / 中温区 / 常温区 */
  tempZone: TempZone
  /** 可放块数 */
  capacity: number
  /** 已占块数（缓存值，事务提交时按批次数重算） */
  occupied: number
  createdAt: number
  updatedAt: number
}

export const TEMP_ZONES: TempZone[] = ['冷区', '中温区', '常温区']

/** 上 / 换 / 下架事务失败的冲突原因，界面按 code 决定是否保留原选择 */
export type ShelfConflictCode =
  | 'SHELF_NOT_FOUND'
  | 'BATCH_NOT_FOUND'
  | 'BATCH_TERMINAL'
  | 'ALREADY_HERE'
  | 'CAPACITY_TAKEN'
  | 'BATCH_MOVED'
  | 'NOT_ON_SHELF'
  | 'NOT_ASSIGNED'

/** 窖位占用率派生值，供 <StatBadge> 与货架看板消费 */
export interface ShelfOccupancy {
  shelfId: string
  capacity: number
  /** 真实占用：当前实际挂接在该窖位上的批次数（以批次表为准，不看 occupied 缓存） */
  occupied: number
  /** 本标签页已占位但尚未提交的块数（乐观锁占位） */
  held: number
  /** 剩余可放块数（扣除本页占位），不会为负 */
  free: number
  /** 占用率百分比 0-100 */
  percent: number
  /** 是否已满 */
  full: boolean
  /** 是否接近满（占用率 ≥ 85%） */
  tight: boolean
  /** 是否超占：真实批次数 > 容量 */
  overCapacity: boolean
  /** 是否存在计数冲突：occupied 缓存与真实挂接数不一致（少算/多算） */
  drift: boolean
  /** 是否需要冲突提示（超占或计数漂移） */
  conflict: boolean
}

/** 上架 / 换架 / 下架操作结果 */
export interface ShelfAssignResult {
  ok: boolean
  message: string
  /** 失败时的冲突原因码；成功为 null */
  code?: ShelfConflictCode | null
  /** 提交时该窖位真实占用 / 容量（冲突提示里回显真实余量用） */
  occupied?: number
  capacity?: number
  /** BATCH_MOVED 时批次当前实际所在窖位 id（null 表示已被下架/抢走） */
  movedTo?: string | null
}

/** 窖位页筛选条件：关键字 + 库房多选 + 温区多选 */
export interface ShelfFilterState {
  keyword: string
  rooms: string[]
  tempZones: TempZone[]
}

export function createEmptyShelfFilter(): ShelfFilterState {
  return {
    keyword: '',
    rooms: [],
    tempZones: []
  }
}
