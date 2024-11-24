import { Elysia, t } from 'elysia'
import { exec } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs'
import { logger } from '../utils/logger'
import { query } from '../db'

const execAsync = promisify(exec)

const EXEC_TIMEOUT = 300000 // 5 minutes

function normalizePath(inputPath: string): string {
  return inputPath.replace(/\\/g, '/')
}

function getRootDir(): string {
  let currentDir = __dirname
  while (currentDir !== path.parse(currentDir).root) {
    if (fs.existsSync(path.join(currentDir, 'docker'))) {
      return currentDir
    }
    currentDir = path.dirname(currentDir)
  }
  throw new Error('Docker directory not found in project structure')
}

async function executeBashScript(scriptName: string, args: string[] = []): Promise<{ success: boolean; output: string; workerIp?: string }> {
  try {
    const rootDir = getRootDir()
    const dockerDir = path.join(rootDir, 'docker')
    const scriptPath = path.join(dockerDir, scriptName)
    
    const normalizedScriptPath = normalizePath(scriptPath)
    const isWindows: boolean = process.platform === 'win32'
    
    let command: string
    if (isWindows) {
      const gitBashPath = 'C:\\Program Files\\Git\\bin\\bash.exe'
      command = `"${gitBashPath}" -c "cd '${dockerDir}' && ./${scriptName} ${args.join(' ')}"`
    } else {
      command = `cd '${dockerDir}' && bash ${scriptName} ${args.join(' ')}`
    }

    logger.debug(`Executing command: ${command}`)
    logger.debug(`Working directory: ${dockerDir}`)

    const { stdout, stderr } = await execAsync(command, {
      cwd: dockerDir,
      timeout: EXEC_TIMEOUT,
      shell: isWindows ? 'cmd.exe' : '/bin/bash'
    })

    logger.debug(`Script stdout: ${stdout}`)
    if (stderr) {
      logger.debug(`Script stderr: ${stderr}`)
    }

    let success = false
    let workerIp: string | undefined

    if (scriptName === 'start_cluster.sh') {
      success = stdout.includes('🎉 Citus Cluster') && stdout.includes('started successfully')
      const ipMatch = stdout.match(/Registering worker (\d+\.\d+\.\d+\.\d+)/)
      workerIp = ipMatch ? ipMatch[1] : undefined
    } 
    else if (scriptName === 'stop_cluster.sh') {
      success = stdout.includes('Citus Cluster') && stdout.includes('stopped and cleaned up completely')
    }
    else if (scriptName === 'add_worker.sh') {
      success = stdout.includes('Worker(s) added and registered to the Citus cluster successfully')
      const ipMatch = stdout.match(/Registering worker (\d+\.\d+\.\d+\.\d+)/)
      workerIp = ipMatch ? ipMatch[1] : undefined
    }
    else if (scriptName === 'delete_worker.sh') {
      success = stdout.includes('Workers removed successfully from both Docker and the Citus cluster')
    }

    return { success, output: stdout, workerIp }
  } catch (error) {
    logger.error(`Script execution error: ${error instanceof Error ? error.message : 'Unknown error'}`, {
      scriptName,
      args
    })
    return { 
      success: false, 
      output: error instanceof Error ? error.message : 'Unknown error occurred' 
    }
  }
}

async function getClusterStatus(clusterId: string): Promise<{ 
  isRunning: boolean
  workerCount: number
  workers: { nodename: string; nodeport: string }[] 
}> {
  try {
    const result = await query('SELECT * FROM citus_get_active_worker_nodes()')
    return {
      isRunning: result.rows.length > 0,
      workerCount: result.rows.length,
      workers: result.rows.map(row => ({ nodename: row.node_name, nodeport: row.node_port }))
    }
  } catch (error) {
    logger.error(`Get cluster status error: ${error instanceof Error ? error.message : 'Unknown error'}`, { clusterId })
    return { isRunning: false, workerCount: 0, workers: [] }
  }
}

async function startCluster(clusterId: string, workersCount: number): Promise<{ success: boolean; status: Awaited<ReturnType<typeof getClusterStatus>> }> {
  const result = await executeBashScript('start_cluster.sh', [clusterId, workersCount.toString()])
  if (result.success) {
    const status = await getClusterStatus(clusterId)
    return { success: true, status }
  }
  return { success: false, status: { isRunning: false, workerCount: 0, workers: [] } }
}

async function stopCluster(clusterId: string): Promise<{ success: boolean }> {
  const result = await executeBashScript('stop_cluster.sh', [clusterId])
  return { success: result.success }
}

async function addWorkerWithDockerScript(clusterId: string, totalWorkers: number): Promise<{ success: boolean; workerIp?: string; output: string }> {
  const result = await executeBashScript('add_worker.sh', [clusterId, (totalWorkers + 1).toString()])
  const success = result.output.includes('Worker(s) added and registered to the Citus cluster') && 
                  !result.output.includes('Failed to register worker')
  const ipMatch = result.output.match(/Registering worker (\d+\.\d+\.\d+\.\d+)/)
  const workerIp = ipMatch ? ipMatch[1] : undefined
  return { success, workerIp, output: result.output }
}

async function removeWorkersWithDockerScript(clusterId: string, workersToKeep: number): Promise<boolean> {
  const result = await executeBashScript('delete_worker.sh', [clusterId, workersToKeep.toString()])
  return result.success
}

export const clusterRoutes = new Elysia({ prefix: '/cluster' })
  .onError(({ code, error, set }) => {
    logger.error(`Route error: ${error.message}`, { code })
    set.status = code === 'NOT_FOUND' ? 404 : 500
    return {
      success: false,
      error: error.message,
      code
    }
  })
  .post('/:clusterId/start', async ({ params, body, set }) => {
    const { clusterId } = params
    const { workersCount } = body
    logger.info(`Starting cluster ${clusterId} with ${workersCount} workers...`)
    try {
      const result = await startCluster(clusterId, workersCount)
      if (result.success) {
        logger.info(`Cluster ${clusterId} started successfully`, { status: result.status })
        return { 
          success: true, 
          message: `Cluster ${clusterId} started successfully`,
          status: result.status
        }
      } else {
        throw new Error(`Failed to start cluster ${clusterId}`)
      }
    } catch (error) {
      logger.error(`Error starting cluster: ${error instanceof Error ? error.message : 'Unknown error'}`, { clusterId })
      set.status = 500
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'An unknown error occurred'
      }
    }
  }, {
    params: t.Object({
      clusterId: t.String()
    }),
    body: t.Object({
      workersCount: t.Number()
    }),
    detail: {
      tags: ['cluster'],
      summary: 'Start a cluster',
      description: 'Start a cluster with the specified ID and number of workers'
    }
  })
  .post('/:clusterId/stop', async ({ params, set }) => {
    const { clusterId } = params
    logger.info(`Stopping cluster ${clusterId}...`)
    try {
      const result = await stopCluster(clusterId)
      if (result.success) {
        logger.info(`Cluster ${clusterId} stopped successfully`)
        return { 
          success: true, 
          message: `Cluster ${clusterId} stopped successfully`
        }
      } else {
        throw new Error(`Failed to stop cluster ${clusterId}`)
      }
    } catch (error) {
      logger.error(`Error stopping cluster: ${error instanceof Error ? error.message : 'Unknown error'}`, { clusterId })
      set.status = 500
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'An unknown error occurred'
      }
    }
  }, {
    params: t.Object({
      clusterId: t.String()
    }),
    detail: {
      tags: ['cluster'],
      summary: 'Stop a cluster',
      description: 'Stop a cluster with the specified ID'
    }
  })
  .get('/:clusterId/workers', async ({ params, set }) => {
    const { clusterId } = params
    logger.info(`Fetching worker nodes for cluster ${clusterId}...`)
    try {
      const result = await query('SELECT * FROM citus_get_active_worker_nodes()')
      logger.info(`Successfully fetched worker nodes for cluster ${clusterId}`, { workerCount: result.rows.length })
      return result.rows
    } catch (error) {
      logger.error(`Error fetching worker nodes: ${error instanceof Error ? error.message : 'Unknown error'}`, { clusterId })
      set.status = 500
      throw new Error('Failed to fetch worker nodes')
    }
  }, {
    params: t.Object({
      clusterId: t.String()
    }),
    detail: {
      tags: ['cluster'],
      summary: 'Get cluster workers',
      description: 'Retrieve all worker nodes for the specified cluster'
    }
  })
  .post('/:clusterId/workers/add', async ({ params, set }) => {
    const { clusterId } = params
    logger.info(`Adding new worker node to cluster ${clusterId}...`)
    try {
      const currentWorkers = await query('SELECT COUNT(*) FROM citus_get_active_worker_nodes()')
      const currentWorkerCount = parseInt(currentWorkers.rows[0].count)

      const { success, workerIp } = await addWorkerWithDockerScript(clusterId, currentWorkerCount)
      if (!success || !workerIp) {
        throw new Error(`Failed to start new worker for cluster ${clusterId}`)
      }

      logger.info(`New worker added and verified: ${workerIp}`, { clusterId })
      return { success: true, message: 'Worker node added successfully', node: workerIp }
    } catch (error) {
      logger.error(`Error adding worker node: ${error instanceof Error ? error.message : 'Unknown error'}`, { clusterId })
      set.status = 500
      return { success: false, error: error instanceof Error ? error.message : 'An unknown error occurred' }
    }
  }, {
    params: t.Object({
      clusterId: t.String()
    }),
    detail: {
      tags: ['cluster'],
      summary: 'Add a worker to the cluster',
      description: 'Add a new worker node to the specified cluster'
    }
  })
  .post('/:clusterId/workers/remove', async ({ params, set }) => {
    const { clusterId } = params
    logger.info(`Removing worker node from cluster ${clusterId}...`)
    try {
      const workers = await query('SELECT COUNT(*) FROM citus_get_active_worker_nodes()')
      const workerCount = parseInt(workers.rows[0].count)
      
      if (workerCount <= 1) {
        logger.warn(`Cannot remove the last worker node from cluster ${clusterId}`)
        set.status = 400
        return { success: false, error: 'Cannot remove the last worker node' }
      }

      const workersToKeep = workerCount - 1
      logger.info(`Removing workers to keep ${workersToKeep} nodes...`, { clusterId })

      const isWorkerRemoved = await removeWorkersWithDockerScript(clusterId, workersToKeep)
      if (!isWorkerRemoved) {
        throw new Error(`Failed to remove workers from cluster ${clusterId}`)
      }

      const remainingWorkers = await query('SELECT COUNT(*) FROM citus_get_active_worker_nodes()')
      const actualRemainingWorkers = parseInt(remainingWorkers.rows[0].count)

      if (actualRemainingWorkers !== workersToKeep) {
        logger.warn(`Expected ${workersToKeep} workers, but found ${actualRemainingWorkers}`, { clusterId })
      }

      logger.info(`Workers removed successfully. Remaining workers: ${actualRemainingWorkers}`, { clusterId })
      return { success: true, message: `Workers removed successfully. Remaining workers: ${actualRemainingWorkers}` }
    } catch (error) {
      logger.error(`Error removing worker node: ${error instanceof Error ? error.message : 'Unknown error'}`, { clusterId })
      set.status = 500
      return { success: false, error: error instanceof Error ? error.message : 'An unknown error occurred' }
    }
  }, {
    params: t.Object({
      clusterId: t.String()
    }),
    detail: {
      tags: ['cluster'],
      summary: 'Remove a worker from the cluster',
      description: 'Remove a worker node from the specified cluster'
    }
  })
  .get('/:clusterId/status', async ({ params, set }) => {
    const { clusterId } = params
    logger.info(`Fetching status for cluster ${clusterId}...`)
    try {
      const status = await getClusterStatus(clusterId)
      logger.info(`Successfully fetched status for cluster ${clusterId}`, { status })
      return { 
        success: true, 
        status 
      }
    } catch (error) {
      logger.error(`Error fetching cluster status: ${error instanceof Error ? error.message : 'Unknown error'}`, { clusterId })
      set.status = 500
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'An unknown error occurred'
      }
    }
  }, {
    params: t.Object({
      clusterId: t.String()
    }),
    detail: {
      tags: ['cluster'],
      summary: 'Get cluster status',
      description: 'Retrieve the current status of the specified cluster'
    }
  })

