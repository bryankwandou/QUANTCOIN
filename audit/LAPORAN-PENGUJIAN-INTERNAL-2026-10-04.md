# QuantCoin: Bukti Pengujian Internal, 4 Oktober 2026

Disusun untuk pemeriksaan hukum. Log mentah untuk setiap baris di bawah ada di folder `audit/evidence-2026-10-04/` pada repositori publik github.com/bryankwandou/QUANTCOIN.

**Apa dokumen ini.** Pengujian otomatis QuantCoin yang dijalankan ulang secara lengkap oleh tim proyek sendiri (dibantu AI) pada 4 Oktober 2026 (WITA), terhadap kode yang dipublikasikan di GitHub, ditambah pemeriksaan kondisi mainnet, situs web yang sedang online, dan setiap aplikasi yang dirilis.

**Apa yang bukan.** Dokumen ini **bukan audit eksternal**. Belum ada pihak independen yang memeriksa kode. Pengujian membuktikan bahwa kasus yang diuji berjalan sesuai harapan; pengujian tidak bisa membuktikan bahwa tidak ada bug sama sekali. Hal yang masih terbuka dicantumkan di bagian akhir dan tidak disembunyikan.

## 1. Ringkasan

| No | Komponen | Sudah dibangun | Cara diuji | Hasil | Bukti |
|---|---|---|---|---|---|
| 1 | Smart contract (program vault `CiupyGrA…`) | Ya, aktif di mainnet | 27 uji unit, integrasi, dan fuzz pada biner yang di-deploy | **27 lulus, 0 gagal** | `01-cargo-test.log` |
| 2 | Kode sumber = kode yang di-deploy | Ya | Build dari GitHub, dibandingkan dengan byte di mainnet | **Identik** (sha256 `07e6b6dd…94be`) | `05-sha-compare.log`, `10-mainnet-state.log` |
| 3 | Contract pada salinan mainnet (fork) | Ya | Rangkaian uji skala penuh (SCALE=1): transfer, serangan, fuzzing, replay, konkurensi | **1.642 lulus, 0 gagal** (191 transfer nyata; komputasi maks 867.381 dari 1.400.000) | `41-surfpool-suite.log` |
| 4 | Token, multisig, time lock, vault, pool di mainnet | Ya | 30 pemeriksaan baca-saja ke mainnet | **30 lulus, 0 gagal** | `10-mainnet-state.log` |
| 5 | Situs quantcoin-pi.vercel.app | Ya, online | 37 pemeriksaan langsung: halaman, unduhan, saldo live, keamanan proxy RPC | **37 lulus, 0 gagal** | `30-live-smoke.log` |
| 6 | Aplikasi web (`/app/`) | Ya, online | Uji unit, pemeriksaan tipe, build | **10 lulus**, tipe dan build OK | `20-…`, `21-…`, `22-…` |
| 7 | Ekstensi browser | Ya, dirilis | 14 uji unit; 14 uji end-to-end di browser sungguhan termasuk penarikan di fork mainnet; build dapat direproduksi | **14 + 14 lulus**; build identik byte per byte | `90-…`, `91-…`, `93-…` |
| 8 | Aplikasi Android | Ya, dirilis | 27 uji aplikasi + 2 transaksi nyata di devnet + APK rilis dijalankan di emulator Android 14 + uji penyimpanan kunci di dalam aplikasi | **27 lulus**, **2 transaksi nyata lulus**, **berjalan**, **penyimpanan kunci lulus** | `51-…`, `52-…`, `53-…`, `55-…`, CI |
| 9 | Aplikasi Windows (.exe) | Ya, dirilis | .exe rilis dijalankan di laptop ini dan di mesin Windows CI yang bersih + uji penyimpanan kunci | **Berjalan**, **penyimpanan kunci lulus** | CI |
| 10 | Aplikasi macOS | Ya, dirilis | .app rilis dijalankan di Mac (Apple Silicon) + uji keychain di dalam aplikasi | **Berjalan**, **keychain lulus**. Bug yang membuat aplikasi tidak bisa dibuka ditemukan dan diperbaiki hari ini (F-10) | CI |
| 11 | Aplikasi iOS | Dibangun (.ipa tanpa tanda tangan) | Commit yang sama dijalankan di simulator iPhone + uji keychain | **Berjalan**, **keychain lulus**. Belum diuji di iPhone fisik | CI |
| 12 | Konektivitas antarkomponen | Ya | Aplikasi ↔ proxy ↔ mainnet; ekstensi ↔ proxy ↔ mainnet; aplikasi Flutter ↔ devnet; ekstensi ↔ program di fork | **Semua lulus** | `30-…`, `91-…`, `52-…`, `53-…` |
| 13 | Dependensi Rust | — | `cargo audit` (338 paket) | **0 kerentanan**, 5 catatan "tidak dipelihara" | `61-cargo-audit.log` |
| 14 | Dependensi JavaScript | — | `npm audit` di setiap paket | Peringatan yang tersisa **belum ada versi perbaikannya**; lihat bagian 6 | `60-…` |
| 15 | Rahasia di repositori publik | — | Pemindaian semua file dan 39 commit | **0 rahasia ditemukan** | `80-secrets-scan.log` |

## 2. Smart contract

Semua perintah dijalankan pada checkout bersih dari commit yang dipublikasikan, bukan dari folder kerja developer.

| Apa | Hasil |
|---|---|
| `cargo build-sbf` | exit 0; `qc_vault.so`, 7.456 byte |
| `cargo test -p qc-vault --release --no-fail-fast` | `fuzz.rs` **14 lulus**, `vault.rs` **13 lulus**, 0 gagal |
| Byte di mainnet dibanding build ini | 7.456 byte pertama identik (sha256 `07e6b6dd45e6bb7f26ef4ce85f1e6168f8dd1b4bde2b0f4979a5fad6769194be`); 8 byte sisa akun bernilai nol |
| `cargo clippy` | exit 0; 10 peringatan gaya penulisan, tidak ada yang soal kebenaran logika. Tidak diubah, karena mengubah kode contract membuatnya berbeda dari yang di-deploy |
| `cargo audit` | 0 kerentanan di 338 paket; 5 paket ditandai tidak dipelihara (`ansi_term`, `bincode`, `derivative`, `libsecp256k1`, `paste`), semuanya dari perangkat uji atau SDK |

Ke-27 uji mencakup antara lain: transfer butuh tanda tangan Ed25519 dan tanda tangan sekali-pakai Winternitz sekaligus; jumlah, tujuan, pemilik, program token, atau tanda tangan yang diubah ditolak; pengulangan (replay) setelah transfer ditolak; data acak dan tanda tangan yang dimutasi (fuzzing) ditolak; biaya komputasi terburuk masih muat dalam satu transaksi Solana.

## 3. Kondisi mainnet (baca-saja, 30 pemeriksaan)

`client/verify-mainnet.ts` membaca mainnet tanpa menandatangani apa pun. 30 dari 30 lulus, antara lain: program dimiliki oleh upgradeable loader; otoritas upgrade adalah vault Squads `45nAvRrg…`; multisig `A9tdTp68…` adalah 2-dari-3 dengan time lock 24 jam dan tanpa config authority; suplai 22.000.000.000.000 QC, 5 desimal; tidak ada otoritas mint, freeze, atau metadata; setiap vault di halaman transparansi adalah akun QC tanpa delegate dan tanpa close authority; seluruh akun QC dijumlahkan sama dengan suplai; posisi likuiditas proyek di pool 100% terkunci permanen; bytecode di mainnet sama dengan build lokal; halaman transparansi mencantumkan multisig, vault Squads, pool, dan posisi yang diperiksa.

## 4. Aplikasi dan konektivitas

**Situs (37/37).** Ketujuh halaman mengembalikan status 200 tanpa error di konsol browser (bahasa Inggris dan Indonesia). Label menyebut Mainnet. Bagian instal menautkan 6 file rilis dan setiap unduhan mengembalikan 200. Halaman transparansi menampilkan saldo live dan bagian tata kelola yang baru. Proxy RPC menerima situs dan ekstensi, dan menolak situs lain, ekstensi lain, metode yang tidak dikenal, isi permintaan yang terlalu besar, batch lebih dari 20, dan GET.

**Aplikasi web.** 10 uji unit, pemeriksaan tipe, build produksi: semua lulus setelah pembaruan dependensi hari ini.

**Ekstensi browser.** 14 uji unit lulus. 14 uji end-to-end lulus di Microsoft Edge dengan ekstensi hasil build: ekstensi membaca mainnet lewat proxy, membuat kunci pemilik dan vault, menyimpan keduanya terenkripsi (PBKDF2 600.000 putaran + AES-GCM), menolak kata sandi yang salah, mengekspor dan mengimpor ulang cadangan, dan menyelesaikan penarikan sungguhan di fork mainnet terhadap program yang di-deploy (1.234,5 QC diterima, 8.765,5 QC dipindah ke vault berikutnya). Dua build bersih menghasilkan file yang identik, dan zip yang dirilis adalah build tersebut.

**Aplikasi Flutter (Android, Windows, macOS, iOS memakai kode ini).** `flutter analyze`: tidak ada masalah. `flutter test`: 27 lulus, 2 sengaja dilewati karena memakai dana devnet. Kedua uji itu lalu dijalankan sungguhan di devnet:
- `devnet_send_test.dart`: dua transfer yang ditandatangani oleh kode aplikasi sendiri masuk ke devnet (`31dfLLL9…`, `3M2Dgfd5…`).
- `ui_send_e2e_test.dart`: layar aplikasi dioperasikan dengan ketukan simulasi (passcode, impor vault, penerima, jumlah, konfirmasi) dan transfernya diverifikasi di chain (`ZnH5YhXR…`).

**Biner rilis dijalankan di sistem operasi sungguhan** (GitHub Actions; file dicek terhadap `SHA256SUMS.txt` sebelum dijalankan):

| Build | Dijalankan di | Hasil |
|---|---|---|
| APK Android | Emulator Android 14 | Berjalan, layar passcode, proses masih hidup setelah 25 detik, tidak ada error di logcat |
| .exe Windows | Laptop ini (Windows 11) dan mesin Windows Server CI yang bersih | Berjalan, layar passcode |
| .app macOS | Mesin macOS 26 CI (Apple Silicon) | Berjalan (proses hidup setelah 25 detik), layar passcode. Tanda tangan ad-hoc valid |
| iOS | Simulator iPhone (build simulator dari commit yang sama; .ipa tanpa tanda tangan adalah build perangkat fisik dan tidak bisa jalan di simulator) | Berjalan (proses hidup setelah 25 detik), layar passcode |

Run uji pada rilis final: GitHub Actions 37177474011 (setelah APK ditandatangani ulang; keempatnya lulus) dan 37164277322 (keempat job lulus; screenshot dan cek checksum di `ci-smoke-37164277322/`). Run sebelumnya, 37163022346 dan 37163296309, gagal hanya di macOS; kegagalan itu adalah F-10.

**Uji penyimpanan kunci di dalam aplikasi sungguhan** (`integration_test/keystore_device_test.dart`: tulis kunci vault ke keychain/keystore sistem, baca lagi, bandingkan, hapus): **lulus di emulator Android, simulator iPhone, macOS, dan Windows** (GitHub Actions 37163435149).

## 5. Masalah yang ditemukan hari ini dan tindakannya

Pengujian menemukan masalah nyata. Masing-masing dicantumkan dengan perbaikan dan buktinya.

| ID | Masalah | Perbaikan | Bukti |
|---|---|---|---|
| F-8 | Repositori publik lama (`VincentiusBryanKwandou/QUANTCOIN`) masih memuat klaim lama yang tidak benar (1 triliun TPS, kutipan yang diatribusikan ke Elon Musk dan Sam Altman) | Dijadikan privat pada 4 Oktober 2026; URL publiknya kini 404. Akun lama `nayrbryanGaming` sudah tidak ada (berganti nama menjadi `bryankwandou` pada 17 September 2026), sehingga URL lamanya juga 404 | `curl` 404; pemindaian semua repositori publik kedua akun tidak menemukan salinan QuantCoin lain yang memuat klaim tersebut |
| F-9 | Kode sumber ekstensi browser belum ada di repositori publik, padahal zip-nya sudah dirilis | Di-commit (commit `63465ed`); kunci tanda tangan privatnya tetap di luar git | repositori |
| F-10 | **Aplikasi macOS yang dirilis tidak bisa dibuka.** Aplikasi meminta entitlement keychain terbatas yang tidak boleh dimiliki aplikasi bertanda tangan ad-hoc, sehingga macOS menolak menjalankannya | Entitlement dihapus; aplikasi memakai keychain macOS standar (commit `5a0dd58`); dibangun ulang dan dirilis ulang | Sebelum: run 37163296309, error launchd 162. Sesudah: run 37164277322 berjalan; uji keychain lulus di macOS (run 37163435149) |
| F-11 | Ekstensi hanya bisa di-build karena ada sisa file di komputer developer; instalasi baru gagal | Perangkat build dikunci versinya di `apps/package.json`; akhir baris diseragamkan agar build identik di semua OS (commit `a588658`) | `93-extension-reproducible-build.log` |
| F-12 | Zip ekstensi yang dirilis tidak bisa direproduksi dari kode sumber | Diganti dengan build yang dapat direproduksi; checksum lama dan baru dicatat | catatan rilis, `93-…` |
| F-13 | Windows, macOS, dan iOS dilaporkan "belum dibangun" pada 3 Oktober 2026 | Dibangun oleh GitHub Actions dan ditambahkan ke rilis; semua biner aplikasi kini dari satu commit (`5a0dd58`) | rilis `app-v0.1.0` |
| F-14 | Dua uji Flutter gagal pada 3 Oktober 2026 (pengaturan belum diisi) | Ditandai opsional dengan alasan tertulis; dijalankan sungguhan hari ini dan lulus | `52-…`, `53-…` |
| F-15 | Skrip pemeriksaan mainnet sudah usang dan akan melaporkan kegagalan palsu | Diganti dengan skrip 30 pemeriksaan yang dipelihara | `10-mainnet-state.log` |
| F-16 | Halaman transparansi belum menampilkan multisig, time lock, pool, atau posisi yang terkunci | Ditambahkan, dan skrip pemeriksaan kini juga memverifikasi halaman itu | situs live, `30-…` |
| F-17 | Peringatan kritis di framework situs (Astro) | Astro diperbarui dari versi 5 ke 7 | `60-npm-audit-web.log` |

Kesalahan dalam penyiapan uji juga disimpan beserta lognya agar pembaca bisa melihatnya: uji contract pertama dijalankan sebelum build (`01a-…`), rangkaian uji fork pertama memakai pembayar biaya tanpa saldo (`41a-…`), rangkaian uji fork kedua macet di 1.500 uji dengan 0 gagal karena menunggu konfirmasi tanpa batas waktu (`41b-…`; kini dibatasi 60 detik), dan satu uji Flutter memakai kunci yang sudah terpakai (`53a-…`, aplikasi menolaknya dengan benar). Tidak ada yang merupakan cacat produk; semuanya dijalankan ulang dengan benar.

## 6. Peringatan dependensi yang tersisa

Setelah pembaruan, peringatan JavaScript yang tersisa ada di paket yang **belum punya versi perbaikan** saat ini:

| Paket | Lokasi | Kenapa masih ada | Paparan |
|---|---|---|---|
| `bigint-buffer` ≤ 1.1.5 (tinggi) | SDK Solana (`@solana/spl-token`), di `app/` dan `client/` | 1.1.5 adalah rilis terbaru; belum ada perbaikan | Di browser paket ini memakai kode JavaScript murni, bukan kode native yang dimaksud peringatan. `client/` adalah alat baris perintah milik operator sendiri |
| `braces` ≤ 3.0.3 (tinggi) | alat build di `app/` | 3.0.3 adalah rilis terbaru | Hanya saat build; tidak dikirim ke pengguna |
| `http-cache-semantics` ≤ 4.2.0 (tinggi) | Astro, di `web/` | 4.2.0 adalah rilis terbaru | Hanya saat build; situs hasil build tidak memuatnya (sudah dicek) |

## 7. Yang tidak bisa dibuktikan pengujian, dan yang masih terbuka

1. **Belum ada audit eksternal.** Ini pengujian proyek sendiri.
2. **Tidak ada bukti "nol bug".** Pengujian menunjukkan kasus yang diuji berjalan. Situasi yang tidak diuji tetap bisa gagal.
3. **Q-1 Penyimpanan kunci (kritis, terbuka).** Dua dari tiga kunci multisig beserta seed phrase-nya masih tersimpan sebagai file biasa di laptop developer. Siapa pun yang menguasai laptop itu menguasai 2 dari 3 kunci dan bisa meng-upgrade contract, setelah time lock 24 jam. Perbaikannya: pindahkan kedua kunci ke dua tempat offline yang terpisah, lalu hapus file-nya. Hanya pemilik yang bisa melakukan ini.
4. **Q-2 Contract masih bisa di-upgrade (tinggi, disengaja sampai audit eksternal).** Sampai dibuat final, perlindungan kuantumnya bergantung pada kunci multisig yang memakai Ed25519.
5. **Aplikasi belum ditandatangani resmi.** Build Windows dan macOS belum code-signed (OS menampilkan peringatan); build iOS tanpa tanda tangan dan hanya bisa dipasang lewat sideload; APK Android ditandatangani dengan kunci rilis proyek (commit `c6c5fcb`, sertifikat SHA-256 `dbec38c5…9d74`, lihat `57-…`). Distribusi lewat toko aplikasi (Play Store, App Store) belum dilakukan.
6. **iOS di iPhone fisik** belum diuji; baru di simulator.

## 8. Cara mengulang pengujian

```
git clone https://github.com/bryankwandou/QUANTCOIN && cd QUANTCOIN
cargo build-sbf --manifest-path programs/qc-vault/Cargo.toml && cargo test -p qc-vault --release
cd client && npm ci && npx tsx verify-mainnet.ts            # 30 pemeriksaan mainnet baca-saja
cd ../app && npm ci && npx vitest run && npm run build
cd ../apps && npm ci && cd extension && npm test && npm run build
cd ../native && flutter test
```
File rilis: github.com/bryankwandou/QUANTCOIN/releases/tag/app-v0.1.0 (checksum di `SHA256SUMS.txt`).
