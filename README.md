# LeoDisk

LeoDisk adalah aplikasi pemeliharaan Windows berbasis **Tauri 2**, **React 19**, **TypeScript**, dan **Rust**. Aplikasi ini dibuat untuk membantu pengguna melihat kondisi sistem, membersihkan cache user-level secara aman, menganalisis ruang disk, dan mengelola aplikasi desktop Win32/MSI tanpa memakai mode Administrator.

Fokus utama LeoDisk adalah transparansi dan keamanan: semua lokasi yang akan dibersihkan ditampilkan lebih dulu, item berisiko diberi label `Periksa dahulu`, dan penghapusan permanen selalu memerlukan konfirmasi eksplisit.

## Fitur Utama

### Status

Tab Status menampilkan ringkasan cepat kondisi perangkat:

- kesehatan penyimpanan berdasarkan hasil cleanup terakhir;
- CPU, memori, disk, jaringan, GPU best-effort, baterai, dan uptime;
- proses dengan pemakaian CPU/memori tertinggi;
- fallback yang jujur jika counter Windows tertentu tidak tersedia.

### Performa

Tab Performa memisahkan analisis sistem real-time dari analisis disk. Tab ini berguna sebelum menjalankan scan besar atau pembersihan.

- CPU, memori, disk I/O, jaringan, GPU, dan baterai.
- Grafik kecil untuk CPU dan jaringan.
- indikator masalah seperti CPU tinggi, memori hampir penuh, disk hampir penuh, atau counter disk tidak tersedia.
- proses teratas untuk membantu mencari aplikasi yang membebani sistem.

Formatter angka dibuat tahan terhadap data `null`, `undefined`, `NaN`, dan nilai tidak valid agar UI tidak crash ketika backend atau Windows API tidak memberikan metrik tertentu.

### Bersihkan

Tab Bersihkan melakukan scan cache aman pada area user-level. Contoh lokasi yang dicakup:

- `%TEMP%`, `%TMP%`, dan `%LOCALAPPDATA%\Temp`;
- cache browser Chromium: Edge, Chrome, Brave, Opera;
- cache Firefox;
- DirectX shader cache;
- Windows Error Reporting user-level;
- Windows INetCache;
- thumbnail cache Windows user-level;
- cache aplikasi seperti Discord, Slack, dan Microsoft Teams.

Item cache aman diberi label `Aman dihapus` dan dapat dipilih otomatis. Item yang mungkin berisi data pengguna harus tetap dicek manual. LeoDisk menghapus isi folder temp/cache, bukan folder root penting seperti folder Temp itu sendiri.

### Aplikasi

Tab Aplikasi membaca daftar aplikasi desktop Win32/MSI dari registry uninstall Windows.

- Menampilkan nama, publisher, versi, estimasi ukuran registry, dan lokasi instalasi jika tersedia.
- Mengukur ukuran folder instalasi hanya saat tombol diminta.
- Membuka lokasi aplikasi di File Explorer jika registry menyediakan path yang valid.
- Membuka uninstaller resmi aplikasi.
- Mencari folder sisa aplikasi di `APPDATA` dan `LOCALAPPDATA`.

Jika registry tidak mencantumkan `InstallLocation`, UI tetap menampilkan detail aplikasi dan memberi pesan jelas, bukan terlihat tidak merespons.

### Optimalkan

Tab Optimalkan membaca item startup secara read-only dan menyediakan shortcut ke Startup Apps Windows. LeoDisk tidak mengubah status startup langsung.

### Analisis

Tab Analisis melakukan pemindaian folder atau drive untuk mengetahui penggunaan ruang.

- Menampilkan volume Windows yang tersedia.
- Dapat memilih drive atau folder manual.
- Scan berjalan di background saat pengguna pindah tab.
- Status scan aktif muncul di topbar dan dapat dibatalkan.
- Hasil scan menampilkan folder terbesar, kategori file, peta folder, lokasi yang dilewati, dan file besar minimal 100 MB.
- File besar selalu diberi label `Periksa dahulu` dan tidak dipilih otomatis.

Backend melewati symlink, junction, dan reparse point untuk mencegah loop atau scan lokasi yang tidak aman.

## Batas Keamanan

LeoDisk sengaja tidak melakukan operasi berikut:

- tidak memakai mode Administrator;
- tidak menghapus registry;
- tidak mengubah service Windows;
- tidak membersihkan cache sistem yang memerlukan elevasi;
- tidak memakai USN Journal atau scan MFT langsung;
- tidak menghapus aplikasi Store/MSIX secara langsung;
- tidak menghapus file di luar hasil scan backend.

Penghapusan tersedia dalam dua mode:

- **Recycle Bin**: direkomendasikan karena masih dapat dipulihkan.
- **Hapus permanen**: hanya setelah dialog konfirmasi dan tidak dapat dipulihkan melalui LeoDisk.

File terkunci, lokasi tanpa izin, dan lokasi terlindungi akan dilewati dan dilaporkan.

## Struktur Proyek

```text
.
├─ src/                    # Frontend React + TypeScript
│  ├─ App.tsx              # Halaman utama, state UI, dan integrasi Tauri
│  ├─ components.tsx       # Komponen UI dan formatter
│  ├─ types.ts             # Kontrak data frontend
│  ├─ App.css              # Styling aplikasi
│  └─ test/setup.ts        # Setup Vitest + Testing Library
├─ src-tauri/              # Backend Rust + konfigurasi Tauri
│  ├─ src/
│  │  ├─ cleanup.rs        # Scan dan penghapusan cache
│  │  ├─ disk_scan.rs      # Analisis folder/drive
│  │  ├─ apps.rs           # Daftar aplikasi dan uninstaller
│  │  ├─ system.rs         # Snapshot performa sistem
│  │  ├─ storage.rs        # Volume dan shortcut storage settings
│  │  ├─ startup.rs        # Startup item read-only
│  │  └─ state.rs          # State bersama backend
│  ├─ capabilities/        # Permission Tauri
│  └─ tauri.conf.json      # Konfigurasi app dan bundle
├─ public/                 # Asset frontend statis
├─ dist/                   # Output build Vite
└─ package.json            # Script Bun/Vite/Vitest/Tauri
```

Folder `node_modules/`, `dist/`, dan `src-tauri/target/` adalah output dependency/build dan tidak perlu diedit manual.

## Prasyarat

Pastikan tersedia:

- Windows 10/11;
- Bun;
- Rust stable dan Cargo;
- toolchain Tauri 2 untuk Windows;
- WebView2 Runtime;
- WiX/NSIS jika ingin menghasilkan installer MSI/NSIS melalui Tauri bundler.

## Menjalankan Aplikasi

Install dependency JavaScript:

```powershell
bun install
```

Jalankan frontend Vite saja:

```powershell
bun run dev
```

Jalankan aplikasi desktop Tauri:

```powershell
bun run tauri dev
```

Vite dikonfigurasi pada port `1420` untuk kebutuhan Tauri.

## Test dan Verifikasi

Frontend:

```powershell
bun run test
```

Build frontend:

```powershell
bun run build
```

Test backend Rust:

```powershell
cd src-tauri
cargo test
```

Jika drive profil Cargo penuh, arahkan cache Cargo ke drive lain:

```powershell
$env:CARGO_HOME = "E:\.cargo-leodisk"
cargo test
```

## Build EXE dan Installer

Build release lengkap:

```powershell
bun run tauri build
```

Output utama:

```text
src-tauri/target/release/leodisk.exe
src-tauri/target/release/bundle/msi/LeoDisk_0.1.0_x64_en-US.msi
src-tauri/target/release/bundle/nsis/LeoDisk_0.1.0_x64-setup.exe
```

`leodisk.exe` adalah executable release. File MSI dan NSIS setup adalah installer Windows yang dibuat oleh Tauri bundler.

## Troubleshooting

### Error `Cannot read properties of null (reading 'toFixed')`

Formatter LeoDisk sudah dibuat tahan `null`. Jika error ini muncul lagi, kemungkinan ada formatter baru yang langsung memanggil `.toFixed()` tanpa validasi. Gunakan `formatBytes`, `formatPercent`, atau `percentOf` dari `src/components.tsx`.

### Error `SCAN_ALREADY_RUNNING`

Scan disk hanya boleh satu proses pada satu waktu. UI sekarang menjaga scan tetap berjalan walau pindah tab dan menampilkan status di topbar. Jika error tetap muncul, batalkan scan aktif dari topbar atau tunggu sampai selesai.

### Aplikasi tidak punya lokasi instalasi

Beberapa entri registry Windows tidak menyediakan `InstallLocation`. LeoDisk tetap dapat menampilkan detail dan mencoba membuka uninstaller jika `UninstallString` tersedia, tetapi tombol buka lokasi akan menampilkan pesan bahwa lokasi tidak tercantum.

### Scan lambat pada drive besar

Analisis drive penuh memang dapat memakan waktu. LeoDisk memakai enumeration native Windows, membatasi hasil yang dikirim ke UI, dan melewati reparse point. Untuk hasil lebih cepat, scan folder target yang lebih kecil daripada seluruh drive.

## Catatan Pengembangan

- Pertahankan nama command Tauri karena frontend memanggilnya dengan string.
- Jangan menambahkan cleanup admin-level tanpa desain keamanan baru.
- Item berisiko harus tetap tidak dipilih otomatis.
- Tambahkan test frontend untuk perubahan alur UI dan test Rust untuk perubahan backend yang menyentuh path, deletion, atau scan.
