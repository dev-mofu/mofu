# Prompt pembangunan Mofu

Folder ini isinya prompt buat AI coding agent (misalnya Claude Code) supaya ngebangun Mofu **satu fase per satu fase**.

## Isi

| File | Isi |
|---|---|
| `00-project-brief.md` | Konteks lengkap project: konsep, batasan, arsitektur, API, desain. **Wajib dibaca agent di setiap fase.** |
| `phase-1-core-cli.md` | Monorepo, otak agent, koneksi OpenRouter, CLI `mofu` dengan tool file dan perintah |
| `phase-2-web-workspace.md` | Web app di Cloudflare Workers: chat, limit per IP, Turnstile, BYOK, memori |
| `phase-3-repopilot.md` | Branch, test, commit, dan PR di CLI, plus penjelas repo GitHub publik di web |
| `phase-4-dependencyguard.md` | Scan dependency npm/PyPI ke OSV, rencana upgrade, `mofu deps --fix` |
| `phase-5-data-analyst.md` | Pyodide, profil data, grafik, data pendukung (kurs, hari libur, cuaca, negara, World Bank) |
| `phase-6-study-buddy.md` | PDF/link, ringkasan, flashcard, kuis, Wikipedia/arXiv/Crossref |
| `phase-7-apiforge.md` | OpenAPI: test, dokumentasi, deteksi breaking change, jalanin test di CLI |
| `phase-8-landing-page.md` | Landing page gaya pixel malam dengan maskot Mofu |
| `phase-9-launch.md` | Audit keamanan dan biaya, checklist launch, deploy, publish npm |

## Cara pakai

1. Buka sesi baru di agent-nya, dengan folder project ini sebagai folder kerja.
2. Kirim pesan:
   > Read `prompts/00-project-brief.md`, then do `prompts/phase-1-core-cli.md`.
3. Tunggu sampai agent ngasih laporan. Cobain hasilnya sendiri.
4. Kalau udah oke, **buka sesi baru** buat fase berikutnya. Sesi baru bikin konteksnya bersih dan lebih hemat.
5. Ulangi sampai fase 9.

## Yang perlu kamu siapin

- **Fase 1:** API key OpenRouter buat development, dipasang sebagai environment variable `OPENROUTER_API_KEY`. Jangan ditempel di chat.
- **Fase 2:** akun Cloudflare (buat development lokal, kunci test Turnstile udah cukup).
- **Fase 9:** domain, akun npm, dan API key OpenRouter kedua buat production dengan batas kredit.

## Pengaman yang udah ada di setiap prompt

- Agent dilarang lanjut ke fase berikutnya sendiri.
- Agent wajib minta izin sebelum deploy, publish, push, atau bikin PR.
- Ada batas jumlah panggilan model per fase, biar kredit $6 awet.
- Tiap fase harus lolos build, lint, dan test sebelum dianggap selesai.
