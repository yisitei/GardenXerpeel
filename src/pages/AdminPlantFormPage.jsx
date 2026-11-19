import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, CheckCircle, Image, Leaf, UploadSimple, WarningCircle,
} from '@phosphor-icons/react';
import { api, slugify } from '../lib/api.js';
import { prepareImage, validateImage } from '../lib/image-upload.js';
import LoadingState from '../components/LoadingState.jsx';

const emptyForm = {
  name: '',
  slug: '',
  scientific_name: '',
  short_description: '',
  description: '',
  characteristics: '',
  benefits: '',
  care_guide: '',
  habitat: '',
  location_label: '',
  image_path: '',
};

export default function AdminPlantFormPage() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const [form, setForm] = useState(emptyForm);
  const [verified, setVerified] = useState(false);
  const [slugTouched, setSlugTouched] = useState(isEdit);
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [file, setFile] = useState(null);
  const [localPreview, setLocalPreview] = useState('');

  useEffect(() => {
    if (!isEdit) return undefined;
    let active = true;
    api(`/api/admin-plant?id=${id}`)
      .then((payload) => {
        if (!active) return;
        const plant = payload.data;
        setForm({
          name: plant.name,
          slug: plant.slug,
          scientific_name: plant.scientific_name || '',
          short_description: plant.short_description || '',
          description: plant.description || '',
          characteristics: plant.characteristics || '',
          benefits: plant.benefits || '',
          care_guide: plant.care_guide || '',
          habitat: plant.habitat || '',
          location_label: plant.location_label || '',
          image_path: plant.image_path || '',
        });
        setVerified(Boolean(plant.verified));
      })
      .catch((err) => {
        if (active) setError(err.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id, isEdit]);

  useEffect(() => () => {
    if (localPreview) URL.revokeObjectURL(localPreview);
  }, [localPreview]);

  function update(field, value) {
    setForm((current) => {
      const next = { ...current, [field]: value };
      if (field === 'name' && !slugTouched) {
        next.slug = slugify(value);
      }
      return next;
    });
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
  }

  function handleFile(event) {
    const selected = event.target.files?.[0] || null;
    try {
      if (selected) validateImage(selected);
    } catch (err) {
      event.target.value = '';
      setFile(null);
      setLocalPreview('');
      setError(err.message);
      setFieldErrors(current => ({ ...current, image: err.message }));
      return;
    }
    setError('');
    setFieldErrors(current => ({ ...current, image: undefined }));
    setFile(selected);
    if (selected) {
      const url = URL.createObjectURL(selected);
      setLocalPreview(url);
    } else {
      setLocalPreview('');
    }
  }

  async function submit(status) {
    setError('');
    setFieldErrors({});

    if (!form.name.trim()) {
      setError('Nama tanaman wajib diisi.');
      setFieldErrors({ name: 'Nama tanaman wajib diisi.' });
      return;
    }
    if (status === 'published' && !verified) {
      setError('Centang pernyataan verifikasi sebelum menerbitkan tanaman.');
      setFieldErrors({ verified: 'Konfirmasi verifikasi diperlukan untuk publikasi.' });
      return;
    }

    const payload = {
      ...form,
      slug: form.slug || slugify(form.name),
      status,
      verified,
    };

    setSaving(status);
    try {
      let body = payload;
      if (file) {
        const prepared = await prepareImage(file);
        body = new FormData();
        body.append('data', JSON.stringify(payload));
        body.append('image', prepared);
      }
      await api(isEdit ? `/api/admin-plant?id=${id}` : '/api/admin-plants', {
        method: isEdit ? 'PUT' : 'POST', body,
      });

      navigate('/admin/plants');
    } catch (err) {
      setError(err.message);
      const mapped = {};
      for (const item of err.errors || []) {
        if (item?.field) mapped[item.field] = item.message;
      }
      setFieldErrors(mapped);
    } finally {
      setSaving('');
    }
  }

  if (loading) {
    return <LoadingState label="Memuat data tanaman…" />;
  }

  const preview = localPreview || form.image_path;

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <Link className="back-link inline" to="/admin/plants">
            <ArrowLeft size={16} aria-hidden="true" />
            Kembali ke data tanaman
          </Link>
          <span className="eyebrow">{isEdit ? 'Edit tanaman' : 'Tanaman baru'}</span>
          <h1>{isEdit ? 'Edit tanaman' : 'Tambah tanaman'}</h1>
          <p>
            Lengkapi informasi, unggah foto, lalu simpan sebagai draft atau terbitkan
            setelah konten diverifikasi.
          </p>
        </div>
      </header>

      {error && (
        <div className="notice error" role="alert">
          <WarningCircle size={19} aria-hidden="true" />
          <div>
            <strong>{error}</strong>
            {Object.keys(fieldErrors).length > 0 && (
              <ul>
                {Object.entries(fieldErrors).filter(([, value]) => value).map(([field, value]) => (
                  <li key={field}>{value}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <form className="plant-form" onSubmit={(event) => {
        event.preventDefault();
        submit('published');
      }} noValidate>
        <div className="form-main">
          <section className="panel form-section">
            <div className="form-section-heading">
              <span className="panel-icon" aria-hidden="true"><Leaf size={20} /></span>
              <div>
                <h2>Identitas tanaman</h2>
                <p>Nama yang akan tampil pada halaman publik dan QR.</p>
              </div>
            </div>

            <div className="field-grid">
              <div className="field full">
                <label htmlFor="name">Nama tanaman</label>
                <input
                  id="name"
                  name="name"
                  type="text"
                  value={form.name}
                  onChange={(event) => update('name', event.target.value)}
                  placeholder="Contoh: Lili Paris"
                  maxLength={120}
                  required
                />
                {fieldErrors.name && <p className="field-error">{fieldErrors.name}</p>}
              </div>

              <div className="field">
                <label htmlFor="slug">Slug URL</label>
                <input
                  id="slug"
                  name="slug"
                  type="text"
                  value={form.slug}
                  onChange={(event) => {
                    setSlugTouched(true);
                    update('slug', slugify(event.target.value));
                  }}
                  placeholder="lili-paris"
                  readOnly={isEdit}
                  aria-describedby="slug-help"
                />
                <p className="field-hint" id="slug-help">
                  {isEdit
                    ? 'Slug tidak dapat diubah agar QR yang sudah dicetak tetap berfungsi.'
                    : 'Dibuat otomatis dari nama. Gunakan huruf kecil dan tanda hubung.'}
                </p>
                {fieldErrors.slug && <p className="field-error">{fieldErrors.slug}</p>}
              </div>

              <div className="field">
                <label htmlFor="scientific_name">Nama ilmiah (opsional)</label>
                <input
                  id="scientific_name"
                  name="scientific_name"
                  type="text"
                  value={form.scientific_name}
                  onChange={(event) => update('scientific_name', event.target.value)}
                  placeholder="Contoh: Chlorophytum comosum"
                  maxLength={160}
                />
                {fieldErrors.scientific_name && <p className="field-error">{fieldErrors.scientific_name}</p>}
              </div>

              <div className="field">
                <label htmlFor="location_label">Lokasi di taman (opsional)</label>
                <input
                  id="location_label"
                  name="location_label"
                  type="text"
                  value={form.location_label}
                  onChange={(event) => update('location_label', event.target.value)}
                  placeholder="Contoh: Bedeng timur, dekat gazebo"
                  maxLength={200}
                />
                {fieldErrors.location_label && <p className="field-error">{fieldErrors.location_label}</p>}
              </div>

              <div className="field full">
                <label htmlFor="habitat">Habitat (opsional)</label>
                <input
                  id="habitat"
                  name="habitat"
                  type="text"
                  value={form.habitat}
                  onChange={(event) => update('habitat', event.target.value)}
                  placeholder="Contoh: Area teduh dengan kelembapan sedang"
                  maxLength={600}
                />
                {fieldErrors.habitat && <p className="field-error">{fieldErrors.habitat}</p>}
              </div>
            </div>
          </section>

          <section className="panel form-section">
            <div className="form-section-heading">
              <span className="panel-icon" aria-hidden="true"><Leaf size={20} /></span>
              <div>
                <h2>Konten tanaman</h2>
                <p>Ringkasan dan penjelasan yang akan dibaca pengunjung.</p>
              </div>
            </div>

            <div className="field-grid single">
              <div className="field">
                <label htmlFor="short_description">Ringkasan singkat</label>
                <textarea
                  id="short_description"
                  name="short_description"
                  rows={3}
                  value={form.short_description}
                  onChange={(event) => update('short_description', event.target.value)}
                  placeholder="Satu atau dua kalimat yang menggambarkan tanaman ini."
                  maxLength={600}
                />
                {fieldErrors.short_description && <p className="field-error">{fieldErrors.short_description}</p>}
              </div>

              <div className="field">
                <label htmlFor="description">Deskripsi lengkap</label>
                <textarea
                  id="description"
                  name="description"
                  rows={6}
                  value={form.description}
                  onChange={(event) => update('description', event.target.value)}
                  placeholder="Jelaskan tanaman secara utuh: asal, bentuk, dan kebiasaan tumbuhnya."
                  maxLength={20000}
                />
                {fieldErrors.description && <p className="field-error">{fieldErrors.description}</p>}
              </div>

              <div className="field">
                <label htmlFor="characteristics">Karakteristik</label>
                <textarea
                  id="characteristics"
                  name="characteristics"
                  rows={4}
                  value={form.characteristics}
                  onChange={(event) => update('characteristics', event.target.value)}
                  placeholder="Ciri daun, batang, bunga, atau pertumbuhan."
                  maxLength={10000}
                />
                {fieldErrors.characteristics && <p className="field-error">{fieldErrors.characteristics}</p>}
              </div>

              <div className="field">
                <label htmlFor="benefits">Manfaat & kegunaan</label>
                <textarea
                  id="benefits"
                  name="benefits"
                  rows={4}
                  value={form.benefits}
                  onChange={(event) => update('benefits', event.target.value)}
                  placeholder="Manfaat yang sudah terverifikasi. Hindari klaim kesehatan tanpa sumber."
                  maxLength={10000}
                />
                {fieldErrors.benefits && <p className="field-error">{fieldErrors.benefits}</p>}
              </div>

              <div className="field">
                <label htmlFor="care_guide">Panduan perawatan</label>
                <textarea
                  id="care_guide"
                  name="care_guide"
                  rows={5}
                  value={form.care_guide}
                  onChange={(event) => update('care_guide', event.target.value)}
                  placeholder="Kebutuhan cahaya, air, media tanam, dan perawatan rutin."
                  maxLength={10000}
                />
                {fieldErrors.care_guide && <p className="field-error">{fieldErrors.care_guide}</p>}
              </div>
            </div>
          </section>
        </div>

        <aside className="form-side">
          <section className="panel form-section">
            <div className="form-section-heading compact">
              <span className="panel-icon" aria-hidden="true"><Image size={20} /></span>
              <div>
                <h2>Foto utama</h2>
                <p>JPG, PNG, atau WebP. Maksimal 5 MB. Foto diperkecil otomatis sebelum diunggah.</p>
              </div>
            </div>

            <div className="image-preview">
              {preview ? (
                <img src={preview} alt="Pratinjau foto tanaman" />
              ) : (
                <span className="image-placeholder" aria-hidden="true">
                  <Leaf size={34} />
                </span>
              )}
            </div>

            <label className="file-input" htmlFor="image">
              <UploadSimple size={18} aria-hidden="true" />
              <span>{preview ? 'Ganti foto tanaman' : 'Pilih foto tanaman'}</span>
              <input
                id="image"
                name="image"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={handleFile}
              />
            </label>
            {fieldErrors.image && <p className="field-error">{fieldErrors.image}</p>}
          </section>

          <section className="panel form-section publish-panel">
            <div className="form-section-heading compact">
              <span className="panel-icon" aria-hidden="true"><CheckCircle size={20} /></span>
              <div>
                <h2>Publikasi</h2>
                <p>Draft dapat disimpan kapan saja. Publikasi memerlukan verifikasi.</p>
              </div>
            </div>

            <label className="check-field" htmlFor="verified">
              <input
                id="verified"
                name="verified"
                type="checkbox"
                checked={verified}
                onChange={(event) => {
                  setVerified(event.target.checked);
                  setFieldErrors((current) => ({ ...current, verified: undefined }));
                }}
              />
              <span>
                Saya sudah memverifikasi bahwa informasi tanaman ini akurat dan
                siap dipublikasikan.
              </span>
            </label>
            {fieldErrors.verified && <p className="field-error">{fieldErrors.verified}</p>}

            <div className="form-actions">
              <button
                type="button"
                className="button ghost wide"
                onClick={() => submit('draft')}
                disabled={Boolean(saving)}
              >
                {saving === 'draft' ? 'Menyimpan…' : 'Simpan draft'}
              </button>
              <button
                type="button"
                className="button primary wide"
                onClick={() => submit('published')}
                disabled={Boolean(saving)}
              >
                {saving === 'published' ? 'Menerbitkan…' : 'Terbitkan tanaman'}
              </button>
            </div>
            <p className="publish-note">
              Tanaman yang diterbitkan langsung tampil di halaman publik dan dapat
              dibuka melalui QR Code.
            </p>
          </section>
        </aside>
      </form>
    </div>
  );
}
