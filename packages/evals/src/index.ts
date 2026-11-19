/**
 * 提示词评测（docs/06-ai.md「提示词版本与评测」）。只供根目录命令行与项目套件
 * （`evals/<suite>/suite.ts`）使用；任何应用或运行时包都不得依赖本包（check-deps）。
 */
export {
  type DefinedPrompt,
  definePrompt,
  type PromptDefinition,
  type PromptSection,
  promptCanonicalJson,
  type RenderedPrompt,
  renderedPromptDigest,
  renderPrompt,
} from '@product-res/ai'
/** 套件的 `inputSchema` 用同一个 zod 实例声明（根目录不直接依赖 zod） */
export { z } from 'zod'
export {
  type AssessmentReport,
  type Collected,
  collect,
  type EvaluateRun,
  type EvaluateRunContext,
  type EvaluationGroup,
  type EvaluationResult,
  type GateStatus,
  type ModelRef,
  mean,
  percentile,
  type RunAssessment,
  type RunGate,
  type RunScope,
} from './assess.ts'
export {
  banned,
  type Check,
  type CheckContext,
  type CheckOutcome,
  type CheckResult,
  checks,
  chineseVariant,
  length,
  type ScriptLang,
  type Severity,
  script,
  sections,
} from './checks.ts'
export { EvalConfigError, EXIT } from './errors.ts'
export {
  type CallUsage,
  type JudgeResult,
  type PreparedInfo,
  type Report,
  type RunOptions,
  runEval,
  type SampleResult,
  type SampleStatus,
} from './runner.ts'
export type { Sample } from './sample.ts'
export {
  defineSuite,
  type ModelSpec,
  type PreparedOutput,
  type PrepareOutput,
  type Rubric,
  type Suite,
  type SuiteDefinition,
} from './suite.ts'
