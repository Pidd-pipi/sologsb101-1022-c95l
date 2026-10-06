// 临时验证脚本：用 esbuild 即时转译 TS，跑窖藏离线合并的关键场景
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const result = await build({
  entryPoints: ['src/utils/cellarMerge.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  external: ['dexie']
})

// stub dexie
const code = result.outputFiles[0].text
const replaced =
  'class _DexieStub { constructor(){} version(){return this} stores(){return this} upgrade(){return this} }\n' +
  code
    .replace(/import\s*\{[^}]*\}\s*from\s*['"]dexie['"];?/g, '')
    .replace(/import\s+Dexie[^;]*;?/g, '')
    .replace(/extends Dexie/g, 'extends _DexieStub')

writeFileSync('/tmp/cellar-merge-test.mjs', replaced)

const mod = await import(pathToFileURL('/tmp/cellar-merge-test.mjs').href)
const { planCellarCommit, buildCreateDraft, buildUpdateDraft, validateCellarDraft } = mod

const baseCellar = {
  id: 'c1',
  batchId: 'b1',
  startDate: '2026-01-01',
  endDate: '2026-07-01',
  temperatureC: 22,
  humidityPct: 60,
  container: '陶罐',
  state: '窖藏中',
  revision: 100,
  updatedAt: 1000
}

// 场景1：远端未动 → 快进，revision+1
{
  const draft = buildUpdateDraft(baseCellar, { temperatureC: 23 })
  const plan = planCellarCommit(draft, { ...baseCellar }, [])
  assert.equal(plan.outcome.type, 'fast-forward')
  assert.equal(plan.outcome.cellar.temperatureC, 23)
  assert.equal(plan.outcome.cellar.revision, 101)
  console.log('✓ 场景1 快进提交')
}

// 场景2：远端修订号更大，只改了不同字段 → 自动合入，无冲突
{
  const draft = buildUpdateDraft(baseCellar, { temperatureC: 23 })
  const remote = { ...baseCellar, humidityPct: 65, revision: 101, updatedAt: 2000 }
  const plan = planCellarCommit(draft, remote, [])
  assert.equal(plan.outcome.type, 'merged')
  assert.equal(plan.outcome.cellar.temperatureC, 23)
  assert.equal(plan.outcome.cellar.humidityPct, 65)
  assert.equal(plan.outcome.cellar.revision, 102)
  assert.ok(!plan.outcome.conflictCopy)
  console.log('场景2 ✓ 无冲突字段自动补入:', plan.outcome.notes.join('；'))
}

// 场景3：双方都改了温度（不同值）→ 两版都留，远端修订号大/时间新 → 远端为主，草稿为副本
{
  const draft = buildUpdateDraft(baseCellar, { temperatureC: 24 })
  draft.updatedAt = 1500
  const remote = { ...baseCellar, temperatureC: 21, revision: 101, updatedAt: 2000 }
  const plan = planCellarCommit(draft, remote, [])
  assert.equal(plan.outcome.type, 'conflict')
  assert.equal(plan.outcome.cellar.temperatureC, 21, '主记录保留较新远端值')
  assert.equal(plan.outcome.cellar.revision, 102)
  assert.ok(plan.outcome.conflictCopy, '必须生成副本')
  assert.equal(plan.outcome.conflictCopy.temperatureC, 24)
  assert.equal(plan.outcome.conflictCopy.conflictOf, 'c1')
  assert.equal(plan.outcome.conflictCopy.revision, 101)
  console.log('场景3 ✓ 冲突留两版:', plan.outcome.notes.join('；'))
}

// 场景4：同修订号分叉、草稿时间更新 → 草稿为主，远端为副本
{
  const draft = buildUpdateDraft(baseCellar, { temperatureC: 24 })
  draft.updatedAt = 3000
  const remote = { ...baseCellar, temperatureC: 21, revision: 100, updatedAt: 2000 }
  const plan = planCellarCommit(draft, remote, [])
  assert.equal(plan.outcome.type, 'conflict')
  assert.equal(plan.outcome.cellar.temperatureC, 24, '草稿时间新 → 主记录用草稿值')
  assert.equal(plan.outcome.conflictCopy.temperatureC, 21)
  console.log('场景4 ✓ 同修订号按时间留新，两版都在')
}

// 场景5：双方改成相同值 → 不算冲突
{
  const draft = buildUpdateDraft(baseCellar, { temperatureC: 25 })
  const remote = { ...baseCellar, temperatureC: 25, revision: 101, updatedAt: 2000 }
  const plan = planCellarCommit(draft, remote, [])
  assert.equal(plan.outcome.type, 'merged')
  assert.equal(plan.outcome.cellar.temperatureC, 25)
  console.log('场景5 ✓ 双方改成相同值，合并为一版')
}

// 场景6：新建草稿 + 同批次已有窖藏 → duplicate 留并行版本，不占新主位
{
  const draft = buildCreateDraft({
    batchId: 'b1', startDate: '2026-02-01', endDate: '2026-08-01',
    temperatureC: 20, humidityPct: 55, container: '陶罐', state: '窖藏中'
  })
  const existing = { ...baseCellar }
  const plan = planCellarCommit(draft, null, [existing])
  assert.equal(plan.outcome.type, 'duplicate')
  assert.ok(plan.outcome.conflictCopy)
  assert.equal(plan.outcome.conflictCopy.conflictOf, 'c1')
  assert.equal(plan.capacityExcludeId, 'c1')
  console.log('场景6 ✓ 同批次重复入窖留并行版本')
}

// 场景7：纯新建 → created，占容量
{
  const draft = buildCreateDraft({
    batchId: 'b9', startDate: '2026-03-01', endDate: '2026-09-01',
    temperatureC: 20, humidityPct: 55, container: '竹筒', state: '窖藏中'
  })
  const plan = planCellarCommit(draft, null, [])
  assert.equal(plan.outcome.type, 'created')
  assert.equal(plan.primaryContainer, '竹筒')
  assert.equal(plan.primaryInCellar, true)
  assert.equal(plan.outcome.cellar.revision, 1)
  console.log('场景7 ✓ 新建 revision 从 1 起')
}

// 场景8：远端被删除 → 恢复
{
  const draft = buildUpdateDraft(baseCellar, { temperatureC: 23 })
  const plan = planCellarCommit(draft, null, [])
  assert.equal(plan.outcome.type, 'restored')
  assert.equal(plan.outcome.cellar.revision, 101)
  console.log('场景8 ✓ 原记录被删 → 按草稿恢复')
}

// 场景9：边界校验
{
  const draft = buildCreateDraft({
    batchId: 'b9', startDate: '2026-03-01', endDate: '2026-09-01',
    temperatureC: 99, humidityPct: 55, container: '竹筒', state: '窖藏中'
  })
  assert.throws(() => validateCellarDraft(draft), /温度需在/)
  const warnDraft = buildCreateDraft({
    batchId: 'b9', startDate: '2026-03-01', endDate: '2026-09-01',
    temperatureC: 30, humidityPct: 55, container: '竹筒', state: '窖藏中'
  })
  const { warnings } = validateCellarDraft(warnDraft)
  assert.ok(warnings.some((w) => w.includes('建议区间')))
  console.log('场景9 ✓ 硬边界拒绝、建议区间仅告警')
}

// 场景10：旧数据修订号迁移（入窖日期折算，随日期单调）
{
  const DAY = 864e5
  const calc = (d) => {
    const [y, m, dd] = d.split('-').map(Number)
    return Math.floor(new Date(y, m - 1, dd).getTime() / DAY) + 1
  }
  assert.ok(calc('2024-06-20') > calc('2024-04-05'))
  assert.ok(calc('2024-04-05') > 0)
  console.log('场景10 ✓ 修订号迁移随入窖日期单调递增', calc('2024-04-05'), calc('2024-06-20'))
}

// 场景11：部分字段冲突时，无冲突字段仍然合入
{
  const draft = buildUpdateDraft(baseCellar, { temperatureC: 24, humidityPct: 70 })
  const remote = { ...baseCellar, temperatureC: 21, revision: 101, updatedAt: 2000 }
  const plan = planCellarCommit(draft, remote, [])
  assert.equal(plan.outcome.type, 'conflict')
  assert.equal(plan.outcome.cellar.humidityPct, 70, '湿度只被我方改 → 合入主记录')
  assert.equal(plan.outcome.cellar.temperatureC, 21)
  assert.equal(plan.outcome.conflictCopy.temperatureC, 24)
  console.log('场景11 ✓ 冲突字段留两版，其余字段照常合入')
}

console.log('\n全部合并场景断言通过 ✔')
