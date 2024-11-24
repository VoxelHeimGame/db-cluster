import { Elysia } from 'elysia'
import { swagger } from '@elysiajs/swagger'
import { clusterRoutes } from './routes/cluster'
import { healthRoutes } from './routes/health'
import { loggerPlugin, logger } from './utils/logger'

const app = new Elysia()
  .use(swagger({
    documentation: {
      info: {
        title: 'Cluster DB API Documentation',
        version: '1.0.0',
        description: 'API documentation for the Cluster DB management'
      },
      tags: [
        { name: 'cluster', description: 'Cluster management endpoints' },
        { name: 'health', description: 'Health check endpoint' }
      ]
    },
    path: '/docs'
  }))
  .use(loggerPlugin())
  .use(healthRoutes)
  .use(clusterRoutes)
  .listen({
    port: 3000,
    idleTimeout: 120 // 2 minutes
  })

logger.server(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`)
logger.server(`📚 Open the Swagger UI at http://${app.server?.hostname}:${app.server?.port}/docs`)

