import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createApp } from './server/app.js';
import * as storage from './server/storage.js';

const isVercel = Boolean(process.env.VERCEL);

function adminFromEnv() {
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) return undefined;
  return {
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
    name: process.env.ADMIN_NAME || 'Admin Digital Garden',
  };
}

function shouldPersist(req) {
  return req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
}

export default async function handler(req, res) {
  // Vercel functions share /tmp between requests on the same instance but do
  // not guarantee which instance serves a request. Use a fresh directory per
  // request so every request starts from the latest snapshot in GitHub.
  const dataDir = process.env.DATA_DIR || (isVercel
    ? path.join('/tmp', `garden-${randomUUID()}`)
    : path.resolve('data'));

  try {
    await storage.loadDatabase(dataDir);
  } catch (error) {
    console.error('Gagal memuat database dari penyimpanan:', error);
    res.status(503).json({ message: 'Penyimpanan data sedang tidak tersedia. Coba lagi sebentar.' });
    return;
  }

  const ctx = await createApp({
    dataDir,
    appUrl: process.env.APP_URL || 'https://egardenxerpeel.vercel.app',
    nodeEnv: process.env.NODE_ENV || (isVercel ? 'production' : undefined),
    trustProxy: process.env.TRUST_PROXY === '1' || isVercel,
    staticDir: path.resolve('public'),
    admin: adminFromEnv(),
    storage,
  });

  let finished = false;
  const originalEnd = res.end.bind(res);
  res.end = async (...args) => {
    if (finished) return originalEnd(...args);
    finished = true;

    if (shouldPersist(req)) {
      try {
        // Close first so SQLite flushes any pending writes into garden.db
        // before the file is uploaded to persistent storage.
        ctx.close();
      } catch {
        // ignore close errors
      }
      try {
        await storage.saveDatabase(dataDir);
      } catch (error) {
        console.error('Gagal menyimpan database ke penyimpanan:', error);
      }
    } else {
      try {
        ctx.close();
      } catch {
        // ignore close errors
      }
    }
    if (isVercel) {
      rm(dataDir, { recursive: true, force: true }).catch(() => {});
    }
    return originalEnd(...args);
  };

  ctx.app(req, res);
}
