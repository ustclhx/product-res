import { createFileRoute } from '@tanstack/react-router'
import { ebayAccountDeletionDeps } from '../../../../features/ebay-compliance/account-deletion.server.ts'
import {
  handleEbayChallenge,
  handleEbayNotification,
} from '../../../../features/ebay-compliance/account-deletion.ts'

// eBay Marketplace Account Deletion（openspec/changes/add-ebay-account-deletion）：
// GET 为端点验证 challenge，POST 为删除通知。路径必须与 eBay 后台填写的地址逐字一致。
export const Route = createFileRoute('/api/webhooks/ebay/account-deletion')({
  server: {
    handlers: {
      GET: async ({ request }) => handleEbayChallenge(request, await ebayAccountDeletionDeps()),
      POST: async ({ request }) => handleEbayNotification(request, await ebayAccountDeletionDeps()),
    },
  },
})
