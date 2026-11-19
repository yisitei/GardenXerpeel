import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from '../server/app.js';

test('multipart publication saves content and image together through Vercel aliases', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'garden-upload-'));
  const origin = 'http://localhost:5173';
  const ctx = await createApp({ dataDir, appUrl: origin });
  const agent = request.agent(ctx.app);
  try {
    const login = await agent.post('/api/login').send({email:'admin@digitalgarden.local', password:'Kokulikuler2026!'}).expect(200);
    const csrf = login.body.data.csrf;
    const write = (method, url) => agent[method](url).set('Origin', origin).set('X-CSRF-Token', csrf);
    const content = {name:'Tanaman foto',slug:'tanaman-foto',short_description:'Ringkasan uji',description:'Deskripsi uji',characteristics:'Karakteristik uji',benefits:'Manfaat uji',care_guide:'Perawatan uji',verified:true,status:'published'};
    const png = await sharp({create:{width:80,height:60,channels:3,background:'#245640'}}).png().toBuffer();
    const created = await write('post','/api/admin-plants').field('data',JSON.stringify(content)).attach('image',png,{filename:'foto.png',contentType:'image/png'}).expect(201);
    const plant = created.body.data;
    assert.equal(plant.status,'published');
    assert.match(plant.image_path,/^\/api\/image\?filename=/);
    await request(ctx.app).get(plant.image_path).expect(200).expect('Content-Type',/image\/webp/);
    await request(ctx.app).get('/api/plant?slug=tanaman-foto').expect(200);
    await write('put',`/api/admin-plant?id=${plant.id}`).field('data',JSON.stringify({...content,name:'Jangan disimpan'})).attach('image',Buffer.from('not an image'),{filename:'bad.png',contentType:'image/png'}).expect(422);
    const unchanged = await agent.get(`/api/admin-plant?id=${plant.id}`).expect(200);
    assert.equal(unchanged.body.data.name,content.name);
    assert.equal(unchanged.body.data.image_path,plant.image_path);
    await write('post','/api/admin-plants').field('data',JSON.stringify({...content,slug:'invalid-photo'})).attach('image',Buffer.from('not an image'),{filename:'bad.png',contentType:'image/png'}).expect(422);
    assert.equal((await agent.get('/api/admin-plants?q=invalid-photo')).body.meta.total,0);
    const draft = await write('put',`/api/admin-plant?id=${plant.id}`).field('data',JSON.stringify({...content,status:'draft'})).attach('image',png,{filename:'foto.png',contentType:'image/png'}).expect(200);
    await request(ctx.app).get(draft.body.data.image_path).expect(404);
    await agent.get(draft.body.data.image_path).expect(200);
    const oldFile = new URL(plant.image_path,origin).searchParams.get('filename');
    await request(ctx.app).get(`/uploads/${oldFile}`).expect(404);
  } finally { ctx.close(); await rm(dataDir,{recursive:true,force:true}); }
});
