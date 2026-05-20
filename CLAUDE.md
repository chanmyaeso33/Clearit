# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ClearIt is an AI-powered text simplification web app. It simplifies or summarizes complex text in any language using the Groq API (Llama models). It also supports camera-based OCR (scan a document, get a plain-language summary).

## Running the Project

**Backend (required for AI features):**
```
npm install
node server.js          # or: npm start
```
Requires env var: `GROQ_API_KEY`. Optional: `STRIPE_SECRET_KEY`, `PORT` (defaults to 3000).

**Frontend:**
Open `index.html` directly in a browser. No build step. No bundler. The page points to the deployed backend at `https://clearit-xezb.onrender.com` — change this URL to `http://localhost:3000` for local backend testing.

## Architecture

This is a two-file project:

| File | Role |
|---|---|
| `index.html` | Everything frontend: landing page, embedded app, all CSS, all JS |
| `server.js` | Express API backend |
| `package.json` | Backend deps only (express, cors, sharp) |

**No frontend framework, no bundler, no transpilation.** All frontend logic runs in vanilla JS inside `<script>` tags at the bottom of `index.html`.

### Backend API Endpoints

**`POST /api/simplify`** — Text simplification/summarization
- Body: `{ text, outputLang, mode }` where `mode` is `"simplify"` or `"summarize"`
- Calls Groq's `llama-3.3-70b-versatile` model
- Special handling for Burmese and Thai: validates Unicode script in response, retries with stronger instructions if wrong language returned
- Returns: `{ simplified, language, theme }` where `theme` contains colors keyed to detected topic

**`POST /api/scan`** — Camera OCR + simplification
- Body: `{ imageBase64, outputLang, mode }`
- 3-step grounded pipeline to prevent hallucination:
  1. **Step 0**: Sharp image preprocessing (upscale 2×, grayscale, normalize, sharpen, binarize) — biggest quality improvement for real-world photos
  2. **Step 1**: Vision LLM (`llama-4-scout-17b-16e-instruct`) extracts raw text verbatim; `temperature: 0.0`
  3. **Step 1.5**: Cleanup pass with `llama-3.3-70b-versatile` — fixes obvious scan artifacts without rewriting
  4. **Step 1.6**: Burmese Unicode sanity check (ratio + repeated diacritics detection)
  5. **Step 2+3**: Grounded simplification — strict rules forbidding model from adding knowledge not in source; hallucination guard via novel-word-ratio check (>0.5 triggers retry)

**`POST /api/create-checkout`** and **`POST /api/check-subscription`** — Stripe integration (kept in server but disabled in frontend; payment gate is off)

### Frontend Structure (inside `index.html`)

Sections in order:
1. CSS (landing page styles, then app section styles, then mobile breakpoints)
2. Google Analytics
3. Landing page HTML (nav, hero with live demo, marquee, how-it-works, audience, testimonial, languages, CTA)
4. App section HTML (text input, mode toggle, language pill selector, scan button, result card, history)
5. Auth modal HTML + Upgrade modal HTML
6. `<script>` block 1: Supabase auth (sign in / sign up / sign out, JWT to localStorage)
7. `<script>` block 2: Hero live demo + language pill selector + scroll reveal + all app logic

### Key Patterns

**`safeParseJSON(raw, fieldName)`** — 4-layer fallback JSON parser for model output. LLMs sometimes wrap JSON in markdown fences or truncate. Handles: clean parse → boundary extraction → regex field extraction → any-quoted-string fallback.

**Dynamic theming** — After each simplification, `applyTheme()` sets CSS variables on `#app-section` based on the detected topic (Tech=`#00d4ff`, Legal=gold, Science=cyan, Health=green, etc.). The `themeMap` object exists identically in both `server.js` (returned in response) and is applied by the frontend.

**History** — Up to 10 items stored in-memory (`historyItems` array). Each item syncs to Supabase table `simplifications` via `saveToSupabase()`. On login, `loadFromSupabase()` fetches the user's last 10. Anonymous users get a random `user_key` stored in `localStorage`.

**Supabase auth** — Uses raw Supabase REST API (no SDK). Token stored as `clearit_token` in localStorage. Anonymous simplifications use anon key as Bearer token; logged-in simplifications use the user JWT for RLS.

**Burmese/Thai special cases** — Both endpoints have explicit Unicode-range checks (`/[က-႟]/` for Burmese, `/[฀-๿]/` for Thai) and auto-retry with stronger prompts if the model returns the wrong script.

**Scanner vs. text flow** — The `simplify()` function checks `scannedImageBase64`. If a scan is active, it routes to `simplifyFromScan()` instead of text mode. Language-pill changes trigger `updateScanHint()` to prompt the user to re-tap the button.

## External Services

| Service | Purpose | Key |
|---|---|---|
| Groq API | LLM inference (Llama models) | `GROQ_API_KEY` env var |
| Supabase | Auth + history storage | Anon key hardcoded in `index.html` (public) |
| Stripe | Payment (disabled) | `STRIPE_SECRET_KEY` env var |
| Render | Backend hosting | `https://clearit-xezb.onrender.com` |
| GitHub Pages | Frontend hosting | `chanmyaeso33.github.io/Clearit` |

The Supabase anon key in `index.html` is intentionally public — it is the Supabase anonymous key, access-controlled by Row Level Security policies on the Supabase side.
