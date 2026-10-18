import { marketingPlans } from './pricing-data.ts'
import { pricingSnapshot } from './pricing-snapshot.ts'

/** 保留首页区块接口，首屏数据改为构建快照。 */
export const placeholderPlans = marketingPlans(pricingSnapshot)
