import { Hono } from 'hono';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const dashboardRoutes = new Hono();

// Live dashboard — real data only
dashboardRoutes.get('/', (c) => {
  const html = readFileSync(join(__dirname, '../dashboard-live.html'), 'utf-8');
  c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  c.header('Pragma', 'no-cache');
  c.header('Expires', '0');
  return c.html(html);
});

// Demo dashboard (100 customers simulation — for reference only)
dashboardRoutes.get('/demo', (c) => {
  const html = readFileSync('/root/mrdelegate/life/admin-demo-100.html', 'utf-8');
  return c.html(html);
});
