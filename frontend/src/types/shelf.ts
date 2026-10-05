/**
 * 熟成窖位：库房 → 货架 → 层号三级定位的一个可放奶酪的位置。
 * 上架时校验余量（capacity - occupied）并实时更新占用数。
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
  /** 已占块数 */
  occupied: number
  createdAt: number
  updatedAt: number
}

export const TEMP_ZONES: TempZone[] = ['冷区', '中温区', '常温区']

/** 窖位占用率派生值，供 <StatBadge> 与货架看板消费 */
export interface ShelfOccupancy {
  shelfId: string
  capacity: number
  occupied: number
  /** 剩余可放块数 */
  free: number
  /** 占用率百分比 0-100 */
  percent: number
  /** 是否已满 */
  full: boolean
  /** 是否接近满（占用率 ≥ 85%） */
  tight: boolean
}

/** 上架 / 下架 / 换架操作结果 */
export interface ShelfAssignResult {
  ok: boolean
  /** 是否为容量被抢的冲突（调用方据此保留选择并展示冲突，而非关闭对话框） */
  conflict: boolean
  message: string
  /** 冲突发生时窖位的真实余量，供前端展示 */
  shelfId?: string
  free?: number
  capacity?: number
  occupied?: number
}

/** 窖位操作类型：上架 / 换架 / 下架 */
export type ShelfOpType = 'assign' | 'change' | 'release'

/**
 * 占位操作状态：
 * - held：已占位（提交时锁定余量，其他标签页可见真实余量）
 * - done：已完成（批次位置已回写，占位已消费）
 * - conflict：冲突（容量被抢或批次位置已变，占位已释放）
 * - cancelled：已取消（用户手动关闭冲突提示）
 */
export type ShelfOpStatus = 'held' | 'done' | 'conflict' | 'cancelled'

/**
 * 窖位占位 / 冲突记录。
 * 提交上架、换架、下架时先写一条 held 占位锁定余量，
 * 同一事务内重新核对容量与批次当前位置后再回写批次 shelfId；
 * 核对失败则置为 conflict 释放占位，并保留原选择提示冲突。
 */
export interface ShelfOp {
  id: string
  batchId: string
  op: ShelfOpType
  /** 目标窖位（上架 / 换架）或原窖位（下架） */
  shelfId: string
  /** 换架时的原窖位（上架 / 下架为 null） */
  fromShelfId: string | null
  status: ShelfOpStatus
  message: string
  createdAt: number
  updatedAt: number
  /** held 占位的过期时间，过期后不再占用余量（防泄漏） */
  expiresAt: number
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
