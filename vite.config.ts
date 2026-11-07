import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { coreController } from './src/core/controller'

function ccswitchBackendPlugin() {
  return {
    name: 'ccswitch-backend-api',
    async configureServer(server: any) {
      await coreController.init()
      server.middlewares.use(async (req: any, res: any, next: any) => {
        if (!req.url || !req.url.startsWith('/api/')) return next()

        const action = req.url.replace('/api/', '').split('?')[0]
        let body: any = {}
        if (req.method === 'POST') {
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(Buffer.from(chunk))
          if (chunks.length > 0) {
            try {
              body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            } catch {
              body = {}
            }
          }
        }

        try {
          let result: any
          switch (action) {
            case 'getDashboard':
              result = coreController.getDashboardSnapshot()
              break
            case 'getTargets':
              result = coreController.getAllTargetsStatus()
              break
            case 'switchProvider':
              result = coreController.switchTargetProvider(
                body.targetId,
                body.providerId,
                Boolean(body.useProxy)
              )
              break
            case 'saveProvider':
              result = coreController.saveProvider(body)
              break
            case 'deleteProvider':
              result = coreController.deleteProvider(body.targetId, body.providerId)
              break
            case 'saveMcp':
              result = coreController.saveAndSyncMcp(body)
              break
            case 'deleteMcp':
              result = coreController.deleteMcp(body.mcpId)
              break
            case 'updateTheme':
              result = coreController.updateTheme(body.theme)
              break
            default:
              res.statusCode = 404
              res.end(JSON.stringify({ error: `Unknown API: ${action}` }))
              return
          }
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(result))
        } catch (e: any) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: e?.message || 'Internal error' }))
        }
      })
    }
  }
}

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react(), ccswitchBackendPlugin()],
  server: {
    port: 5173,
    host: '127.0.0.1'
  },
  build: {
    outDir: resolve(__dirname, 'dist-web'),
    emptyOutDir: true
  }
})
