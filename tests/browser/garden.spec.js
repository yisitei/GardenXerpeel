import { test, expect } from '@playwright/test';
import sharp from 'sharp';
test('public catalogue is private-by-default and works on mobile', async ({page}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', {name:'Kenali yang tumbuh di sekitar kita.'})).toBeVisible();
  await expect(page.getByText('Taman sedang dipersiapkan')).toBeVisible();
  await page.goto('/plants/krokot');
  await expect(page.getByRole('heading',{name:'Tanaman belum ditemukan'})).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  await page.goto('/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});
test('admin can create, upload, publish, preview, download QR, unpublish and delete', async ({page}) => {
  await page.addInitScript(() => {
    const send = window.fetch.bind(window);
    window.fetch = async (url, init) => {
      if (init?.body instanceof FormData) {
        window.uploadBodyBytes = (await new Response(init.body).arrayBuffer()).byteLength;
      }
      return send(url, init);
    };
  });
  await page.goto('/admin');
  await expect(page.getByRole('heading',{name:'Selamat datang kembali.'})).toBeVisible();
  await page.getByLabel('Email').fill('browser@example.com');
  await page.getByLabel('Kata sandi').fill('browser-test-password-123');
  await page.getByRole('button',{name:'Masuk ke dashboard'}).click();
  await expect(page.getByRole('heading',{name:'Taman yang terus bertumbuh.'})).toBeVisible();
  await page.getByRole('link',{name:'Tambah tanaman',exact:true}).first().click();
  await page.getByLabel('Nama tanaman', {exact:true}).fill('Tanaman Browser');
  await page.getByLabel('Ringkasan singkat').fill('Informasi ringkas untuk pengujian.');
  await page.getByLabel('Deskripsi lengkap').fill('Konten pengujian, bukan informasi botani.');
  await page.getByLabel('Karakteristik').fill('Daun sebagai contoh pengujian.');
  await page.getByLabel('Manfaat & kegunaan').fill('Contoh taman.');
  await page.getByLabel('Panduan perawatan').fill('Konten uji perawatan.');
  await page.getByLabel('Saya sudah memverifikasi').check();
  // A source image near 5 MB used to exceed Vercel's 4.5 MB request cap.
  const png = await sharp({create:{width:120,height:80,channels:3,background:'#245640'}}).png().toBuffer();
  const largePhoto = Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024 - png.length)]);
  await page.locator('input[type=file]').setInputFiles({name:'large.png',mimeType:'image/png',buffer:largePhoto});
  await expect(page.getByRole('img',{name:'Pratinjau foto tanaman'})).toBeVisible();
  const uploadResponse = page.waitForResponse(res => res.url().endsWith('/api/admin-plants') && res.request().method() === 'POST');
  await page.getByRole('button',{name:'Terbitkan tanaman'}).click();
  const uploaded = await uploadResponse;
  await uploaded.finished();
  expect(uploaded.status()).toBe(201);
  const uploadBodyBytes = await page.evaluate(() => window.uploadBodyBytes);
  expect(uploadBodyBytes).toBeGreaterThan(0);
  expect(uploadBodyBytes).toBeLessThan(1600 * 1024);
  await expect(page.getByRole('heading',{name:'Data tanaman',exact:true})).toBeVisible();
  await page.getByPlaceholder('Cari nama tanaman...').fill('Tanaman Browser');
  await expect(page.getByRole('cell',{name:'Terbit',exact:true})).toBeVisible();
  await page.getByRole('link',{name:'Edit Tanaman Browser'}).click();
  await page.getByLabel('Foto tanaman').setInputFiles({name:'plant.png',mimeType:'image/png',buffer:png});
  await page.getByRole('button',{name:'Terbitkan tanaman'}).click();
  await expect(page.getByRole('heading',{name:'Data tanaman',exact:true})).toBeVisible();
  await page.goto('/plants/tanaman-browser');
  await expect(page.getByRole('heading',{name:'Tanaman Browser'})).toBeVisible();
  await expect(page.getByRole('img',{name:'Tanaman Browser',exact:true})).toBeVisible();
  await expect(page.getByRole('img',{name:'Tanaman Browser',exact:true})).toHaveJSProperty('naturalWidth',120);
  await page.goto('/admin/qr');
  const qrCard = page.locator('.qr-card').filter({has: page.getByRole('heading',{name:'Tanaman Browser'})});
  const download = page.waitForEvent('download');
  await qrCard.getByRole('link',{name:'SVG'}).click();
  expect((await download).suggestedFilename()).toBe('tanaman-browser.svg');
  await page.goto('/admin/plants');
  await page.getByRole('link',{name:'Edit Tanaman Browser'}).click();
  await page.getByRole('button',{name:'Simpan draft'}).click();
  await expect(page.getByRole('heading',{name:'Data tanaman',exact:true})).toBeVisible();
  await page.goto('/plants/tanaman-browser');
  await expect(page.getByRole('heading',{name:'Tanaman belum ditemukan'})).toBeVisible();
  await page.goto('/admin/plants');
  await page.getByRole('button',{name:'Hapus Tanaman Browser'}).click();
  await page.getByRole('button',{name:'Ya, hapus tanaman'}).click();
  await expect(page.getByRole('link',{name:'Edit Tanaman Browser'})).toHaveCount(0);
  await page.getByRole('button',{name:'Keluar'}).click();
  await expect(page.getByRole('heading',{name:'Selamat datang kembali.'})).toBeVisible();
});
