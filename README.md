# 🪖 TrenchMeme — Telegram alert bot untuk trenching meme coin Solana (<50k mcap)

Bot pribadi yang:
1. **Menganalisis CA** yang kamu kirim di Telegram (atau link DexScreener / pump.fun / GMGN / Axiom) dan membalas laporan kelayakan + skor 0–100.
2. **Memindai token baru secara otomatis** (GitHub Actions, tiap ±5 menit) dan mengirim 🚨 **alert** ke Telegram kalau ada token <50k mcap yang lolos semua filter keamanan & distribusi.

Sumber data (semua gratis, Solana mainnet): Solana RPC, RugCheck, DexScreener, pump.fun, GeckoTerminal.

---

## Setup (±10 menit, sekali saja)

| # | Langkah |
|---|---|
| 1 | Di Telegram buka **@BotFather** → `/newbot` → simpan **token bot**. |
| 2 | Vercel → project **trenchmeme** → Settings → Environment Variables → tambah `TELEGRAM_BOT_TOKEN` → **Redeploy**. |
| 3 | Buka `https://<domain-vercel-kamu>/api/setup` → webhook terpasang. |
| 4 | Kirim `/start` ke bot → bot membalas **chat ID** kamu. |
| 5 | Tambah `TELEGRAM_CHAT_ID` di Vercel → **Redeploy**. Sekarang bot hanya melayani chat kamu. |
| 6 | GitHub repo → Settings → Secrets and variables → Actions → **Secrets**: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (opsional `RPC_URL`). Scanner langsung aktif. |

**Sangat disarankan:** buat RPC gratis (mis. Helius / QuickNode / Alchemy free tier) dan isi `RPC_URL` di Vercel **dan** GitHub Secrets. RPC publik Solana sering kena rate-limit sehingga deteksi bundle/sniper bisa "n/a".

### Opsi tambahan
| Variabel | Default | Fungsi |
|---|---|---|
| `MAX_MCAP` | 50000 | Batas atas market cap kandidat |
| `MIN_MCAP` | 7000 | Abaikan token yang terlalu mentah |
| `ALERT_MIN_SCORE` | 75 | Skor minimal untuk alert |
| `ALERT_LEVEL` | buy | `caution` = ikut kirim alert 🟡 |
| `ACCESS_KEY` | – | Kunci untuk halaman web & `/api/analyze` |

(`MAX_MCAP`, `MIN_MCAP`, `ALERT_*` di GitHub diisi sebagai **Variables**, bukan Secrets.)

---

## Indikator yang diperiksa

| Grup | Indikator | ✅ Bagus | ⚠️ Waspada | ❌ Buruk (★ = kritis → otomatis HINDARI) |
|---|---|---|---|---|
| Kontrak | Mint authority | revoked | – | aktif ★ |
| | Freeze authority | revoked | – | aktif ★ |
| | Token-2022 ekstensi | – | ada ekstensi | permanentDelegate / transferHook / nonTransferable ★ |
| | Transfer tax | 0 | ≤5% | >5% (>10% ★) |
| | Metadata | immutable | mutable | – |
| | RugCheck | 0 risiko | ada warning | ada "danger" / rugged ★ |
| Likuiditas | Curve / LP | bonding curve pump.fun, LP ≥15% MC & terkunci | LP 8–15% MC | LP <8% MC, LP tidak terkunci ★ |
| Distribusi | Top 10 (tanpa curve/LP) | ≤20% | 20–30% | >30% (>45% ★) |
| | Holder terbesar non-dev | ≤4% | 4–8% | >8% (>15% ★) |
| | Jumlah holder | ≥100 | 40–99 | <40 |
| | Fresh wallet di top 10 | ≤1 | 2–3 | ≥4 |
| | Jaringan insider (RugCheck) | 0 | 1–3 | >3 |
| Launch | Bundle (blok 0) | 0 wallet | masih pegang ≤3% | masih pegang >3% (>15% ★) |
| | Sniper (≤3 slot) | pegang ≤5% | 5–15% | >15% |
| Dev | Holding | ≤5% | 5–10% | >10% (>20% ★) |
| | Rekam jejak | pernah graduate (≥10%) | dev baru | ≥5 koin tanpa graduate (≥20 ★) |
| | Umur wallet | >2 hari | fresh | – |
| Momentum | Buy/Sell 1 jam | ≥1.1 | 0.8–1.1 | <0.8 |
| | Volume 1 jam | ≥50% MC | 15–50% | <15% |
| Sosial | X / TG / Web | ≥2 | 1 | tidak ada |
| | DEX paid | ya | belum | – |

**Verdict**: 🟢 *LAYAK DIPERTIMBANGKAN* = skor ≥75, tidak ada ❌ berbobot tinggi, data inti terbaca · 🟡 *HATI-HATI* = skor 55–74 · 🔴 *HINDARI* = ada kritis atau skor <55.

---

## Panduan memilih koin di bawah 50k mcap

1. **Kontrak dulu, narasi belakangan.** Mint & freeze harus revoked. Token pump.fun otomatis aman di sini; token "luar" (Token-2022, launchpad lain) wajib dicek ekstensi & tax.
2. **Distribusi adalah segalanya di mcap kecil.** Di 30k mcap, satu wallet 5% = ±$1.500 — cukup untuk menghancurkan chart. Target: top 10 ≤20%, tidak ada wallet >4% selain curve/LP.
3. **Bundle = supply tersembunyi milik dev.** Wallet yang beli di slot yang sama dengan pembuatan token hampir pasti terkoordinasi. Yang penting bukan berapa yang dibeli, tapi **berapa yang masih dipegang**.
4. **Fresh wallet & insider.** Banyak wallet baru (dibuat <3 hari, <50 tx) di top holder biasanya pecahan wallet dev. Cek Bubblemaps: cluster yang saling terhubung = red flag.
5. **Dev serius** = wallet punya umur & histori, pernah membawa koin graduate, holding kecil (≤5%), aktif di X/TG, bayar DEX. Dev yang launch puluhan koin tanpa satupun graduate = pabrik rug.
6. **Momentum organik.** Buy > sell, volume 1 jam ≥ setengah MC, jumlah holder naik. Waspadai volume tinggi dengan holder stagnan (wash trading bot).
7. **Eksekusi.** Size kecil per koin, ambil modal di 2x, sisanya ride. Cut segera bila dev/bundle wallet mulai jual atau top 10 naik tajam.

> Ini alat bantu riset, **bukan nasihat keuangan**. Tidak ada filter yang bisa menjamin token tidak rug — selalu DYOR.

---

## Struktur
```
api/telegram.js   webhook bot (CA → laporan, tombol refresh & link)
api/setup.js      daftarkan webhook + menu perintah
api/analyze.js    JSON API analisis (?ca=)
api/feed.js       kandidat token baru yang lolos prefilter
lib/analyze.js    mesin analisis & skoring
lib/feed.js       sumber token baru (DexScreener, GeckoTerminal, pump.fun)
lib/telegram.js   format pesan Telegram
scripts/scan.js   scanner + alert (GitHub Actions)
scripts/check.js  CLI: node scripts/check.js <CA>
```
