import { query } from '../db'

const MAX_CONNECTIONS_PER_NODE = 100
const CHECK_INTERVAL = 60000 // 1 minute
const MAX_WORKERS = 5 // Maximum number of worker nodes

async function checkAndScale() {
  try {
    const result = await query(`
      SELECT 
        (SELECT count(*) FROM citus_get_active_worker_nodes()) as worker_count,
        (SELECT count(*) FROM pg_stat_activity) as total_connections
    `);
    
    const { worker_count, total_connections } = result.rows[0];
    
    const avgConnectionsPerNode = total_connections / worker_count;
    
    if (avgConnectionsPerNode > MAX_CONNECTIONS_PER_NODE && worker_count < MAX_WORKERS) {
      console.log('High load detected, adding new worker node...');
      
      const newWorkerNum = worker_count + 1;
      const workerHost = `worker-${newWorkerNum}`;
      
      await query(`
        SELECT * FROM citus_add_node($1, $2)
      `, [workerHost, 5432]);
      
      console.log(`Added new worker node: ${workerHost}`);
      
      await query('SELECT rebalance_table_shards()');
      
      console.log('Shards rebalanced across nodes');
    }
  } catch (error) {
    console.error('Error in auto-scaling:', error);
  }
}

export function startAutoScaling() {
  console.log('Starting auto-scaling service...');
  setInterval(checkAndScale, CHECK_INTERVAL);
}

