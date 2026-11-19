# Perbaikan unggahan foto di Vercel

## Penyebab yang direproduksi di production
- POST foto 5.24 MB ditolak sebelum mencapai Express: HTTP 413 `FUNCTION_PAYLOAD_TOO_LARGE`.
- POST foto kecil berhasil, tetapi GET `/uploads/<filename>` mengembalikan HTTP 404 dari Vercel, bukan gambar.
- Form lama menyimpan/publish konten sebelum mengunggah foto; kegagalan langkah kedua meninggalkan perubahan parsial.

## Perubahan
- Browser memvalidasi JPG/PNG/WebP sampai 5 MiB, memperkecil sisi terpanjang menjadi maksimum 1600 px, dan mengirim hasil maksimum 1.5 MiB.
- Konten dan foto dikirim sebagai satu multipart request. Server memvalidasi/mengonversi gambar sebelum menyimpan perubahan; gagal unggah tidak menerbitkan atau membuat record baru.
- Foto baru dibaca melalui `/api/image?filename=...`, termasuk pemeriksaan status publikasi. Rewrite mempertahankan URL `/uploads/` lama.
- Seluruh alias API datar ditangani oleh satu Vercel Function. Sebelumnya route simpan dan route gambar menjadi Function terpisah sehingga `/tmp` keduanya tidak sama.
- CSP mengizinkan `blob:` untuk pratinjau lokal. Respons gambar tidak di-cache agar foto draft tidak tetap terbuka setelah pembatalan publikasi.
- Pesan HTTP 413 sekarang menjelaskan batas unggahan.

## Penyimpanan production
- Database SQLite dan foto tidak lagi disimpan hanya di `/tmp/data`.
- Setiap request API memuat snapshot `garden.db` dari repository privat `yisitei/GardenXerpeel-data`, lalu menyimpan kembali setelah operasi tulis selesai.
- Foto disimpan di folder `uploads/` repository privat yang sama dan dibaca kembali oleh route `/api/image` saat file tidak ada di instance function.
- Repository privat dan token akses diatur lewat environment Vercel: `GITHUB_DATA_REPO`, `GITHUB_DATA_BRANCH`, dan `GITHUB_DATA_TOKEN`.
- Dengan begitu data tanaman, status publikasi, dan foto tetap ada meskipun function Vercel cold start, redeploy, atau berpindah instance.

## Pengujian
`npm test` dan `npm run test:e2e`. Tes browser memakai foto sumber tepat 5 MiB, memeriksa ukuran request hasil kompresi, publikasi dan gambar yang benar-benar terdekode.

## Batasan yang tersisa
- Setiap request API melakukan baca/tulis ke GitHub API, jadi ada batas laju dan latensi tambahan. Untuk trafik besar, pindahkan data ke database terkelola.
- Repository data harus tetap privat karena berisi hash password admin dan konten draft.

Referensi batas platform: https://vercel.com/docs/functions/limitations
