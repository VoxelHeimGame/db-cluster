import { Elysia, t } from 'elysia';
import { query } from '../db';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execAsync = promisify(exec);

// Increase the timeout to 5 minutes (300000 ms)
const EXEC_TIMEOUT = 300000;

// Function to normalize paths between Windows and Linux
function normalizePath(inputPath: string): string {
  return inputPath.replace(/\\/g, '/');
}

// Function to get the project root directory
function getRootDir(): string {
  let currentDir = __dirname;
  while (currentDir !== path.parse(currentDir).root) {
    if (fs.existsSync(path.join(currentDir, 'docker'))) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }
  throw new Error('Docker directory not found in project structure');
}

// Function to execute bash scripts and parse the output
async function executeBashScript(scriptName: string, args: string[] = []): Promise<{ success: boolean; output: string; workerIp?: string }> {
  try {
    const rootDir = getRootDir();
    const dockerDir = path.join(rootDir, 'docker');
    const scriptPath = path.join(dockerDir, scriptName);
    
    const normalizedScriptPath = normalizePath(scriptPath);
    const isWindows: boolean = process.platform === 'win32';
    
    let command;
    if (isWindows) {
      const gitBashPath = 'C:\\Program Files\\Git\\bin\\bash.exe';
      command = `"${gitBashPath}" -c "cd '${dockerDir}' && ./${scriptName} ${args.join(' ')}"`;
    } else {
      command = `cd '${dockerDir}' && bash ${scriptName} ${args.join(' ')}`;
    }

    console.log(`Executing command: ${command}`);
    console.log(`Working directory: ${dockerDir}`);

    const { stdout, stderr } = await execAsync(command, {
      cwd: dockerDir,
      timeout: EXEC_TIMEOUT,
      shell: isWindows ? 'cmd.exe' : '/bin/bash'
    });

    // Log complete output for debugging
    console.log('Script stdout:', stdout);
    if (stderr) {
      console.warn('Script stderr:', stderr);
    }

    // Parse the output based on the script being executed
    let success = false;
    let workerIp: string | undefined;

    if (scriptName === 'start_cluster.sh') {
      success = stdout.includes('🎉 Citus Cluster') && stdout.includes('started successfully');
      const ipMatch = stdout.match(/Registering worker (\d+\.\d+\.\d+\.\d+)/);
      workerIp = ipMatch ? ipMatch[1] : undefined;
    } 
    else if (scriptName === 'stop_cluster.sh') {
      success = stdout.includes('Citus Cluster') && stdout.includes('stopped and cleaned up completely');
    }
    else if (scriptName === 'add_worker.sh') {
      success = stdout.includes('Worker(s) added and registered to the Citus cluster successfully');
      const ipMatch = stdout.match(/Registering worker (\d+\.\d+\.\d+\.\d+)/);
      workerIp = ipMatch ? ipMatch[1] : undefined;
    }
    else if (scriptName === 'delete_worker.sh') {
      success = stdout.includes('Workers removed successfully from both Docker and the Citus cluster');
    }

    // The warning about orphan containers is expected and shouldn't affect success
    if (stderr && !stderr.includes('Found orphan containers')) {
      console.warn('Non-orphan warning in stderr:', stderr);
    }

    return { success, output: stdout, workerIp };
  } catch (error) {
    console.error('Script execution error:', error);
    return { 
      success: false, 
      output: error instanceof Error ? error.message : 'Unknown error occurred' 
    };
  }
}

// Function to get cluster status
async function getClusterStatus(clusterId: string): Promise<{ 
  isRunning: boolean; 
  workerCount: number;
  workers: { nodename: string; nodeport: string }[] 
}> {
  try {
    const result = await query('SELECT * FROM citus_get_active_worker_nodes()');
    return {
      isRunning: result.rows.length > 0,
      workerCount: result.rows.length,
      workers: result.rows.map(row => ({ nodename: row.node_name, nodeport: row.node_port }))
    };
  } catch (error) {
    console.error(`Error getting cluster status: ${error}`);
    return { isRunning: false, workerCount: 0, workers: [] };
  }
}

// Function to start a cluster
async function startCluster(clusterId: string, workersCount: number): Promise<{ success: boolean; status: Awaited<ReturnType<typeof getClusterStatus>> }> {
  const result = await executeBashScript('start_cluster.sh', [clusterId, workersCount.toString()]);
  if (result.success) {
    const status = await getClusterStatus(clusterId);
    return { success: true, status };
  }
  return { success: false, status: { isRunning: false, workerCount: 0, workers: [] } };
}

// Function to stop a cluster
async function stopCluster(clusterId: string): Promise<{ success: boolean }> {
  const result = await executeBashScript('stop_cluster.sh', [clusterId]);
  return { success: result.success };
}

// Function to add a new worker using Docker script
async function addWorkerWithDockerScript(clusterId: string, totalWorkers: number): Promise<{ success: boolean; workerIp?: string; output: string }> {
  const result = await executeBashScript('add_worker.sh', [clusterId, (totalWorkers + 1).toString()]);
  const success = result.output.includes('Worker(s) added and registered to the Citus cluster') && 
                  !result.output.includes('Failed to register worker');
  const ipMatch = result.output.match(/Registering worker (\d+\.\d+\.\d+\.\d+)/);
  const workerIp = ipMatch ? ipMatch[1] : undefined;
  return { success, workerIp, output: result.output };
}

// Function to remove workers using Docker script
async function removeWorkersWithDockerScript(clusterId: string, workersToKeep: number): Promise<boolean> {
  const result = await executeBashScript('delete_worker.sh', [clusterId, workersToKeep.toString()]);
  return result.success;
}

// Cluster routes
export const clusterRoutes = new Elysia({ prefix: '/cluster' })
  .onError(({ code, error }) => {
    console.error(`Error in cluster routes (${code}):`, error);
    return {
      success: false,
      error: error.message,
      code
    };
  })
  .post('/:clusterId/start', async ({ params, body }) => {
    const { clusterId } = params;
    const { workersCount } = body;
    console.log(`Starting cluster ${clusterId} with ${workersCount} workers...`);
    try {
      const result = await startCluster(clusterId, workersCount);
      if (result.success) {
        return { 
          success: true, 
          message: `Cluster ${clusterId} started successfully`,
          status: result.status
        };
      } else {
        throw new Error(`Failed to start cluster ${clusterId}`);
      }
    } catch (error) {
      console.error(`Error starting cluster ${clusterId}:`, error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'An unknown error occurred'
      };
    }
  }, {
    body: t.Object({
      workersCount: t.Number()
    })
  })
  .post('/:clusterId/stop', async ({ params }) => {
    const { clusterId } = params;
    console.log(`Stopping cluster ${clusterId}...`);
    try {
      const result = await stopCluster(clusterId);
      if (result.success) {
        return { 
          success: true, 
          message: `Cluster ${clusterId} stopped successfully`
        };
      } else {
        throw new Error(`Failed to stop cluster ${clusterId}`);
      }
    } catch (error) {
      console.error(`Error stopping cluster ${clusterId}:`, error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'An unknown error occurred'
      };
    }
  })
  .get('/:clusterId/workers', async ({ params }) => {
    const { clusterId } = params;
    console.log(`Fetching worker nodes for cluster ${clusterId}...`);
    try {
      const result = await query('SELECT * FROM citus_get_active_worker_nodes()');
      return result.rows;
    } catch (error) {
      console.error(`Error fetching worker nodes for cluster ${clusterId}:`, error);
      throw new Error('Failed to fetch worker nodes');
    }
  })
  .post('/:clusterId/workers/add', async ({ params }) => {
    const { clusterId } = params;
    console.log(`Adding new worker node to cluster ${clusterId}...`);
    try {
      const currentWorkers = await query('SELECT COUNT(*) FROM citus_get_active_worker_nodes()');
      const currentWorkerCount = parseInt(currentWorkers.rows[0].count);

      const { success, workerIp } = await addWorkerWithDockerScript(clusterId, currentWorkerCount);
      if (!success || !workerIp) {
        throw new Error(`Failed to start new worker for cluster ${clusterId}`);
      }

      console.log(`New worker added and verified: ${workerIp}`);
      return { success: true, message: 'Worker node added successfully', node: workerIp };
    } catch (error) {
      console.error(`Error adding worker node to cluster ${clusterId}:`, error);
      return { success: false, error: error instanceof Error ? error.message : 'An unknown error occurred' };
    }
  })
  .post('/:clusterId/workers/remove', async ({ params }) => {
    const { clusterId } = params;
    console.log(`Removing worker node from cluster ${clusterId}...`);
    try {
      const workers = await query('SELECT COUNT(*) FROM citus_get_active_worker_nodes()');
      const workerCount = parseInt(workers.rows[0].count);
      
      if (workerCount <= 1) {
        return { success: false, error: 'Cannot remove the last worker node' };
      }

      const workersToKeep = workerCount - 1;
      console.log(`Removing workers to keep ${workersToKeep} nodes...`);

      const isWorkerRemoved = await removeWorkersWithDockerScript(clusterId, workersToKeep);
      if (!isWorkerRemoved) {
        throw new Error(`Failed to remove workers from cluster ${clusterId}`);
      }

      // Verify the number of remaining workers
      const remainingWorkers = await query('SELECT COUNT(*) FROM citus_get_active_worker_nodes()');
      const actualRemainingWorkers = parseInt(remainingWorkers.rows[0].count);

      if (actualRemainingWorkers !== workersToKeep) {
        console.warn(`Expected ${workersToKeep} workers, but found ${actualRemainingWorkers}`);
      }

      console.log(`Workers removed successfully. Remaining workers: ${actualRemainingWorkers}`);
      return { success: true, message: `Workers removed successfully. Remaining workers: ${actualRemainingWorkers}` };
    } catch (error) {
      console.error(`Error removing worker node from cluster ${clusterId}:`, error);
      return { success: false, error: error instanceof Error ? error.message : 'An unknown error occurred' };
    }
  })
  .get('/:clusterId/status', async ({ params }) => {
    const { clusterId } = params;
    console.log(`Fetching status for cluster ${clusterId}...`);
    try {
      const status = await getClusterStatus(clusterId);
      return { 
        success: true, 
        status 
      };
    } catch (error) {
      console.error(`Error fetching status for cluster ${clusterId}:`, error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'An unknown error occurred'
      };
    }
  });

