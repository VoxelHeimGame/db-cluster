import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL || 'postgres://postgres:root@localhost:5432';

const pool = new Pool({
  connectionString: databaseUrl,
});

export async function query(text: string, params?: any[]) {
  try {
    const result = await pool.query(text, params);
    return result;
  } catch (error) {
    console.error('Database query error:', error);
    throw error;
  }
}
