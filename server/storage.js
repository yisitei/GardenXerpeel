import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const token = process.env.GITHUB_DATA_TOKEN;
const repo = process.env.GITHUB_DATA_REPO;
const branch = process.env.GITHUB_DATA_BRANCH || 'main';

export const enabled = Boolean(token && repo);

async function request(filePath, options = {}) {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/contents/${filePath}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'digital-garden',
        ...(options.headers || {}),
      },
    },
  );
  return response;
}

async function getFile(filePath) {
  const response = await request(`${filePath}?ref=${encodeURIComponent(branch)}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GitHub read ${filePath} failed: ${response.status}`);
  }
  const data = await response.json();
  let buffer;
  if (data.content) {
    buffer = Buffer.from(data.content, 'base64');
  } else if (data.download_url) {
    const download = await fetch(data.download_url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'digital-garden',
      },
    });
    if (!download.ok) {
      throw new Error(`GitHub download ${filePath} failed: ${download.status}`);
    }
    buffer = Buffer.from(await download.arrayBuffer());
  } else {
    return null;
  }
  return { buffer, sha: data.sha };
}

async function putFile(filePath, buffer, message, attempt = 0) {
  const existing = await getFile(filePath);
  const body = {
    message,
    content: buffer.toString('base64'),
    branch,
  };
  if (existing?.sha) body.sha = existing.sha;

  const response = await request(filePath, {
    method: 'PUT',
    body: JSON.stringify(body),
  });

  if (response.status === 409 && attempt < 2) {
    return putFile(filePath, buffer, message, attempt + 1);
  }
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub write ${filePath} failed: ${response.status} ${detail}`);
  }
}

export async function loadDatabase(dataDir) {
  if (!enabled) return false;
  const file = await getFile('garden.db');
  if (!file) return false;
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, 'garden.db'), file.buffer);
  return true;
}

export async function saveDatabase(dataDir) {
  if (!enabled) return;
  const buffer = await readFile(path.join(dataDir, 'garden.db'));
  await putFile('garden.db', buffer, `data: ${new Date().toISOString()}`);
}

export async function saveUpload(filename, buffer) {
  if (!enabled) return;
  await putFile(`uploads/${filename}`, buffer, `upload: ${filename}`);
}

export async function readUpload(filename) {
  if (!enabled) return null;
  const file = await getFile(`uploads/${filename}`);
  return file?.buffer || null;
}

export async function deleteUpload(filename) {
  if (!enabled) return;
  const file = await getFile(`uploads/${filename}`);
  if (!file?.sha) return;
  const response = await request(`uploads/${filename}`, {
    method: 'DELETE',
    body: JSON.stringify({
      message: `delete: ${filename}`,
      sha: file.sha,
      branch,
    }),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`GitHub delete ${filename} failed: ${response.status}`);
  }
}
