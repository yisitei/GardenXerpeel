export const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
// Leave ample room below Vercel's 4.5 MB request limit for form fields/headers.
const MAX_UPLOAD_BYTES = 1500 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function validateImage(file) {
  if (!ALLOWED_TYPES.has(file.type)) throw new Error('Format foto harus JPG, PNG, atau WebP.');
  if (file.size > MAX_SOURCE_BYTES) throw new Error('Ukuran foto maksimal 5 MB.');
  if (!file.size) throw new Error('File foto kosong. Pilih foto lain.');
}

export async function prepareImage(file) {
  validateImage(file);
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Browser tidak dapat memproses foto. Coba browser lain.');
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.85, 0.7, 0.5]) {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
      if (blob && blob.size <= MAX_UPLOAD_BYTES) {
        const extension = blob.type === 'image/webp' ? 'webp' : 'png';
        return new File([blob], `tanaman.${extension}`, {type: blob.type});
      }
    }
    throw new Error('Foto masih terlalu besar setelah diperkecil. Pilih foto berukuran lebih kecil.');
  } catch (error) {
    if (error.name === 'EncodingError') throw new Error('Foto tidak dapat dibaca. Pilih file JPG, PNG, atau WebP yang valid.');
    throw error;
  } finally {
    URL.revokeObjectURL(url);
  }
}
