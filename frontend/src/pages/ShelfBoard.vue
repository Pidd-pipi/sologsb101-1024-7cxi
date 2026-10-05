<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Delete, Edit, Plus, Position, Switch } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar, {
  type FilterModel,
  type FilterSelectConfig
} from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useMilkStore } from '@/stores/milkStore'
import { useShelfStore } from '@/stores/shelfStore'
import {
  TEMP_ZONES,
  createEmptyShelfFilter,
  type Shelf,
  type ShelfConflictCode,
  type TempZone
} from '@/types/shelf'
import type { Batch } from '@/types/batch'
import { TEMP_RANGE, ZONE_COLOR } from '@/utils/temperature'

const shelfStore = useShelfStore()
const milkStore = useMilkStore()

const {
  shelves,
  ready,
  filter,
  currentRoom,
  occupancyMap,
  totalCapacity,
  totalOccupied,
  occupancyPercent,
  fullShelfCount,
  conflictShelfCount,
  conflictShelves,
  unassignedBatches,
  assignedBatches,
  roomOptions,
  filteredShelves,
  roomShelves
} = storeToRefs(shelfStore)

const shelfFormRef = ref<FormInstance>()
const assignFormRef = ref<FormInstance>()
const shelfDialogVisible = ref(false)
const assignDialogVisible = ref(false)
const editingShelfId = ref<string | null>(null)

/** 上架弹窗模式：assign=未上架批次上架；move=已上架批次换架 */
const assignMode = ref<'assign' | 'move'>('assign')
/** 打开换架弹窗时批次所在窖位（提交时重新核对批次当前位置的期望值） */
const expectedShelfId = ref<string | null>(null)
const assignSubmitting = ref(false)
/** 最近一次提交冲突（弹窗内常驻告警，保留用户原选择） */
const assignConflict = ref<{ code: ShelfConflictCode; message: string } | null>(null)

const shelfForm = reactive({
  room: '',
  rackNo: '',
  layerNo: 1,
  tempZone: '中温区' as TempZone,
  capacity: 8,
  occupied: 0
})

const assignForm = reactive({
  batchId: '',
  shelfId: ''
})

const shelfRules: FormRules = {
  room: [{ required: true, message: '请填写库房名称', trigger: 'blur' }],
  rackNo: [{ required: true, message: '请填写货架号', trigger: 'blur' }],
  layerNo: [{ required: true, message: '请填写层号', trigger: 'change' }],
  tempZone: [{ required: true, message: '请选择温区', trigger: 'change' }],
  capacity: [{ required: true, message: '请填写可放块数', trigger: 'blur' }]
}

const assignRules: FormRules = {
  batchId: [{ required: true, message: '请选择要上架的批次', trigger: 'change' }],
  shelfId: [{ required: true, message: '请选择目标窖位', trigger: 'change' }]
}

const shelfFilterModel = computed<FilterModel>(() => ({
  keyword: filter.value.keyword,
  rooms: [...filter.value.rooms],
  tempZones: [...filter.value.tempZones]
}))

const shelfSelects = computed<FilterSelectConfig[]>(() => [
  {
    key: 'rooms',
    label: '库房',
    queryKey: 'room',
    options: roomOptions.value.map((room) => ({
      label: room,
      value: room,
      count: shelves.value.filter((shelf) => shelf.room === room).length
    }))
  },
  {
    key: 'tempZones',
    label: '温区',
    queryKey: 'zone',
    options: TEMP_ZONES.map((zone) => ({
      label: zone,
      value: zone,
      count: shelves.value.filter((shelf) => shelf.tempZone === zone).length
    }))
  }
])

const filteredCapacity = computed(() =>
  filteredShelves.value.reduce((sum, shelf) => sum + shelf.capacity, 0)
)
const filteredOccupied = computed(() =>
  filteredShelves.value.reduce(
    (sum, shelf) => sum + (occupancyMap.value[shelf.id]?.occupied ?? shelf.occupied),
    0
  )
)
const filteredPercent = computed(() =>
  filteredCapacity.value === 0
    ? 0
    : Math.round((filteredOccupied.value / filteredCapacity.value) * 100)
)

function zoneRangeText(zone: TempZone): string {
  const range = TEMP_RANGE[zone]
  return `${range.min} - ${range.max} ℃`
}

function zoneColor(zone: TempZone): string {
  return ZONE_COLOR[zone]
}

function applyFilter(model: FilterModel): void {
  shelfStore.patchFilter({
    keyword: model.keyword,
    rooms: (model.rooms as string[]) ?? [],
    tempZones: (model.tempZones as TempZone[]) ?? []
  })
}

function resetFilter(): void {
  shelfStore.filter = createEmptyShelfFilter()
  shelfStore.setCurrentRoom('')
}

function resetShelfForm(): void {
  shelfForm.room = currentRoom.value || roomOptions.value[0] || '一号熟成库'
  shelfForm.rackNo = ''
  shelfForm.layerNo = 1
  shelfForm.tempZone = '中温区'
  shelfForm.capacity = 8
  shelfForm.occupied = 0
}

function openShelfDialog(shelf?: Shelf): void {
  if (shelf) {
    editingShelfId.value = shelf.id
    shelfForm.room = shelf.room
    shelfForm.rackNo = shelf.rackNo
    shelfForm.layerNo = shelf.layerNo
    shelfForm.tempZone = shelf.tempZone
    shelfForm.capacity = shelf.capacity
    shelfForm.occupied = shelf.occupied
  } else {
    editingShelfId.value = null
    resetShelfForm()
  }
  shelfDialogVisible.value = true
}

async function submitShelf(): Promise<void> {
  if (!shelfFormRef.value) return
  const valid = await shelfFormRef.value.validate().catch(() => false)
  if (!valid) return
  if (editingShelfId.value) {
    await shelfStore.updateShelf(editingShelfId.value, { ...shelfForm })
    ElMessage.success('窖位已更新')
  } else {
    const created = await shelfStore.createShelf({ ...shelfForm })
    shelfStore.setCurrentShelf(created.id)
    ElMessage.success(`窖位已新建：${created.room} ${created.rackNo} 第 ${created.layerNo} 层`)
  }
  shelfDialogVisible.value = false
}

async function removeShelf(shelf: Shelf): Promise<void> {
  const hosted = shelfStore.batchesOfShelf(shelf.id).length
  try {
    await ElMessageBox.confirm(
      `删除窖位「${shelfStore.shelfLabel(shelf.id)}」后，其上 ${hosted} 个批次会被置为未上架（批次与子记录保留）。是否继续？`,
      '删除窖位确认',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await shelfStore.removeShelf(shelf.id)
  ElMessage.success('窖位已删除，关联批次已置为未上架')
}

/** 弹窗内可选择的批次：上架模式只列未上架，换架模式只列已上架 */
const assignableBatches = computed<Batch[]>(() =>
  assignMode.value === 'move' ? assignedBatches.value : unassignedBatches.value
)

/** 换架模式下当前选中批次（冲突时显示「批次已被换走」、排除其当前窖位用） */
const selectedBatch = computed<Batch | null>(
  () => milkStore.batches.find((batch) => batch.id === assignForm.batchId) ?? null
)

/** 弹窗内可选择的目标窖位：换架时排除选中批次当前所在窖位 */
const targetShelves = computed<Shelf[]>(() => {
  if (assignMode.value !== 'move') return shelves.value
  return shelves.value.filter((shelf) => shelf.id !== selectedBatch.value?.shelfId)
})

function openAssignDialog(shelfId?: string): void {
  assignMode.value = 'assign'
  assignConflict.value = null
  expectedShelfId.value = null
  assignForm.batchId = unassignedBatches.value[0]?.id ?? ''
  assignForm.shelfId =
    shelfId ?? filteredShelves.value.find((shelf) => (occupancyMap.value[shelf.id]?.free ?? 0) > 0)?.id ?? ''
  assignDialogVisible.value = true
}

/** 换架弹窗：默认带入该批次与其当前窖位，目标窖位预选另一个有余量的窖位 */
function openMoveDialog(batch?: Batch, targetShelfId?: string): void {
  assignMode.value = 'move'
  assignConflict.value = null
  const current = batch ?? assignedBatches.value[0] ?? null
  assignForm.batchId = current?.id ?? ''
  expectedShelfId.value = current?.shelfId ?? null
  assignForm.shelfId =
    targetShelfId ??
    filteredShelves.value.find(
      (shelf) => shelf.id !== current?.shelfId && (occupancyMap.value[shelf.id]?.free ?? 0) > 0
    )?.id ??
    ''
  assignDialogVisible.value = true
}

/** 切换批次（换架模式下批次变了，期望原窖位也要跟着变） */
function onAssignBatchChange(batchId: string): void {
  assignConflict.value = null
  const batch = milkStore.batches.find((item) => item.id === batchId)
  if (assignMode.value === 'move') expectedShelfId.value = batch?.shelfId ?? null
}

function onAssignShelfChange(): void {
  // 用户改选窖位后清掉旧冲突，允许按保留下来的原选择重新提交
  assignConflict.value = null
}

/** 弹窗关闭：释放本页预占位（提交成功后真实数据已落库；失败/取消则必须释放占位） */
function onAssignDialogClose(): void {
  shelfStore.releaseAllHolds()
  assignConflict.value = null
  assignSubmitting.value = false
}

const assignPreview = computed(() => {
  const occupancy = occupancyMap.value[assignForm.shelfId]
  if (!occupancy) return null
  return {
    ...occupancy,
    label: shelfStore.shelfLabel(assignForm.shelfId),
    after: Math.min(occupancy.capacity, occupancy.occupied + occupancy.held + 1),
    afterPercent:
      occupancy.capacity === 0
        ? 100
        : Math.round(
            (Math.min(occupancy.capacity, occupancy.occupied + occupancy.held + 1) /
              occupancy.capacity) *
              100
          )
  }
})

async function submitAssign(): Promise<void> {
  if (!assignFormRef.value) return
  const valid = await assignFormRef.value.validate().catch(() => false)
  if (!valid) return
  if (assignSubmitting.value) return
  assignSubmitting.value = true
  assignConflict.value = null
  try {
    const result =
      assignMode.value === 'move'
        ? await shelfStore.assignBatch(
            assignForm.batchId,
            assignForm.shelfId,
            expectedShelfId.value ?? selectedBatch.value?.shelfId ?? null
          )
        : await shelfStore.assignBatch(assignForm.batchId, assignForm.shelfId, null)
    if (result.ok) {
      ElMessage.success(result.message)
      assignDialogVisible.value = false
    } else {
      // 容量被抢走 / 批次已被换走：保留批次与目标窖位选择，弹窗内常驻显示冲突
      assignConflict.value = { code: result.code ?? 'CAPACITY_TAKEN', message: result.message }
      ElMessage.warning(result.message)
      // 提交时批次实际已被换到别处：更新期望值，用户可直接重试（按当前位置再次换架）
      if (result.code === 'BATCH_MOVED' && result.movedTo !== undefined) {
        expectedShelfId.value = result.movedTo
        // 若保留下来的目标窖位恰好是批次新所在窖位，自动改选一个有余量的窖位
        if (assignForm.shelfId === result.movedTo) {
          assignForm.shelfId =
            targetShelves.value.find((shelf) => (occupancyMap.value[shelf.id]?.free ?? 0) > 0)?.id ??
            ''
        }
      }
    }
  } finally {
    assignSubmitting.value = false
  }
}

async function release(batchId: string): Promise<void> {
  // 下架也把当前窖位作为期望值传入，事务提交前重新核对批次位置
  const batch = milkStore.batches.find((item) => item.id === batchId)
  const result = await shelfStore.releaseBatch(batchId, batch?.shelfId ?? null)
  if (result.ok) ElMessage.success(result.message)
  else ElMessage.warning(result.message)
}

async function assignBatchTo(shelfId: string, batchId: string): Promise<void> {
  const result = await shelfStore.assignBatch(batchId, shelfId, null)
  if (result.ok) ElMessage.success(result.message)
  else ElMessage.warning(result.message)
}

function batchesOnShelf(shelfId: string) {
  return shelfStore.batchesOfShelf(shelfId)
}

function batchOptionLabel(batchId: string): string {
  const batch = milkStore.batches.find((item) => item.id === batchId)
  if (!batch) return batchId
  return `${milkStore.milkNameOf(batch.milkId)} · ${batch.cheeseType} ${batch.curdedAt}（${batch.weightKg}kg）`
}
</script>

<template>
  <section>
    <div class="page-title">
      <div>
        <h2>熟成库货架与窖位</h2>
        <p>按库房 / 货架 / 层号维护窖位，温区配置与占用率实时展示；上架时自动校验余量。</p>
      </div>
      <div>
        <el-button type="primary" :icon="Plus" @click="openShelfDialog()">新建窖位</el-button>
        <el-button :icon="Position" :disabled="unassignedBatches.length === 0" @click="openAssignDialog()">
          上架分配
        </el-button>
        <el-button type="warning" :icon="Switch" :disabled="assignedBatches.length === 0" @click="openMoveDialog()">
          换架
        </el-button>
      </div>
    </div>

    <el-alert
      v-if="conflictShelfCount > 0"
      type="error"
      show-icon
      :closable="false"
      class="alert-gap"
      title="检测到窖位容量冲突，请以真实余量为准处理"
    >
      <template #default>
        <span v-for="shelf in conflictShelves" :key="shelf.id" class="conflict-chip">
          {{ shelf.room }} {{ shelf.rackNo }} 第 {{ shelf.layerNo }} 层：
          <strong>{{ occupancyMap[shelf.id]?.occupied ?? 0 }} / {{ shelf.capacity }} 块</strong>
          <template v-if="occupancyMap[shelf.id]?.drift">
            （台账计数 {{ shelf.occupied }}，已按真实挂接数校正显示）
          </template>
        </span>
      </template>
    </el-alert>

    <div class="stat-row">
      <StatBadge label="窖位总数" :value="shelves.length" suffix="个" icon="Grid" />
      <StatBadge label="可放块数" :value="totalCapacity" suffix="块" icon="Files" tone="info" />
      <StatBadge label="已占块数" :value="totalOccupied" suffix="块" icon="Box" tone="warning" />
      <StatBadge
        label="整体占用率"
        :value="occupancyPercent"
        suffix="%"
        icon="PieChart"
        :percent="occupancyPercent"
        show-percent
        tone="primary"
      />
      <StatBadge label="已满窖位" :value="fullShelfCount" suffix="个" icon="WarningFilled" tone="danger" />
      <StatBadge
        label="待上架批次"
        :value="unassignedBatches.length"
        suffix="批"
        icon="AlarmClock"
        tone="success"
      />
    </div>

    <FilterBar
      :model-value="shelfFilterModel"
      :selects="shelfSelects"
      keyword-placeholder="搜索库房 / 货架号 / 温区"
      @update:model-value="applyFilter"
      @reset="resetFilter"
    >
      <template #extra>
        <span class="filter-label">当前库房</span>
        <el-select
          :model-value="currentRoom"
          clearable
          placeholder="全部库房"
          class="room-select"
          @update:model-value="(value: string) => shelfStore.setCurrentRoom(value ?? '')"
        >
          <el-option v-for="room in roomOptions" :key="room" :label="room" :value="room" />
        </el-select>
      </template>
    </FilterBar>

    <div class="section-card">
      <div class="section-card__head">
        <h3>窖位看板（{{ filteredShelves.length }} / {{ shelves.length }}）</h3>
        <span class="muted">
          筛选结果占用率 {{ filteredPercent }}%（{{ filteredOccupied }} / {{ filteredCapacity }} 块）
        </span>
      </div>

      <EmptyPanel
        v-if="ready && filteredShelves.length === 0"
        title="还没有符合条件窖位"
        description="先按库房建立窖位（库房 + 货架号 + 层号 + 温区 + 可放块数），再回到批次台账把批次上架。"
        action-text="新建窖位"
        @action="openShelfDialog()"
      />

      <div v-else class="shelf-grid">
        <article v-for="shelf in filteredShelves" :key="shelf.id" class="shelf-card">
          <header class="shelf-card__head">
            <div>
              <h4>{{ shelf.room }} · {{ shelf.rackNo }}</h4>
              <p class="muted">第 {{ shelf.layerNo }} 层</p>
            </div>
            <span class="shelf-card__zone" :style="{ backgroundColor: zoneColor(shelf.tempZone) }">
              {{ shelf.tempZone }}
            </span>
          </header>

          <div class="shelf-card__meta">
            <span class="mono" :class="{ 'conflict-text': occupancyMap[shelf.id]?.conflict }">
              {{ occupancyMap[shelf.id]?.occupied ?? 0 }} / {{ shelf.capacity }} 块
              <el-tag
                v-if="occupancyMap[shelf.id]?.overCapacity"
                type="danger"
                size="small"
                effect="dark"
                class="conflict-tag"
              >
                超占
              </el-tag>
              <el-tag
                v-else-if="occupancyMap[shelf.id]?.drift"
                type="warning"
                size="small"
                effect="dark"
                class="conflict-tag"
              >
                计数冲突
              </el-tag>
            </span>
            <span class="muted">
              余量 {{ occupancyMap[shelf.id]?.free ?? shelf.capacity }} 块
              <el-tag v-if="occupancyMap[shelf.id]?.held > 0" type="warning" size="small" effect="plain">
                本页已占 1 块
              </el-tag>
            </span>
          </div>

          <el-progress
            :percentage="occupancyMap[shelf.id]?.percent ?? 0"
            :stroke-width="12"
            :color="
              occupancyMap[shelf.id]?.overCapacity
                ? '#c0392b'
                : occupancyMap[shelf.id]?.full
                  ? '#c0392b'
                  : occupancyMap[shelf.id]?.tight
                    ? '#d68910'
                    : '#1e8449'
            "
          />

          <p class="muted zone-range">适宜温度 {{ zoneRangeText(shelf.tempZone) }}</p>

          <div class="shelf-card__batches">
            <template v-if="batchesOnShelf(shelf.id).length > 0">
              <el-tag
                v-for="batch in batchesOnShelf(shelf.id)"
                :key="batch.id"
                type="success"
                effect="plain"
                closable
                @close="release(batch.id)"
              >
                {{ milkStore.milkNameOf(batch.milkId) }} · {{ batch.cheeseType }}
              </el-tag>
            </template>
            <span v-else class="muted">暂无批次</span>
          </div>

          <footer class="shelf-card__actions">
            <el-button
              text
              type="primary"
              :icon="Position"
              :disabled="(occupancyMap[shelf.id]?.free ?? 0) <= 0 || unassignedBatches.length === 0"
              @click="openAssignDialog(shelf.id)"
            >
              上架
            </el-button>
            <el-button
              text
              type="warning"
              :icon="Switch"
              :disabled="(occupancyMap[shelf.id]?.free ?? 0) <= 0 || assignedBatches.length === 0"
              @click="openMoveDialog(undefined, shelf.id)"
            >
              换架到此
            </el-button>
            <el-button text :icon="Edit" @click="openShelfDialog(shelf)">编辑</el-button>
            <el-button text type="danger" :icon="Delete" @click="removeShelf(shelf)">删除</el-button>
          </footer>
        </article>
      </div>
    </div>

    <div class="section-card">
      <div class="section-card__head">
        <h3>待上架批次</h3>
        <span class="muted">可直接选择窖位完成上架，余量不足时会给出提示</span>
      </div>
      <EmptyPanel
        v-if="unassignedBatches.length === 0"
        compact
        title="所有批次都已上架"
        description="新建批次或先下架后再分配窖位。"
      />
      <el-table v-else :data="unassignedBatches" border stripe>
        <el-table-column label="奶源" min-width="150">
          <template #default="{ row }">{{ milkStore.milkNameOf(row.milkId) }}</template>
        </el-table-column>
        <el-table-column prop="cheeseType" label="类型" width="90" />
        <el-table-column prop="curdedAt" label="凝乳日期" width="120" />
        <el-table-column prop="targetDays" label="目标天数" width="100" />
        <el-table-column prop="weightKg" label="重量 kg" width="100" />
        <el-table-column prop="state" label="状态" width="100" />
        <el-table-column label="选择窖位" min-width="260">
          <template #default="{ row }">
            <el-select
              :model-value="''"
              placeholder="选择窖位完成上架"
              style="width: 100%"
              @update:model-value="(value: string) => assignBatchTo(value, row.id)"
            >
              <el-option
                v-for="shelf in roomShelves.length > 0 ? roomShelves : shelves"
                :key="shelf.id"
                :label="`${shelfStore.shelfLabel(shelf.id)}（余 ${occupancyMap[shelf.id]?.free ?? 0} 块）`"
                :value="shelf.id"
                :disabled="(occupancyMap[shelf.id]?.free ?? 0) <= 0"
              />
            </el-select>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog
      v-model="shelfDialogVisible"
      :title="editingShelfId ? '编辑窖位' : '新建窖位'"
      width="560px"
      destroy-on-close
    >
      <el-form ref="shelfFormRef" :model="shelfForm" :rules="shelfRules" label-width="110px">
        <el-form-item label="库房" prop="room">
          <el-select
            v-model="shelfForm.room"
            filterable
            allow-create
            default-first-option
            placeholder="选择或输入库房名称"
            style="width: 100%"
          >
            <el-option v-for="room in roomOptions" :key="room" :label="room" :value="room" />
          </el-select>
        </el-form-item>
        <el-form-item label="货架号" prop="rackNo">
          <el-input v-model="shelfForm.rackNo" placeholder="如：A-01" clearable />
        </el-form-item>
        <el-form-item label="层号" prop="layerNo">
          <el-input-number v-model="shelfForm.layerNo" :min="1" :max="20" />
        </el-form-item>
        <el-form-item label="温区" prop="tempZone">
          <el-radio-group v-model="shelfForm.tempZone">
            <el-radio-button v-for="zone in TEMP_ZONES" :key="zone" :value="zone">
              {{ zone }}
            </el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="可放块数" prop="capacity">
          <el-input-number v-model="shelfForm.capacity" :min="0" :max="200" />
        </el-form-item>
        <el-form-item label="已占块数" prop="occupied">
          <el-input-number v-model="shelfForm.occupied" :min="0" :max="shelfForm.capacity" />
        </el-form-item>
        <el-alert type="info" :closable="false" show-icon>
          温区 {{ shelfForm.tempZone }} 的适宜温度为 {{ zoneRangeText(shelfForm.tempZone) }}，环境记录越界会自动标异常。
        </el-alert>
      </el-form>
      <template #footer>
        <el-button @click="shelfDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitShelf">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="assignDialogVisible"
      :title="assignMode === 'move' ? '批次换架' : '批次上架分配'"
      width="580px"
      destroy-on-close
      @close="onAssignDialogClose"
    >
      <el-form ref="assignFormRef" :model="assignForm" :rules="assignRules" label-width="110px">
        <el-form-item :label="assignMode === 'move' ? '换架批次' : '批次'" prop="batchId">
          <el-select
            v-model="assignForm.batchId"
            :placeholder="assignMode === 'move' ? '选择要换架的批次' : '选择待上架批次'"
            style="width: 100%"
            @update:model-value="onAssignBatchChange"
          >
            <el-option
              v-for="batch in assignableBatches"
              :key="batch.id"
              :label="
                assignMode === 'move'
                  ? `${batchOptionLabel(batch.id)}（现：${shelfStore.shelfLabel(batch.shelfId)}）`
                  : batchOptionLabel(batch.id)
              "
              :value="batch.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="目标窖位" prop="shelfId">
          <el-select
            v-model="assignForm.shelfId"
            placeholder="选择窖位"
            style="width: 100%"
            @update:model-value="onAssignShelfChange"
          >
            <el-option
              v-for="shelf in targetShelves"
              :key="shelf.id"
              :label="
                `${shelfStore.shelfLabel(shelf.id)}（${shelf.tempZone} 余 ${occupancyMap[shelf.id]?.free ?? 0} 块）` +
                (occupancyMap[shelf.id]?.held > 0 ? '（本页已占位）' : '')
              "
              :value="shelf.id"
              :disabled="(occupancyMap[shelf.id]?.free ?? 0) <= 0 || shelfStore.isHeld(shelf.id)"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <el-alert
        v-if="assignConflict"
        :key="assignConflict.code + assignConflict.message"
        type="error"
        :closable="false"
        show-icon
        class="alert-gap"
        title="提交冲突，原选择已保留"
      >
        {{ assignConflict.message }}
        <span v-if="assignConflict.code === 'BATCH_MOVED'">可直接再次点击确认，按批次当前位置重新提交。</span>
      </el-alert>
      <el-alert
        v-else-if="assignPreview"
        :type="assignPreview.conflict || assignPreview.full ? 'error' : 'success'"
        :closable="false"
        show-icon
      >
        {{ assignPreview.label }}：当前 {{ assignPreview.occupied }} / {{ assignPreview.capacity }} 块，
        {{ assignMode === 'move' ? '换架后' : '上架后' }} {{ assignPreview.after }} /
        {{ assignPreview.capacity }} 块（占用率 {{ assignPreview.afterPercent }}%）
      </el-alert>
      <el-alert v-else type="warning" :closable="false" show-icon>
        请选择目标窖位，提交时会在事务内重新核对真实余量与批次当前位置。
      </el-alert>
      <template #footer>
        <el-button @click="assignDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="assignSubmitting" @click="submitAssign">
          {{ assignMode === 'move' ? '确认换架' : '确认上架' }}
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.shelf-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
}

.shelf-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border: 1px solid #e7dfd0;
  border-radius: 12px;
  background: #fffdf8;
}

.shelf-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.shelf-card__head h4 {
  margin: 0;
  font-size: 15px;
}

.shelf-card__zone {
  padding: 2px 10px;
  border-radius: 999px;
  color: #ffffff;
  font-size: 12px;
  white-space: nowrap;
}

.shelf-card__meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  font-size: 13px;
}

.zone-range {
  margin: 0;
  font-size: 12px;
}

.shelf-card__batches {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 24px;
}

.shelf-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  border-top: 1px dashed #e7dfd0;
  padding-top: 8px;
}

.filter-label {
  margin-right: 6px;
  font-size: 13px;
  color: #6b6257;
}

.room-select {
  width: 170px;
}

.alert-gap {
  margin-bottom: 16px;
}

.conflict-chip {
  display: inline-block;
  margin-right: 16px;
  font-size: 13px;
}

.conflict-text {
  color: #c0392b;
  font-weight: 600;
}

.conflict-tag {
  margin-left: 6px;
}
</style>
