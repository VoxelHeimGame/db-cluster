import { Elysia } from 'elysia'
import { clusterRoutes } from './routes/cluster'
import { healthRoutes } from './routes/health'
import { query } from './db'

const app = new Elysia()
  .use(healthRoutes)
  .use(clusterRoutes)
  .listen({
    port: 3000,
    idleTimeout: 120 // 2 minutes
  })

console.log(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`)

