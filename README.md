# LeoDisk

LeoDisk adalah toolkit pemeliharaan Windows berbasis Tauri 2 dan React. MVP ini
menyediakan:

- Dashboard live untuk CPU, GPU best-effort, memori, disk, jaringan, baterai,
  dan proses dengan pemakaian CPU tertinggi.
- Pemindaian cache aman pengguna dan browser dengan preview, label keamanan,
  serta opsi Recycle Bin atau penghapusan permanen yang selalu dikonfirmasi.
- Smart uninstaller untuk aplikasi Win32/MSI serta pencarian folder sisa
  user-level, dengan panel detail dan pengukuran ukuran folder instalasi
  hanya saat diminta.
- Inventaris startup read-only dengan shortcut menuju Startup Apps Windows.
- Analisis ruang folder/drive dari dashboard volume Windows, progres
  cancellable, peta folder drill-down, kategori penyebab penggunaan ruang,
  serta daftar file berukuran minimal 100 MB.
- Aksi membuka lokasi aplikasi, cache, folder hasil analisis, atau file besar
  langsung di File Explorer.
- Shortcut aman menuju Storage, Cleanup recommendations, dan Disks & volumes
  Windows Settings untuk area sistem yang tidak ditangani LeoDisk.

## Batas Keamanan

- LeoDisk tidak menghapus registry atau mengubah service Windows.
- LeoDisk tidak membersihkan cache sistem yang memerlukan Administrator.
- Penghapusan hanya dapat dilakukan terhadap hasil pemindaian backend.
- Recycle Bin direkomendasikan; penghapusan permanen tersedia hanya setelah
  dialog peringatan eksplisit dan tidak dapat dipulihkan melalui LeoDisk.
- File cache yang terkunci atau lokasi tanpa izin dilewati dan dilaporkan.
- Dukungan uninstall MVP terbatas pada program desktop Win32/MSI terdaftar.
- Cache sementara ditandai `Aman dihapus`; folder sisa aplikasi dan file besar
  ditandai `Periksa dahulu` karena dapat menyimpan data pengguna.
- Analisis disk melewati reparse point/junction/symlink dan melaporkan lokasi
  yang tidak dapat dibaca, bukan menebak ukurannya.
- LeoDisk tidak memakai mode Administrator, USN Journal, atau pemindaian MFT
  langsung pada MVP ini.

## Menjalankan

```powershell
bun install
bun run tauri dev
```

Untuk verifikasi:

```powershell
bun run test
bun run build
cd src-tauri
cargo test
```

Jika drive profil Cargo tidak memiliki ruang, arahkan cache Cargo ke drive
lain sebelum menjalankan command Rust:

```powershell
$env:CARGO_HOME = "E:\.cargo-leodisk"
cargo test
```
