import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const SESSION_COOKIE = 'garden_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_FORMATS = new Set(['jpeg', 'png', 'webp']);

const seedPlants = [
  ['krokot', 'Krokot'],
  ['lili-paris', 'Lili Paris'],
  ['asoka', 'Asoka'],
  ['rumput-jepang', 'Rumput Jepang'],
  ['pandan', 'Pandan'],
];

const plantFields = `id, slug, name, scientific_name, short_description, description,
  characteristics, benefits, care_guide, habitat, image_path, location_label,
  qr_url, status, verified_at, created_at, updated_at`;

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const plantInput = z.object({
  name: z.string({ error: 'Nama tanaman wajib diisi.' }).trim().min(1, 'Nama tanaman wajib diisi.').max(120, 'Nama tanaman terlalu panjang.'),
  slug: z.string().trim().max(80, 'Slug terlalu panjang.').optional(),
  scientific_name: z.string().trim().max(160).optional(),
  short_description: z.string().trim().max(600, 'Ringkasan terlalu panjang.').optional(),
  description: z.string().trim().max(20000, 'Deskripsi terlalu panjang.').optional(),
  characteristics: z.string().trim().max(10000, 'Karakteristik terlalu panjang.').optional(),
  benefits: z.string().trim().max(10000, 'Manfaat terlalu panjang.').optional(),
  care_guide: z.string().trim().max(10000, 'Panduan perawatan terlalu panjang.').optional(),
  habitat: z.string().trim().max(600).optional(),
  location_label: z.string().trim().max(200).optional(),
  status: z.enum(['draft', 'published'], { error: 'Status publikasi tidak valid.' }).default('draft'),
  verified: z.boolean().optional().default(false),
});

function nowIso() {
  return new Date().toISOString();
}

function normaliseOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return 'http://localhost:5173';
  }
}

export function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split(':');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function publicPlant(row) {
  return {
    id: Number(row.id),
    slug: row.slug,
    name: row.name,
    scientific_name: row.scientific_name || '',
    short_description: row.short_description || '',
    description: row.description || '',
    characteristics: row.characteristics || '',
    benefits: row.benefits || '',
    care_guide: row.care_guide || '',
    habitat: row.habitat || '',
    image_path: row.image_path || null,
    location_label: row.location_label || '',
    qr_url: row.qr_url || '',
    status: row.status,
    verified: Boolean(row.verified_at),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function adminPlant(row) {
  return publicPlant(row);
}

function validatePlantPayload(body, { existing } = {}) {
  const parsed = plantInput.safeParse(body || {});
  if (!parsed.success) {
    return {
      error: 'Periksa kembali data tanaman.',
      details: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'form',
        message: issue.message,
      })),
    };
  }
  const data = parsed.data;
  const slug = data.slug === undefined || data.slug === '' ? slugify(data.name) : data.slug;
  if (!slug || !slugPattern.test(slug)) {
    return {
      error: 'Slug hanya boleh berisi huruf kecil, angka, dan tanda hubung.',
      details: [{ field: 'slug', message: 'Gunakan contoh format: lili-paris.' }],
    };
  }
  if (existing && data.slug !== undefined && data.slug !== '' && data.slug !== existing.slug) {
    return {
      error: 'Slug tidak dapat diubah setelah tanaman dibuat.',
      details: [{ field: 'slug', message: 'Slug bersifat permanen agar QR Code yang sudah dicetak tetap berfungsi.' }],
    };
  }
  if (data.status === 'published') {
    if (!data.verified) {
      return {
        error: 'Konfirmasi verifikasi diperlukan sebelum menerbitkan tanaman.',
        details: [{ field: 'verified', message: 'Centang pernyataan verifikasi konten untuk menerbitkan.' }],
      };
    }
    const missing = [
      ['short_description', 'Ringkasan singkat'],
      ['description', 'Deskripsi lengkap'],
      ['characteristics', 'Karakteristik'],
      ['benefits', 'Manfaat & kegunaan'],
      ['care_guide', 'Panduan perawatan'],
    ].filter(([field]) => !String(data[field] || '').trim());
    if (missing.length) {
      return {
        error: 'Lengkapi konten wajib sebelum menerbitkan tanaman.',
        details: missing.map(([field, label]) => ({ field, message: `${label} wajib diisi untuk publikasi.` })),
      };
    }
  }
  return { data: { ...data, slug } };
}

export async function createApp(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || './data');
  const appUrl = (options.appUrl || process.env.APP_URL || 'http://localhost:5173').replace(/\/+$/, '');
  const expectedOrigin = normaliseOrigin(appUrl);
  const isProduction = (options.nodeEnv || process.env.NODE_ENV) === 'production';
  const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY === '1';
  const sessionSecret = options.sessionSecret || process.env.SESSION_SECRET || 'digital-garden-mvp-session-secret-change-me';
  const storage = options.storage || {};
  const uploadsDir = path.join(dataDir, 'uploads');
  const staticDir = options.staticDir ? path.resolve(options.staticDir) : null;

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(uploadsDir, { recursive: true });

  const db = new DatabaseSync(path.join(dataDir, 'garden.db'));
  db.exec(`
    PRAGMA journal_mode = ${storage.enabled ? 'DELETE' : 'WAL'};
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      scientific_name TEXT,
      short_description TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      characteristics TEXT NOT NULL DEFAULT '',
      benefits TEXT NOT NULL DEFAULT '',
      care_guide TEXT NOT NULL DEFAULT '',
      habitat TEXT,
      image_path TEXT,
      location_label TEXT,
      qr_url TEXT,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
      verified_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS plants_status_idx ON plants (status);
    CREATE INDEX IF NOT EXISTS plants_updated_idx ON plants (updated_at);
  `);

  const insertSeed = db.prepare(`
    INSERT OR IGNORE INTO plants
      (slug, name, short_description, description, characteristics, benefits, care_guide, status, qr_url, created_at, updated_at)
    VALUES (?, ?, '', '', '', '', '', 'draft', ?, ?, ?)
  `);
  const seededAt = nowIso();
  for (const [slug, name] of seedPlants) {
    insertSeed.run(slug, name, `${appUrl}/plants/${slug}`, seededAt, seededAt);
  }

  if (options.admin?.email && options.admin?.password) {
    const email = String(options.admin.email).trim().toLowerCase();
    const name = String(options.admin.name || 'Admin Digital Garden').trim();
    if (email && String(options.admin.password).length >= 8) {
      const stamp = nowIso();
      db.prepare(`
        INSERT INTO admins (name, email, password_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET
          name = excluded.name,
          password_hash = excluded.password_hash,
          updated_at = excluded.updated_at
      `).run(name, email, hashPassword(options.admin.password), stamp, stamp);
    }
  }

  const adminCount = Number(db.prepare('SELECT COUNT(*) AS n FROM admins').get().n || 0);
  if (adminCount === 0) {
    const email = String(options.admin?.email || process.env.ADMIN_EMAIL || 'admin@digitalgarden.local')
      .trim()
      .toLowerCase();
    const password = String(options.admin?.password || process.env.ADMIN_PASSWORD || 'Kokulikuler2026!');
    if (email && password.length >= 8) {
      const stamp = nowIso();
      db.prepare(`
        INSERT INTO admins (name, email, password_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('Admin Digital Garden', email, hashPassword(password), stamp, stamp);
    }
  }

  function encodeSession(session) {
    const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
    const signature = createHmac('sha256', sessionSecret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  function decodeSession(token) {
    if (!token || typeof token !== 'string') return null;
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return null;
    const expected = createHmac('sha256', sessionSecret).update(payload).digest('base64url');
    if (signature.length !== expected.length
      || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return null;
    }
    try {
      const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!session || !Number.isFinite(session.expiresAt) || session.expiresAt < Date.now()) return null;
      if (!Number.isInteger(session.adminId) || typeof session.csrf !== 'string' || !session.csrf) return null;
      return session;
    } catch {
      return null;
    }
  }

  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: isProduction ? {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    } : false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieParser());

  // Vercel only routes single-segment /api/* paths reliably. Alias the nested
  // admin endpoints to flat paths so the same Express routes can serve both.
  app.use((req, _res, next) => {
    const [pathname, rawQuery = ''] = req.url.split('?');
    const params = new URLSearchParams(rawQuery);
    const id = params.get('id');
    let target;

    if (pathname === '/api/image' && params.get('filename')) {
      target = `/uploads/${encodeURIComponent(params.get('filename'))}`;
      params.delete('filename');
    } else if (pathname === '/api/dashboard') {
      target = '/api/admin/dashboard';
    } else if (pathname === '/api/plant' && params.get('slug')) {
      target = `/api/plants/${encodeURIComponent(params.get('slug'))}`;
      params.delete('slug');
    } else if (pathname === '/api/admin-plants') {
      target = '/api/admin/plants';
    } else if (pathname === '/api/admin-plant' && id) {
      target = `/api/admin/plants/${encodeURIComponent(id)}`;
      params.delete('id');
    } else if (pathname === '/api/admin-image' && id) {
      target = `/api/admin/plants/${encodeURIComponent(id)}/image`;
      params.delete('id');
    } else if (pathname === '/api/admin-qr' && id) {
      target = `/api/admin/plants/${encodeURIComponent(id)}/qr`;
      params.delete('id');
    }

    if (target) {
      const rest = params.toString();
      req.url = `${target}${rest ? `?${rest}` : ''}`;
    }
    return next();
  });

  function sessionFromRequest(req) {
    const token = req.cookies?.[SESSION_COOKIE];
    const session = decodeSession(token);
    return session ? { token, ...session } : null;
  }

  function requireAuth(req, res, next) {
    const session = sessionFromRequest(req);
    if (!session) {
      return res.status(401).json({ message: 'Silakan masuk terlebih dahulu.' });
    }
    const admin = db.prepare('SELECT id, name, email FROM admins WHERE id = ?').get(session.adminId);
    if (!admin) {
      return res.status(401).json({ message: 'Sesi tidak valid. Silakan masuk kembali.' });
    }
    req.session = session;
    req.admin = admin;
    return next();
  }

  function requireSameOrigin(req, res, next) {
    const origin = req.get('origin');
    if (!origin) return next();
    if (normaliseOrigin(origin) !== expectedOrigin) {
      return res.status(403).json({ message: 'Permintaan lintas situs ditolak.' });
    }
    return next();
  }

  function requireCsrf(req, res, next) {
    const provided = String(req.get('x-csrf-token') || '');
    const expected = String(req.session?.csrf || '');
    if (!provided || !expected || provided.length !== expected.length
      || !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
      return res.status(403).json({ message: 'Token keamanan tidak valid. Muat ulang halaman.' });
    }
    return next();
  }

  const writeGuard = [requireSameOrigin, requireAuth, requireCsrf];

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 1, fieldSize: 128 * 1024 },
  });

  function receiveImage(req, res, next) {
    upload.single('image')(req, res, (error) => {
      if (!error) return next();
      const tooLarge = error.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 422).json({
        message: tooLarge ? 'Ukuran foto maksimal 5 MB.' : 'Foto tidak dapat diproses.',
        errors: [{ field: 'image', message: tooLarge ? 'Ukuran foto maksimal 5 MB.' : 'Gunakan satu foto JPG, PNG, atau WebP.' }],
      });
    });
  }

  async function optimiseImage(file) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      throw new Error('Format foto harus JPG, PNG, atau WebP.');
    }
    try {
      const input = sharp(file.buffer, { limitInputPixels: 40_000_000 });
      const metadata = await input.metadata();
      if (!ALLOWED_IMAGE_FORMATS.has(metadata.format)) throw new Error('Format gambar tidak didukung.');
      return await input.rotate()
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 }).toBuffer();
    } catch {
      throw new Error('File gambar tidak valid atau terlalu besar untuk diproses. Gunakan JPG, PNG, atau WebP.');
    }
  }

  // Validate/decode before changing any plant data. A failed upload must not
  // publish an incomplete record, nor make retries fail with duplicate slugs.
  async function parsePlantRequest(req, res, next) {
    if (req.is('multipart/form-data')) {
      try { req.body = JSON.parse(req.body?.data || '{}'); }
      catch { return res.status(422).json({ message: 'Format data tanaman tidak valid.' }); }
      if (req.file) {
        try { req.optimisedImage = await optimiseImage(req.file); }
        catch (error) {
          return res.status(422).json({ message: error.message, errors: [{ field: 'image', message: error.message }] });
        }
      }
    }
    return next();
  }

  async function storeImage(buffer, slug) {
    const filename = `${slug}-${randomBytes(12).toString('hex')}.webp`;
    await writeFile(path.join(uploadsDir, filename), buffer, { flag: 'wx' });
    await storage.saveUpload?.(filename, buffer);
    return `/api/image?filename=${filename}`;
  }

  function imageFilename(imagePath) {
    const url = new URL(imagePath, appUrl);
    return path.basename(url.searchParams.get('filename') || url.pathname);
  }

  async function removeImage(imagePath) {
    if (!imagePath) return;
    const filename = imageFilename(imagePath);
    await unlink(path.join(uploadsDir, filename)).catch(() => {});
    await storage.deleteUpload?.(filename).catch(() => {});
  }

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Terlalu banyak percobaan masuk. Coba lagi beberapa menit lagi.' },
  });

  const findPlantById = db.prepare(`SELECT ${plantFields} FROM plants WHERE id = ?`);
  const findPlantBySlug = db.prepare(`SELECT ${plantFields} FROM plants WHERE slug = ?`);

  function plantOr404(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(404).json({ message: 'Tanaman tidak ditemukan.' });
      return null;
    }
    const plant = findPlantById.get(id);
    if (!plant) {
      res.status(404).json({ message: 'Tanaman tidak ditemukan.' });
      return null;
    }
    return plant;
  }

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/api/plants', (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const rows = q
      ? db.prepare(`SELECT ${plantFields} FROM plants
          WHERE status = 'published' AND (lower(name) LIKE ? OR lower(slug) LIKE ?)
          ORDER BY lower(name) ASC`).all(`%${q}%`, `%${q}%`)
      : db.prepare(`SELECT ${plantFields} FROM plants
          WHERE status = 'published'
          ORDER BY lower(name) ASC`).all();
    res.json({ data: rows.map(publicPlant), meta: { total: rows.length } });
  });

  app.get('/api/plants/:slug', (req, res) => {
    const plant = findPlantBySlug.get(String(req.params.slug));
    if (!plant || plant.status !== 'published') {
      return res.status(404).json({ message: 'Tanaman tidak ditemukan.' });
    }
    return res.json({ data: publicPlant(plant) });
  });

  app.post('/api/login', loginLimiter, requireSameOrigin, (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) {
      return res.status(422).json({ message: 'Email dan kata sandi wajib diisi.' });
    }
    const admin = db.prepare('SELECT id, name, email, password_hash FROM admins WHERE email = ?').get(email);
    if (!admin || !verifyPassword(password, admin.password_hash)) {
      return res.status(401).json({ message: 'Email atau kata sandi salah.' });
    }
    const csrf = randomBytes(24).toString('base64url');
    const token = encodeSession({
      adminId: Number(admin.id),
      csrf,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: isProduction,
      path: '/',
      maxAge: SESSION_TTL_MS,
    });
    return res.json({
      data: {
        admin: { id: Number(admin.id), name: admin.name, email: admin.email },
        csrf,
      },
      message: 'Berhasil masuk.',
    });
  });

  app.get('/api/me', requireAuth, (req, res) => {
    res.json({
      data: {
        admin: { id: Number(req.admin.id), name: req.admin.name, email: req.admin.email },
        csrf: req.session.csrf,
      },
    });
  });

  app.post('/api/logout', ...writeGuard, (req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ message: 'Berhasil keluar.' });
  });

  app.get('/api/admin/dashboard', requireAuth, (_req, res) => {
    const counts = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published,
        SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft
      FROM plants
    `).get();
    const recent = db.prepare(`SELECT ${plantFields} FROM plants ORDER BY updated_at DESC, id DESC LIMIT 5`).all();
    res.json({
      data: {
        total: Number(counts.total || 0),
        published: Number(counts.published || 0),
        draft: Number(counts.draft || 0),
        recent: recent.map(adminPlant),
      },
    });
  });

  app.get('/api/admin/plants', requireAuth, (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;
    const where = q ? 'WHERE lower(name) LIKE ? OR lower(slug) LIKE ?' : '';
    const params = q ? [`%${q}%`, `%${q}%`] : [];
    const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM plants ${where}`).get(...params).n || 0);
    const rows = db.prepare(`SELECT ${plantFields} FROM plants ${where}
      ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    res.json({
      data: rows.map(adminPlant),
      meta: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) },
    });
  });

  app.get('/api/admin/plants/:id', requireAuth, (req, res) => {
    const plant = plantOr404(req, res);
    if (!plant) return;
    res.json({ data: adminPlant(plant) });
  });

  app.post('/api/admin/plants', ...writeGuard, receiveImage, parsePlantRequest, async (req, res) => {
    const result = validatePlantPayload(req.body);
    if (result.error) {
      return res.status(422).json({ message: result.error, errors: result.details });
    }
    const data = result.data;
    const stamp = nowIso();
    const qrUrl = `${appUrl}/plants/${data.slug}`;
    let imagePath;
    try {
      imagePath = req.optimisedImage ? await storeImage(req.optimisedImage, data.slug) : null;
      const inserted = db.prepare(`
        INSERT INTO plants
          (slug, name, scientific_name, short_description, description, characteristics,
           benefits, care_guide, habitat, location_label, qr_url, status, verified_at, created_at, updated_at, image_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        data.slug, data.name, data.scientific_name || '', data.short_description || '',
        data.description || '', data.characteristics || '', data.benefits || '',
        data.care_guide || '', data.habitat || '', data.location_label || '', qrUrl,
        data.status, data.status === 'published' ? stamp : null, stamp, stamp, imagePath,
      );
      const plant = findPlantById.get(Number(inserted.lastInsertRowid));
      return res.status(201).json({ data: adminPlant(plant), message: 'Tanaman berhasil disimpan.' });
    } catch (error) {
      await removeImage(imagePath);
      if (String(error?.message || '').includes('UNIQUE')) {
        return res.status(409).json({
          message: 'Slug sudah digunakan oleh tanaman lain.',
          errors: [{ field: 'slug', message: 'Pilih nama atau slug yang berbeda.' }],
        });
      }
      throw error;
    }
  });

  app.put('/api/admin/plants/:id', ...writeGuard, receiveImage, parsePlantRequest, async (req, res) => {
    const existing = plantOr404(req, res);
    if (!existing) return;
    const result = validatePlantPayload(req.body, { existing });
    if (result.error) {
      return res.status(422).json({ message: result.error, errors: result.details });
    }
    const data = result.data;
    const stamp = nowIso();
    const verifiedAt = data.status === 'published'
      ? (existing.verified_at || stamp)
      : existing.verified_at;
    const imagePath = req.optimisedImage ? await storeImage(req.optimisedImage, existing.slug) : existing.image_path;
    try {
      db.prepare(`
      UPDATE plants SET
        name = ?, scientific_name = ?, short_description = ?, description = ?,
        characteristics = ?, benefits = ?, care_guide = ?, habitat = ?,
        location_label = ?, status = ?, verified_at = ?, updated_at = ?, image_path = ?
      WHERE id = ?
    `).run(
      data.name, data.scientific_name || '', data.short_description || '',
      data.description || '', data.characteristics || '', data.benefits || '',
      data.care_guide || '', data.habitat || '', data.location_label || '',
      data.status, verifiedAt, stamp, imagePath, existing.id,
    );
    } catch (error) {
      if (req.optimisedImage) await removeImage(imagePath);
      throw error;
    }
    if (req.optimisedImage) await removeImage(existing.image_path);
    res.json({ data: adminPlant(findPlantById.get(Number(existing.id))), message: 'Perubahan disimpan.' });
  });

  app.delete('/api/admin/plants/:id', ...writeGuard, async (req, res) => {
    const plant = plantOr404(req, res);
    if (!plant) return;
    db.prepare('DELETE FROM plants WHERE id = ?').run(plant.id);
    await removeImage(plant.image_path);
    res.json({ message: 'Tanaman dihapus.' });
  });

  app.post('/api/admin/plants/:id/image', ...writeGuard, (req, res, next) => {
    const plant = plantOr404(req, res);
    if (!plant) return;
    req.plant = plant;
    return receiveImage(req, res, next);
  }, async (req, res) => {
    if (!req.file) {
      return res.status(422).json({ message: 'Pilih file foto terlebih dahulu.' });
    }
    let buffer;
    try {
      buffer = await optimiseImage(req.file);
    } catch (error) {
      return res.status(422).json({ message: error.message });
    }
    const imagePath = await storeImage(buffer, req.plant.slug);
    try {
      db.prepare('UPDATE plants SET image_path = ?, updated_at = ? WHERE id = ?')
        .run(imagePath, nowIso(), req.plant.id);
    } catch (error) {
      await removeImage(imagePath);
      throw error;
    }
    await removeImage(req.plant.image_path);
    res.json({
      data: adminPlant(findPlantById.get(Number(req.plant.id))),
      message: 'Foto tanaman berhasil diperbarui.',
    });
  });

  app.get('/api/admin/plants/:id/qr', requireAuth, async (req, res) => {
    const plant = plantOr404(req, res);
    if (!plant) return;
    const format = req.query.format === 'png' ? 'png' : 'svg';
    const target = plant.qr_url || `${appUrl}/plants/${plant.slug}`;
    const inline = req.query.download === '0';
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${plant.slug}.${format}"`,
    );
    if (format === 'png') {
      const buffer = await QRCode.toBuffer(target, { type: 'png', width: 720, margin: 2, errorCorrectionLevel: 'M' });
      res.type('image/png').send(buffer);
      return;
    }
    const svg = await QRCode.toString(target, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
    // Sent as text so the SVG source is readable by API clients; browsers save it as .svg.
    res.type('text/plain; charset=utf-8').send(svg);
  });

  app.get('/uploads/:filename', async (req, res) => {
    const filename = path.basename(String(req.params.filename || ''));
    const imagePath = `/api/image?filename=${filename}`;
    const plant = db.prepare('SELECT id, status FROM plants WHERE image_path = ? OR image_path = ?')
      .get(imagePath, `/uploads/${filename}`);
    if (!plant) {
      return res.status(404).json({ message: 'Foto tidak ditemukan.' });
    }
    if (plant.status !== 'published' && !sessionFromRequest(req)) {
      return res.status(404).json({ message: 'Foto tidak ditemukan.' });
    }
    const filePath = path.join(uploadsDir, filename);
    if (!existsSync(filePath)) {
      const remote = await storage.readUpload?.(filename).catch(() => null);
      if (remote) {
        res.setHeader('Cache-Control', 'private, no-store');
        return res.type('image/webp').send(remote);
      }
      return res.status(404).json({ message: 'Foto tidak ditemukan.' });
    }
    return res.sendFile(filePath, {
      dotfiles: 'allow',
      headers: {
        'Cache-Control': 'private, no-store',
      },
    }, (error) => {
      if (error && !res.headersSent) {
        res.status(404).json({ message: 'Foto tidak ditemukan.' });
      }
    });
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ message: 'Endpoint tidak ditemukan.' });
  });

  if (staticDir && existsSync(path.join(staticDir, 'index.html'))) {
    app.use(express.static(staticDir, { index: false }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (req.path.startsWith('/uploads/')) {
        return res.status(404).json({ message: 'Foto tidak ditemukan.' });
      }
      return res.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  app.use((error, _req, res, _next) => {
    if (error?.type === 'entity.too.large') {
      return res.status(413).json({ message: 'Permintaan terlalu besar.' });
    }
    if (error instanceof SyntaxError && 'body' in error) {
      return res.status(400).json({ message: 'Format data tidak valid.' });
    }
    console.error(error);
    return res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
  });

  return {
    app,
    db,
    dataDir,
    appUrl,
    close() {
      db.close();
    },
  };
}
