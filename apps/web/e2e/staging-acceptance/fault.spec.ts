import { faultScenarioId, selectFaultModels } from './fault-definitions.ts'
import { withFaultModels } from './fault-models.ts'
import { prepareFaultReadiness } from './fault-readiness.ts'
import { runMediaFaultScenario, runTextFaultScenario } from './fault-support.ts'
import { evidence, test } from './support.ts'

test('Fault acceptance: scenario matrix with terminal observation', async ({ page }) => {
  test.setTimeout(40 * 60_000)
  // 在登录与任何写操作前解析，非法子集不会准备或停用模型。
  const models = selectFaultModels()
  const workspace = await prepareFaultReadiness(page)
  await withFaultModels(
    page,
    models,
    async () => {
      await evidence('fault-readiness', {
        ...workspace,
        modelCount: models.length,
        scenarios: models.map(faultScenarioId),
      })
      for (const model of models) {
        await test.step(faultScenarioId(model), async () => {
          if (model.kind === 'image') await runMediaFaultScenario(page, workspace, model)
          else await runTextFaultScenario(page, workspace, model)
        })
      }
    },
    async (cleanup) => {
      await evidence('fault-cleanup', { cleanup })
    },
  )
})
