import { Elysia } from 'elysia'
import { query } from '../db'

export const healthRoutes = new Elysia()
  .get('/health', async () => {
    try {
      await query('SELECT 1');
      return { 
        status: 'OK',
        database: 'connected'
      };
    } catch (error) {
      return { 
        status: 'ERROR',
        database: 'disconnected',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

