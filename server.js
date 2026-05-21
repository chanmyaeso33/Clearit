const express = require('express');
const cors = require('cors');

// ✅ Sharp for image preprocessing before OCR
// Dramatically improves OCR accuracy on rotated/low-contrast/wrinkled documents
let sharp;
try {
  sharp = require('sharp');
} catch(e) {
  console.warn('Sharp not available — image preprocessing disabled. Run: npm install sharp');
  sharp = null;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ✅ Clean markdown JSON wrappers from model output
function cleanJsonString(str) {
  return str
    .replace(/```json/g, '')
    .replace(/```/g, '')
    .replace(/^[^{]*/, '')
    .replace(/}[^}]*$/, '}')
    .trim();
}

// ✅ Burmese Unicode detection — threshold-based to avoid false positives from OCR noise
function isBurmese(text) {
  const matches = (text.match(/[\u1000-\u109F]/g) || []).length;
  return matches > 20; // require at least 20 Burmese chars — avoids triggering on OCR noise
}

function isThai(text) {
  const matches = (text.match(/[\u0E00-\u0E7F]/g) || []).length;
  return matches > 20;
}

// ✅ Detect actual script language from text
function detectScript(text) {
  const burmeseCount = (text.match(/[\u1000-\u109F]/g) || []).length;
  const thaiCount = (text.match(/[\u0E00-\u0E7F]/g) || []).length;
  const thaiLetters = (text.match(/[\u0E01-\u0E5B]/g) || []).length;
  if (burmeseCount > 20 && burmeseCount > thaiCount) return 'Burmese';
  if (thaiCount > 20 || thaiLetters > 10) return 'Thai';
  if (/[\u4E00-\u9FFF]/.test(text)) return 'Chinese';
  if (/[\u3040-\u30FF]/.test(text)) return 'Japanese';
  if (/[\uAC00-\uD7AF]/.test(text)) return 'Korean';
  return 'English';
}

// ✅ Safe JSON parse with 3-layer fallback
function safeParseJSON(raw, fieldName = 'simplified') {
  console.log('RAW MODEL OUTPUT:', raw.substring(0, 800));

  // Attempt 1 — clean and parse
  try {
    const parsed = JSON.parse(cleanJsonString(raw));
    console.log('Parse 1 success');
    return parsed;
  } catch (e1) {
    console.warn('Parse 1 failed:', e1.message);
  }

  // Attempt 2 — find { } boundaries
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      console.log('Parse 2 success');
      return parsed;
    }
  } catch (e2) {
    console.warn('Parse 2 failed:', e2.message);
  }

  // Attempt 3 — regex field extraction (handles text, simplified, summary)
  try {
    const patterns = [
      new RegExp(`"${fieldName}"\\s*:\\s*"([\\s\\S]+?)"\\s*,\\s*"(?:lang|language|topic|theme)"`, 'm'),
      new RegExp(`"${fieldName}"\\s*:\\s*"([\\s\\S]+?)"\\s*}`, 'm'),
      /"(?:text|simplified|summary)"\s*:\s*"([\s\S]+?)"\s*[,}]/m
    ];

    let textValue = null;
    for (const pattern of patterns) {
      const match = raw.match(pattern);
      if (match && match[1]) { textValue = match[1]; break; }
    }

    const langMatch = raw.match(/"(?:lang|language)"\s*:\s*"([^"]{2,50})"/);
    const topicMatch = raw.match(/"topic"\s*:\s*"([^"]{2,30})"/);
    const moodMatch = raw.match(/"mood"\s*:\s*"([^"]{2,30})"/);

    if (textValue) {
      console.log('Parse 3 success:', textValue.substring(0, 100));
      return {
        [fieldName]: textValue,
        text: textValue,
        simplified: textValue,
        summary: textValue,
        language: langMatch ? langMatch[1] : 'Unknown',
        lang: langMatch ? langMatch[1] : 'Unknown',
        topic: topicMatch ? topicMatch[1] : (moodMatch ? moodMatch[1] : 'Tech'),
        theme: {
          mood: moodMatch ? moodMatch[1] : 'Tech',
          bg: '#0a0a0f', surface: '#13131a',
          text: '#f0ede8', accent: '#c8f050',
          muted: 'rgba(240,237,232,0.45)',
          border: 'rgba(255,255,255,0.08)'
        }
      };
    }
  } catch (e3) {
    console.warn('Parse 3 failed:', e3.message);
  }

  // Attempt 4 — just grab any quoted text value as last resort
  try {
    const anyText = raw.match(/:\s*"([^"]{20,}?)"/);
    if (anyText && anyText[1]) {
      console.log('Parse 4 last resort:', anyText[1].substring(0, 100));
      return {
        text: anyText[1], simplified: anyText[1], summary: anyText[1],
        language: 'Unknown', topic: 'Tech',
        theme: { mood: 'Tech', bg: '#0a0a0f', surface: '#13131a', text: '#f0ede8', accent: '#c8f050', muted: 'rgba(240,237,232,0.45)', border: 'rgba(255,255,255,0.08)' }
      };
    }
  } catch (e4) {
    console.warn('Parse 4 failed:', e4.message);
  }

  console.error('ALL PARSE METHODS FAILED:', raw);
  return null;
}

// ✅ Detect if output is garbage (numbered list, empty, or too short)
function isGarbageOutput(text) {
  if (!text || text.trim().length < 10) return true;
  // Burmese numbered list pattern — clear failure signal: (၁)(၂)(၃)...
  const burmeseNumberList = (text.match(/\(([၀-၉]+)\)/g) || []).length;
  if (burmeseNumberList > 5) {
    console.warn('Garbage detected: Burmese numbered list output');
    return true;
  }
  // Just numbers, no actual content
  const nonNumericChars = text.replace(/[0-9၀-၉()\n\r\s.,;:]/g, '').length;
  if (nonNumericChars < 10) {
    console.warn('Garbage detected: output contains almost no real content');
    return true;
  }
  return false;
}

// ✅ Fix over-segmented Burmese syllables (OCR cleanup sometimes inserts spaces between
// Myanmar Unicode combining marks and base characters where no space should exist)
function fixBurmeseSpacing(text) {
  if (!text || !/[က-႟]/.test(text)) return text;
  return text
    .replace(/([က-႟ါ-ှ၀-၏])\s+([က-႟])/g, '$1$2')
    .replace(/([က-႟])\s+([ါ-ှ])/g, '$1$2')
    .trim();
}

// Call Google Cloud Vision API for OCR — used when GOOGLE_VISION_KEY is set
async function extractTextWithGoogleVision(base64Image, apiKey) {
  const visionRes = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          image: { content: base64Image },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }]
        }]
      })
    }
  );
  if (!visionRes.ok) {
    const err = await visionRes.json();
    throw new Error(err.error?.message || `Vision API error ${visionRes.status}`);
  }
  const visionData = await visionRes.json();
  const annotation = visionData.responses?.[0];
  const text = annotation?.fullTextAnnotation?.text
             || annotation?.textAnnotations?.[0]?.description
             || '';
  return text.trim();
}

// ✅ Novel word ratio — fraction of output tokens not present in source
// Only meaningful when source and output are in the same language/script.
// Cross-language output will always score ~1.0 (all words are "novel"), so callers
// must skip this check when imageScript !== targetLang.
function novelWordRatio(sourceText, outputText) {
  if (!sourceText || !outputText) return 0;
  const sourceWords = new Set(
    sourceText.toLowerCase().replace(/[^\wက-႟฀-๿\s]/g, ' ')
      .split(/\s+/).filter(w => w.length > 2)
  );
  const outputWords = outputText.toLowerCase().replace(/[^\wက-႟฀-๿\s]/g, ' ')
    .split(/\s+/).filter(w => w.length > 2);
  if (outputWords.length === 0) return 0;
  const novelWords = outputWords.filter(w => !sourceWords.has(w));
  return novelWords.length / outputWords.length;
}

// ✅ Main endpoint
app.post('/api/simplify', async (req, res) => {
  try {
    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey) return res.status(500).json({ error: 'API key not configured' });

    let { text, outputLang, mode, messages } = req.body;

    // Support both new simple format and old messages format
    const targetLang = outputLang || 'English';
    const isSummarize = mode === 'summarize';
    const fieldName = isSummarize ? 'summary' : 'simplified';

    // Get input text from simple format or messages format
    const inputText = text || '';
    if (!inputText) return res.status(400).json({ error: 'No text provided' });

    console.log('Input text:', inputText.substring(0, 100));
    console.log('Output lang:', targetLang);
    console.log('Mode:', mode || 'simplify');

    // ✅ PRODUCTION-GRADE PROMPT SYSTEM v4
    const langInstruction = targetLang === 'Burmese'
      ? `You MUST write ONLY in Burmese script (Myanmar Unicode \u1000-\u109F). No English words allowed.

BURMESE NATURALNESS RULES (critical):
- Write naturally for educated native Burmese speakers — NOT direct translation
- Avoid literal translation sentence structure from English/source language
- Use "ဖွံ့ဖြိုးဆဲနိုင်ငံများ" (NOT "တဖြည်းဖြည်း ဖွံ့ဖြိုးတိုးတက်နေသော နိုင်ငံများ") for developing countries
- Use "ကမ္ဘာ့ရာသီဥတုပြောင်းလဲမှု" for climate change
- Use "ဖော့ဆီလ်လောင်စာ" for fossil fuels
- Use "လေအား" for wind energy
- Use "ပြန်လည်အသုံးပြုနိုင်သည့် စွမ်းအင်" for renewable energy — NEVER "အသစ်ပြောင်းလဲနိုင်သော စွမ်းအင်"
- Use "စွမ်းအင်စနစ်များတွင် အဓိကပြောင်းလဲမှုများ" for energy system changes
- Use "နေအား" for solar energy
- Use "တစ်ပြိုင်နက်တည်း" naturally — never redundantly with other simultaneous markers
- Write shorter clauses — avoid stacking too many nouns together
- Use accessible educational Burmese tone — clear and readable for high school students
- Do NOT use overly formal written Burmese — aim for natural educated speech patterns
- Check every phrase: would a native Burmese speaker say this naturally?

REFERENCE QUALITY EXAMPLE (aim for this level of naturalness):
လူသားတို့ကြောင့် ဖြစ်ပေါ်လာသည့် ကမ္ဘာ့ရာသီဥတုပြောင်းလဲမှု၏ လွှမ်းမိုးမှုများကို လျှော့ချရန် စွမ်းအင်စနစ်များတွင် အဓိက ပြောင်းလဲမှုများ လိုအပ်ပါသည်။ ဖော့ဆီလ်လောင်စာများမှ ပြန်လည်အသုံးပြုနိုင်သည့် စွမ်းအင်များသို့ ပြောင်းလဲရန်နှင့် တစ်ပြိုင်နက်တည်း ဖွံ့ဖြိုးဆဲနိုင်ငံများရှိ စီးပွားရေး မညီမျှမှုများကိုလည်း ဖြေရှင်းရန် လိုအပ်ပါသည်။`
      : targetLang === 'Thai'
      ? `You MUST write ONLY in Thai script. No English words allowed.

THAI NATURALNESS RULES (critical):
- Write naturally for native Thai speakers — NOT formal academic Thai
- Use "เชื้อเพลิงฟอสซิล" NOT "น้ำมันเชื้อเพลิง" for fossil fuels (technically precise)
- Use "อย่างเป็นระบบ" for systemic transformation
- Avoid overly formal phrases like "อย่างมีนัยสำคัญ"
- Use natural simplified Thai like: "เพื่อลดผลกระทบจากการเปลี่ยนแปลงสภาพภูมิอากาศ"
- Break complex sentences into shorter natural Thai clauses
- Use everyday educated Thai vocabulary while preserving meaning
- Sound educational and clear — not bureaucratic

REFERENCE QUALITY EXAMPLE (aim for this level):
การบรรเทาผลกระทบจากการเปลี่ยนแปลงสภาพภูมิอากาศที่เกิดจากมนุษย์ จำเป็นต้องมีการเปลี่ยนแปลงระบบพลังงานอย่างเป็นระบบ โดยเปลี่ยนจากการพึ่งพาเชื้อเพลิงฟอสซิลไปสู่พลังงานทดแทน พร้อมกับแก้ไขปัญหาความไม่เท่าเทียมทางเศรษฐกิจในประเทศกำลังพัฒนา`
      : `Write the output in natural, fluent ${targetLang}.`;

    const simplifyMessages = isSummarize ? [
      {
        role: 'system',
        content: `You are an expert multilingual text summarization system.
${langInstruction}
Respond ONLY with a valid JSON object. No markdown. No explanation. No backticks.`
      },
      {
        role: 'user',
        content: `Step 1: Identify the most important points, facts, and conclusions in this text.
Step 2: Write a concise summary in ${targetLang} that captures all key information naturally.

RULES:
- Preserve all important facts, numbers, names, and dates
- Put the most important point first
- Keep logical relationships between ideas intact
- Do NOT add your own opinions or analysis
- Do NOT remove key information
- Length: 3-5 clear sentences
- Rewrite naturally for native speakers of ${targetLang} — avoid direct translation structure
- Preserve meaning while maximizing fluency and readability

Your summary will be evaluated on:
- information completeness
- factual accuracy
- logical coherence
- natural fluency in ${targetLang}
- readability for educated non-expert readers

INPUT TEXT:
"""
${inputText}
"""

Return ONLY this JSON:
{"text":"your complete summary in ${targetLang}","lang":"language of the input text","topic":"one of: Tech Legal Science Health Finance Education Food Politics Philosophy Creative News Business Culture"}`
      }
    ] : [
      {
        role: 'system',
        content: `You are a production-grade multilingual text simplification system.
${langInstruction}
Respond ONLY with a valid JSON object. No markdown. No explanation. No backticks.`
      },
      {
        role: 'user',
        content: `Step 1: Identify ALL of the following in the text:
- Core meaning and main argument
- Causal relationships (because, therefore, since)
- Simultaneous actions (while, at the same time)
- Important nuances and qualifications
- Scientific or technical precision (e.g. "reduce the EFFECTS of" not "reduce")
- Economic, social, or scientific relationships

Step 2: Rewrite naturally for native speakers of ${targetLang}, preserving everything from Step 1.

CRITICAL RULES:
- Rewrite naturally for native speakers of ${targetLang} — avoid direct translation structure
- Preserve meaning while maximizing fluency and readability
- Use "reduce the effects of" NOT "reduce" for ongoing phenomena like climate change
- Use "major changes" not "big changes" for large-scale transformation
- Preserve "human-caused" or "caused by humans" when original says anthropogenic
- Use "while" OR "at the same time" — NEVER BOTH together (redundant)
- Keep "economic inequality" or "economic disparities" — never weaken to "economic differences"
- Do NOT oversimplify — never sacrifice precision for brevity
- Do NOT add filler phrases — every word must carry meaning
- Target audience: educated high school student or general adult reader
- Sound natural and educational — not academic or bureaucratic

Your output will be evaluated on:
- meaning preservation (most important — no semantic drift)
- scientific/technical accuracy
- simultaneous and causal structure preserved WITHOUT redundancy
- natural fluency in ${targetLang} for native speakers
- clarity without losing nuance
- conciseness — no unnecessary repetition

TARGET: near state-of-the-art educational simplification quality (9.5+).

INPUT TEXT:
"""
${inputText}
"""

Return ONLY this JSON:
{"text":"your natural, precise simplified version in ${targetLang}","lang":"language of the input text","topic":"one of: Tech Legal Science Health Finance Education Food Politics Philosophy Creative News Business Culture"}`
      }
    ];

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqApiKey}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 2000,
        temperature: 0.2,
        messages: simplifyMessages
      })
    });

    if (!groqRes.ok) {
      const error = await groqRes.json();
      return res.status(groqRes.status).json({ error: error.error?.message || 'Groq error' });
    }

    const groqData = await groqRes.json();
    const raw = groqData.choices[0].message.content;
    console.log('RAW OUTPUT:', raw.substring(0, 500));

    let parsed = safeParseJSON(raw, 'text');

    // If parsing failed use raw text directly
    if (!parsed) {
      const cleanRaw = raw.replace(/```json|```|\{|\}/g, '').trim();
      parsed = {
        text: cleanRaw || 'Could not process text.',
        simplified: cleanRaw,
        summary: cleanRaw,
        language: 'Unknown',
        topic: 'Tech'
      };
    }

    // Validate language for Burmese and Thai
    const outputText = parsed.text || parsed[fieldName] || parsed.simplified || parsed.summary || '';

    if (targetLang === 'Burmese' && outputText && !/[က-႟]/.test(outputText)) {
      const burmeseRetries = [
        { temperature: 0.1, msg: '\n\nCRITICAL: Previous response was NOT in Burmese script. You MUST use Myanmar Unicode characters ONLY. Every word must be Burmese.' },
        { temperature: 0.0, msg: '\n\nFINAL ATTEMPT: You keep returning English. Output MUST be 100% Burmese Myanmar Unicode script. The very first character must be Myanmar script. Write NOTHING in English.' }
      ];
      for (const attempt of burmeseRetries) {
        console.warn(`Burmese validation failed — retrying (temp ${attempt.temperature})`);
        simplifyMessages[0].content += attempt.msg;
        const retryRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqApiKey}` },
          body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 2000, temperature: attempt.temperature, messages: simplifyMessages })
        });
        if (retryRes.ok) {
          const retryRaw = (await retryRes.json()).choices[0].message.content;
          const retryParsed = safeParseJSON(retryRaw, 'text');
          if (retryParsed) {
            Object.assign(parsed, retryParsed);
            if (/[က-႟]/.test(parsed.text || '')) break;
          }
        }
      }
    }

    if (targetLang === 'Thai' && outputText && !/[฀-๿]/.test(outputText)) {
      const thaiRetries = [
        { temperature: 0.1, msg: '\n\nCRITICAL: Previous response was NOT in Thai script. You MUST use Thai Unicode characters ONLY. Every word must be Thai.' },
        { temperature: 0.0, msg: '\n\nFINAL ATTEMPT: You keep returning English. Output MUST be 100% Thai script. The very first character must be Thai Unicode. Write NOTHING in English.' }
      ];
      for (const attempt of thaiRetries) {
        console.warn(`Thai validation failed — retrying (temp ${attempt.temperature})`);
        simplifyMessages[0].content += attempt.msg;
        const retryRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqApiKey}` },
          body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 2000, temperature: attempt.temperature, messages: simplifyMessages })
        });
        if (retryRes.ok) {
          const retryRaw = (await retryRes.json()).choices[0].message.content;
          const retryParsed = safeParseJSON(retryRaw, 'text');
          if (retryParsed) {
            Object.assign(parsed, retryParsed);
            if (/[฀-๿]/.test(parsed.text || '')) break;
          }
        }
      }
    }

    const finalText = parsed.text || parsed[fieldName] || parsed.simplified || parsed.summary || '';
    const topic = parsed.topic || parsed.mood || 'Tech';
    const inputLang = parsed.lang || parsed.language || 'Unknown';

    // Build theme based on topic
    const themeMap = {
      'Tech': { bg: '#061420', surface: '#0d1f2d', accent: '#00d4ff' },
      'Legal': { bg: '#0d0d14', surface: '#14141f', accent: '#c8a44a' },
      'Science': { bg: '#061420', surface: '#0a1f2e', accent: '#4dd0e1' },
      'Health': { bg: '#061a0d', surface: '#0d2414', accent: '#4caf50' },
      'Finance': { bg: '#0a0d1a', surface: '#111428', accent: '#7986cb' },
      'Education': { bg: '#0d1014', surface: '#141c24', accent: '#42a5f5' },
      'Food': { bg: '#1a0e00', surface: '#241400', accent: '#ff8f00' },
      'Politics': { bg: '#1a0505', surface: '#240808', accent: '#ef5350' },
      'Philosophy': { bg: '#0d0a1a', surface: '#140f24', accent: '#9c27b0' },
      'Creative': { bg: '#1a0a12', surface: '#240f1a', accent: '#f06292' },
      'News': { bg: '#0a0a0a', surface: '#141414', accent: '#ff7043' },
      'Business': { bg: '#0a1014', surface: '#111820', accent: '#26c6da' },
      'Culture': { bg: '#1a0a14', surface: '#240f1a', accent: '#ff6b9d' }
    };

    const theme = themeMap[topic] || themeMap['Tech'];

    return res.status(200).json({
      [fieldName]: finalText,
      simplified: finalText,
      summary: finalText,
      language: inputLang,
      theme: {
        mood: topic,
        bg: theme.bg,
        surface: theme.surface,
        text: '#f0ede8',
        accent: theme.accent,
        muted: 'rgba(240,237,232,0.45)',
        border: 'rgba(255,255,255,0.08)'
      }
    });

  } catch (error) {
    console.error('Server error:', error.message);
    return res.status(500).json({ error: error.message || 'Server error' });
  }
});

// ✅ Scanner/Vision endpoint — 3-STEP GROUNDED PIPELINE (anti-hallucination)
// Step 1: Extract raw text from image (vision model only)
// Step 2: Clean + ground the extracted text
// Step 3: Simplify/summarize ONLY from the grounded text
app.post('/api/scan', async (req, res) => {
  try {
    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey) return res.status(500).json({ error: 'API key not configured' });

    const { imageBase64, outputLang, mode } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

    const targetLang = outputLang || 'English';
    const isSummarize = mode === 'summarize';

    // ✅ Debug: confirm API key is present on Render
    console.log('Scanner 3-step — lang:', targetLang, 'mode:', mode);
    console.log('API KEY EXISTS:', !!groqApiKey);

    // ── STEP 0: Image Preprocessing — auto-rotate, enhance contrast, sharpen ─
    // This is the single biggest quality improvement for real-world photos.
    // Fixes: rotation, low contrast, blur, wrinkled paper, dark photos.
    let processedImageBase64 = imageBase64; // fallback to original if sharp fails

    if (sharp) {
      try {
        const inputBuffer = Buffer.from(imageBase64, 'base64');

        // Pipeline: rotate → grayscale → normalize contrast → sharpen → threshold
        // .rotate() with no args uses EXIF orientation data (fixes 90°/180° rotation)
        // .normalize() stretches contrast to full range — fixes washed-out/dark photos
        // .sharpen() improves edge clarity for OCR
        // .threshold(160) converts to pure black/white — best for text recognition
        // Get image dimensions for upscaling
        const metadata = await sharp(inputBuffer).metadata();
        const originalWidth = metadata.width || 1200;
        const originalHeight = metadata.height || 1600;

        // Upscale to minimum 2400px wide — Burmese OCR improves dramatically with upscaling
        // Stacked characters and diacritics become distinguishable at higher resolution
        const targetWidth = Math.max(originalWidth * 2, 2400);

        const processedBuffer = await sharp(inputBuffer)
          .rotate()                          // auto-rotate using EXIF data
          .resize({ width: targetWidth,      // 2x upscale — critical for Burmese stacked chars
                    height: Math.round(originalHeight * (targetWidth / originalWidth)),
                    fit: 'fill' })
          .grayscale()                       // remove color noise
          .normalize()                       // auto-contrast stretch
          .sharpen({ sigma: 2.0 })           // stronger sharpening at higher res
          .threshold(170)                    // binarize: pure black/white (170 better for Burmese)
          .jpeg({ quality: 95 })             // re-encode as JPEG
          .toBuffer();

        console.log('STEP 0 — Upscaled from', originalWidth, 'x', originalHeight,
                    'to', targetWidth, 'px wide');

        processedImageBase64 = processedBuffer.toString('base64');
        console.log('STEP 0 — Preprocessing complete. Original size:', imageBase64.length,
                    '→ Processed size:', processedImageBase64.length);
      } catch(preprocessErr) {
        console.warn('STEP 0 — Preprocessing failed, using original image:', preprocessErr.message);
        processedImageBase64 = imageBase64; // fall back to original
      }
    } else {
      console.log('STEP 0 — Sharp not available, skipping preprocessing');
    }

    // ── STEP 1: Extract raw text from the image (vision model) ──────────────
    // Goal: ONLY read what is physically visible. No interpretation. No summary.
    // Script-aware: detect dominant script in output language selection.
    // NOTE: The image script may differ from the output language —
    //   e.g. user scans a Thai document but wants output in Burmese.
    //   Step 1 always reads the IMAGE script. Step 3 outputs in targetLang.
    const scriptHint = `The image may contain text in any language/script.
IMPORTANT: Do NOT assume the script based on the output language — read what is ACTUALLY in the image.
- If you see Thai script (like: ก ข ค ง), copy Thai Unicode characters
- If you see Burmese/Myanmar script (like: က ခ ဂ), copy Myanmar Unicode characters
- If you see Latin/English text, copy as-is
- If you see mixed scripts, copy each script in its original form
- Do NOT transliterate any script into Latin/English characters
- Rotated or sideways text: read it from ALL angles — rotate mentally to read it
- The image may be rotated 90° or 180° — still extract all visible text`;

    const extractMessages = [
      {
        role: 'system',
        content: `You are a precision OCR system specialized in multilingual text extraction.
Your ONLY job is to copy text from images exactly as it appears — character by character.

${scriptHint}

ABSOLUTE RULES:
- Copy ONLY characters physically visible in the image — zero exceptions
- Do NOT translate, summarize, explain, or interpret anything
- Do NOT add any word, name, or detail not visible in the image
- Do NOT invent or guess words — if unclear, mark [?]
- Do NOT transliterate non-Latin scripts into English/Latin characters
- If a full section is unreadable, write [unreadable section]
- Preserve original script, punctuation, paragraph numbers, and line breaks

Output ONLY the raw extracted text. No labels. No JSON. No explanation. Just the characters from the image.`
      },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${processedImageBase64}` }
          },
          {
            type: 'text',
            text: `Carefully read every character visible in this image and copy it exactly.

Your output must:
1. Use the SAME script as the image (Myanmar Unicode for Burmese, Thai Unicode for Thai, etc.)
2. Preserve every paragraph, number, and punctuation mark
3. NOT replace any non-English characters with English/Latin equivalents
4. Mark any unclear word with [?] immediately after it
5. Mark any unreadable paragraph as [unreadable section]

Start copying the text now — output ONLY the raw characters from the image:`
          }
        ]
      }
    ];

    // ── STEP 1: OCR backend selection ────────────────────────────────────────
    const googleVisionKey = process.env.GOOGLE_VISION_KEY;
    let extractedText;

    if (googleVisionKey) {
      console.log('STEP 1 — Using Google Cloud Vision OCR');
      try {
        extractedText = await extractTextWithGoogleVision(processedImageBase64, googleVisionKey);
        console.log('STEP 1 (Vision) — Extracted:', extractedText.substring(0, 600));
      } catch (visionErr) {
        console.warn('STEP 1 — Google Vision failed, falling back to llama-4-scout:', visionErr.message);
        extractedText = null;
      }
    }

    if (!googleVisionKey || !extractedText) {
      console.log('STEP 1 — Using llama-4-scout OCR');
      const extractRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqApiKey}` },
        body: JSON.stringify({
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
          max_tokens: 2000,
          temperature: 0.0,
          messages: extractMessages
        })
      });

      if (!extractRes.ok) {
        const error = await extractRes.json();
        return res.status(extractRes.status).json({ error: error.error?.message || 'OCR step failed' });
      }

      const extractData = await extractRes.json();
      extractedText = extractData.choices[0].message.content.trim();
      console.log('STEP 1 (llama-4-scout) — Extracted:', extractedText.substring(0, 600));
    }

    // Validate: for Burmese output lang, check if extracted text actually contains Burmese
    const hasBurmese = /[\u1000-\u109F]/.test(extractedText);
    const hasThai = /[\u0E00-\u0E7F]/.test(extractedText);

    // If the image has Burmese text but extraction returned only Latin/garbled text, warn in log
    if (targetLang === 'Burmese' && !hasBurmese) {
      console.warn('STEP 1 WARNING: Expected Burmese script but extraction returned non-Burmese text. OCR may have transliterated.');
    }

    if (!extractedText || extractedText.length < 5) {
      return res.status(422).json({ error: 'Could not read any text from the image. Try better lighting or a clearer photo.' });
    }

    // ── STEP 1.5: OCR Cleanup — fix corruption before simplification ─────────
    // Detects actual script in the image (may differ from targetLang)
    const imageScript = detectScript(extractedText);
    console.log('STEP 1.5 — Image script detected:', imageScript, '| Target output lang:', targetLang);

    // Always run OCR cleanup — Burmese/Thai corruption doesn't always produce [?] markers
    // Broken Unicode combining marks and spacing corruption are invisible without cleanup
    let cleanedText = extractedText;
    const hasNoise = true; // Always clean — OCR noise is always present in scanned images

    if (hasNoise) {
      console.log('STEP 1.5 — Running OCR cleanup pass (always on for scan pipeline)...');
      // STRICT RECONSTRUCTION MODE — preserve, do NOT rewrite
      // Goal: output must stay as close to the original as physically possible
      // The model must NOT paraphrase, normalize, improve, or stylistically alter anything
      const cleanupMessages = [
        {
          role: 'system',
          content: `You are a STRICT OCR reconstruction system for ${imageScript} text.

Your ONLY job: fix characters that are OBVIOUSLY broken by scanning artifacts.

ABSOLUTE RULES — violation means failure:
- Preserve EVERY original word exactly unless it has an obvious scan artifact
- NEVER rewrite sentences — not even slightly
- NEVER paraphrase or rephrase anything
- NEVER summarize or shorten
- NEVER improve style or grammar
- NEVER normalize unusual phrasing — it may be correct in the source
- NEVER invent or guess missing words — if uncertain, keep the original exactly
- If a word looks wrong but you are not 100% certain it is an OCR error, KEEP IT AS-IS
- Remove [?] markers: keep the word before it if readable, remove entirely if not
- Preserve ALL numbers, dates, currencies, names EXACTLY as they appear
- Output must be extremely close to input — only minimal targeted character fixes allowed

You are reconstructing, not rewriting. When in doubt, preserve the original.`
        },
        {
          role: 'user',
          content: `STRICT RECONSTRUCTION TASK:
Fix ONLY characters with obvious scan artifacts in this ${imageScript} text.
Every word that is not clearly broken must be kept exactly as written.

DO NOT:
- Rewrite any sentence
- Change any word order
- Add any punctuation not in the original
- Remove any content
- Translate anything
- Improve anything that looks grammatically odd — it may be correct

ONLY fix: characters clearly corrupted by the scanning process (e.g. box glyphs, broken diacritics, obvious substitution errors)

SOURCE OCR TEXT:
${extractedText}

Output the reconstructed text with MINIMAL changes only:`
        }
      ];

      try {
        const cleanupRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqApiKey}` },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            max_tokens: 2000,
            temperature: 0.0,
            messages: cleanupMessages
          })
        });
        if (cleanupRes.ok) {
          const cleanupData = await cleanupRes.json();
          const cleaned = cleanupData.choices[0].message.content.trim();
          if (cleaned && cleaned.length > 20) {
            cleanedText = cleaned;
            console.log('STEP 1.5 — Cleanup complete:', cleanedText.substring(0, 200));
          }
        }
      } catch(e) {
        console.warn('STEP 1.5 cleanup failed, using raw OCR:', e.message);
        // Fall through — use raw extractedText
      }
    }

    // ── STEP 1.6: Unicode sanity check for Burmese ───────────────────────────
    // Detect impossible Burmese sequences that indicate OCR corruption
    // If too corrupted, warn but still proceed — don't block the user
    if (imageScript === 'Burmese') {
      const burmeseChars = (cleanedText.match(/[က-႟]/g) || []).length;
      const totalChars = cleanedText.replace(/\s/g, '').length;
      const burmeseRatio = totalChars > 0 ? burmeseChars / totalChars : 0;

      // Detect repeated combining marks (sign of broken OCR)
      const repeatedDiacritics = (cleanedText.match(/([ါ-ှ]){2,}/g) || []).length;

      console.log('STEP 1.6 — Burmese ratio:', burmeseRatio.toFixed(2),
                  '| Repeated diacritics:', repeatedDiacritics);

      if (burmeseRatio < 0.3 && imageScript === 'Burmese') {
        console.warn('STEP 1.6 — Low Burmese character ratio — text may be heavily corrupted');
      }
      if (repeatedDiacritics > 5) {
        console.warn('STEP 1.6 — Repeated diacritics detected — OCR produced invalid Burmese sequences');
      }
    }

    // ── STEP 1.7: Normalise Burmese spacing in cleanedText before feeding to LLM ──
    // OCR cleanup can introduce spaces between Myanmar syllables/combining marks.
    // Fix this now so the LLM receives valid Burmese Unicode rather than fragmented text.
    if (imageScript === 'Burmese') {
      const beforeFix = cleanedText;
      cleanedText = fixBurmeseSpacing(cleanedText);
      if (beforeFix !== cleanedText) {
        console.log('STEP 1.7 — Burmese spacing normalised in cleanedText before LLM');
      }
    }

    // ── STEP 2 + 3: Grounded simplify/summarize from the CLEANED extracted text ─────
    // Goal: ONLY use what Step 1 found. Hard anti-hallucination rules.
    const langInstruction = targetLang === 'Burmese'
      ? `You MUST write ONLY in Burmese script (Myanmar Unicode \u1000-\u109F). No English words allowed. Write naturally for educated native Burmese speakers.`
      : targetLang === 'Thai'
      ? `You MUST write ONLY in Thai script. Write naturally for native Thai speakers — not formal academic Thai.`
      : `Write the output in natural, fluent ${targetLang}.`;

    const groundedMessages = [
      {
        role: 'system',
        content: `You are a faithful multilingual text compression system. Your job is to faithfully compress text — NOT to explain, interpret, or enrich it.
${langInstruction}

STRICT SOURCE FIDELITY RULES — Absolute. Never break them:
- Only summarize claims directly and explicitly stated in the SOURCE TEXT
- Do NOT infer benefits, causes, or consequences unless they are explicitly mentioned in the source
- Do NOT add contextual knowledge, background information, or general facts about the topic
- Do NOT mention any celebrity, person, brand, organization, product, or event unless it is explicitly written in the source text
- Do NOT expand on keywords using your training knowledge (e.g. seeing "Korea" does NOT mean you add K-pop, Samsung, or BTS)
- Faithful compression is your goal — not coherent storytelling
- A shorter, accurate output is always better than a longer, hallucinated one

CONFIDENCE-AWARE RULES (critical for OCR text):
- If any part of the text is marked [?] or [unreadable section], skip that part entirely — do not guess what it said
- If the text appears broken, incomplete, or garbled, summarize ONLY the clearly readable portions
- If OCR noise makes a sentence ambiguous, omit that sentence rather than interpret it
- Do NOT fill gaps in the OCR text with logical assumptions
- If the overall text is too damaged to summarize faithfully, output: "The scanned text was too incomplete to summarize accurately."

FORBIDDEN PATTERNS — never do these:
- Do NOT write "higher living standards" unless the source explicitly says that
- Do NOT write inferred causes like "due to electricity development" unless explicitly stated
- Do NOT write conclusions the source does not reach
- Do NOT add examples to illustrate the source's points

TOPIC-COMPLETING PROHIBITION — this is the most critical rule:
You are NOT allowed to use your training knowledge to complete or enrich the topic.
Seeing a topic keyword does NOT give permission to add related knowledge.
Specific examples of forbidden topic-completion:
- Seeing "Korea" or "Korean" → do NOT add K-pop, BTS, Samsung, Hallyu, kimchi unless written
- Seeing "technology" → do NOT add social media, internet, smartphones unless written
- Seeing "education" → do NOT add inequality, access, reform unless written
- Seeing "environment" → do NOT add climate change, carbon, pollution unless written
- Seeing Burmese academic prose → do NOT add globalization, youth culture, social issues unless written
- Seeing numbers → do NOT convert, extrapolate, or contextualize them
The source text is the COMPLETE universe of allowed information. Nothing else exists.

NUMBERS, DATES, CURRENCIES — zero tolerance for invention:
- Copy ALL numbers EXACTLY as they appear in the source (e.g. 900, 1,000, 10,000, 2569, 2570)
- Copy ALL dates EXACTLY as written — do NOT convert Thai Buddhist Era years to Western years
- Copy currency as written: บาท = baht, NOT kyats, NOT dollars, NOT any other currency
- If a number is unclear from OCR, omit it — do NOT guess or substitute
- NEVER invent a date (e.g. "1994") that does not appear in the source text
- NEVER convert currencies between systems

OUTPUT LANGUAGE RULE:
- If targetLang is English, write in English
- If targetLang is Burmese, write in Burmese script — but NEVER convert Thai baht to Myanmar kyats
- Currencies and proper nouns stay as-is from the source regardless of output language

Respond ONLY with a valid JSON object. No markdown. No explanation. No backticks.`
      },
      {
        role: 'user',
        content: `SOURCE TEXT (extracted and cleaned from scanned image — this is your ONLY source of truth):
"""
${cleanedText}
"""

Your task: Create a faithful ${isSummarize ? 'summary' : 'simplified version'} of the SOURCE TEXT above using ONLY information explicitly written in it. Output in ${targetLang}.

${isSummarize
  ? `FAITHFUL SUMMARY RULES:
- Include ONLY what the source text directly states — no inferences
- Do NOT add causal explanations unless the source explicitly states the cause
- Do NOT add socioeconomic conclusions not stated in the source
- Preserve all names, numbers, and facts exactly as written
- 2-4 sentences maximum — brevity and accuracy over completeness
- If something is unclear from OCR, leave it out rather than guess`
  : `EXTRACTIVE SIMPLIFICATION RULES — faithfulness over readability:
- Use ONLY information EXPLICITLY present in the source text — zero exceptions
- Do NOT rewrite naturally if it means adding new concepts
- Do NOT expand ideas — if the source says "X", do not add "such as Y and Z"
- Do NOT introduce technologies, industries, platforms, or social concepts not in the source
- Do NOT add online education, remote work, digital payments, social media unless written
- Simplify the WORDING only — never the information scope
- If a sentence is OCR-damaged or ambiguous, copy it more simply — do not skip or expand it
- Shorter and faithful beats longer and hallucinated — always
- Target: a direct, plain-language compression of what is actually written`}

Before writing your output, ask yourself:
1. "Is every single claim I am about to write explicitly stated in the source text above?"
2. "Am I using the EXACT numbers, dates, and currency from the source — not converting or guessing?"
3. "Am I writing in the correct output language (${targetLang}) while keeping source facts unchanged?"
If the answer to any question is no — fix it before outputting.

Never mention anything not written in the SOURCE TEXT above.
Never convert currencies. Never invent dates. Copy all numbers exactly.

Return ONLY this JSON:
{"text":"your faithful ${isSummarize ? 'summary' : 'simplified version'} in ${targetLang}","lang":"detected language of the source text","topic":"one of: Tech Legal Science Health Finance Education Food Politics Philosophy Creative News Business Culture"}`
      }
    ];

    // Temperature per stage (ChatGPT recommendation):
    // OCR repair: 0.0 | Simplification: 0.2 | Translation/Burmese: 0.1
    const simplifyTemp = targetLang === 'English' ? 0.2 : 0.1;
    // English gets slightly more fluency freedom (0.2)
    // Burmese/Thai stays at 0.1 — script accuracy more important than fluency

    const groundedRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqApiKey}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1000,
        temperature: simplifyTemp,
        messages: groundedMessages
      })
    });
    console.log('STEP 2+3 — Using temperature:', simplifyTemp, 'for lang:', targetLang);

    if (!groundedRes.ok) {
      const error = await groundedRes.json();
      return res.status(groundedRes.status).json({ error: error.error?.message || 'Simplify step failed' });
    }

    const groundedData = await groundedRes.json();
    const groundedRaw = groundedData.choices[0].message.content;
    console.log('STEP 2+3 — Grounded output:', groundedRaw.substring(0, 400));

    let parsed = safeParseJSON(groundedRaw, 'text');

    // Fallback: use extracted text directly if parsing fails
    if (!parsed) {
      console.log('Grounded parse failed — using extracted text as fallback');
      parsed = {
        text: extractedText,
        simplified: extractedText,
        summary: extractedText,
        language: 'Unknown',
        topic: 'Tech'
      };
    }

    // Skip cross-language comparisons — every English word is "novel" relative to Burmese/Thai
    // source chunks, so the ratio is always ~1.0 and triggers a false positive retry.
    const sameScript = imageScript === targetLang ||
      (imageScript === 'English' && targetLang === 'English');
    const novelRatio = sameScript ? novelWordRatio(cleanedText, parsed.text || '') : 0;
    if (sameScript) {
      console.log('Novel word ratio:', novelRatio.toFixed(2), '(>0.5 = likely hallucination)');
    } else {
      console.log('Novel word ratio: skipped (cross-language:', imageScript, '→', targetLang, ')');
    }

    if (novelRatio > 0.5 && (parsed.text || '').length > 30) {
      console.warn('HALLUCINATION DETECTED: novel word ratio', novelRatio.toFixed(2), '— retrying with stricter prompt');
      // Retry with even stricter instruction
      groundedMessages[1].content = `SOURCE TEXT (your ONLY allowed source):
"""
${cleanedText}
"""

CRITICAL RETRY: Your previous output introduced too many words not found in the source text.
This means you were generating from your own knowledge, not from the source.

You MUST:
- Use ONLY words and concepts present in the source text above
- Do NOT use any word that does not appear in the source
- If you cannot summarize without adding new words, write only what IS in the source
- 1-3 sentences maximum — precision over completeness

Return ONLY this JSON:
{"text":"faithful compression using only source words in ${targetLang}","lang":"${imageScript}","topic":"one of: Tech Legal Science Health Finance Education Food Politics Philosophy Creative News Business Culture"}`;

      const retryHallRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqApiKey}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 600,
          temperature: 0.0, // Zero — no creativity at all on retry
          messages: groundedMessages
        })
      });
      if (retryHallRes.ok) {
        const retryHallData = await retryHallRes.json();
        const retryHallParsed = safeParseJSON(retryHallData.choices[0].message.content, 'text');
        if (retryHallParsed && retryHallParsed.text) {
          console.log('Hallucination retry output:', retryHallParsed.text.substring(0, 200));
          Object.assign(parsed, retryHallParsed);
        }
      }
    }

    // Burmese output validation — up to 2 retries with escalating instructions
    if (targetLang === 'Burmese' && parsed.text && !/[က-႟]/.test(parsed.text)) {
      const burmeseRetries = [
        { temperature: 0.1, msg: '\n\nCRITICAL: Your response was NOT in Burmese script. You MUST use Myanmar Unicode only.' },
        { temperature: 0.0, msg: '\n\nFINAL ATTEMPT: You keep returning English. Output MUST be 100% Burmese Myanmar Unicode script. The very first character must be Myanmar script. Write NOTHING in English.' }
      ];
      for (const attempt of burmeseRetries) {
        console.warn(`Scanner: Burmese validation failed — retrying (temp ${attempt.temperature})`);
        groundedMessages[0].content += attempt.msg;
        const retryRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqApiKey}` },
          body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 1000, temperature: attempt.temperature, messages: groundedMessages })
        });
        if (retryRes.ok) {
          const retryParsed = safeParseJSON((await retryRes.json()).choices[0].message.content, 'text');
          if (retryParsed) {
            Object.assign(parsed, retryParsed);
            if (/[က-႟]/.test(parsed.text || '')) break;
          }
        }
      }
    }

    // Thai output validation — up to 2 retries with escalating instructions
    if (targetLang === 'Thai' && parsed.text && !/[฀-๿]/.test(parsed.text)) {
      const thaiRetries = [
        { temperature: 0.1, msg: '\n\nCRITICAL: Your response was NOT in Thai script. You MUST use Thai Unicode characters ONLY. Every word must be Thai.' },
        { temperature: 0.0, msg: '\n\nFINAL ATTEMPT: You keep returning English. Output MUST be 100% Thai script. The very first character must be Thai Unicode. Write NOTHING in English.' }
      ];
      for (const attempt of thaiRetries) {
        console.warn(`Scanner: Thai validation failed — retrying (temp ${attempt.temperature})`);
        groundedMessages[0].content += attempt.msg;
        const retryRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqApiKey}` },
          body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 1000, temperature: attempt.temperature, messages: groundedMessages })
        });
        if (retryRes.ok) {
          const retryParsed = safeParseJSON((await retryRes.json()).choices[0].message.content, 'text');
          if (retryParsed) {
            Object.assign(parsed, retryParsed);
            if (/[฀-๿]/.test(parsed.text || '')) break;
          }
        }
      }
    }

    let outputText = parsed.text || parsed.simplified || parsed.summary || '';

    // Apply Burmese spacing normalization — fixes over-segmented syllables from OCR cleanup
    if (targetLang === 'Burmese' && outputText) {
      const beforeFix = outputText;
      outputText = fixBurmeseSpacing(outputText);
      if (beforeFix !== outputText) {
        console.log('STEP 2.5 — Burmese spacing normalized');
      }
    }

    // ✅ Garbage guard: if output looks like numbered list or empty, return an error
    // instead of showing garbage to the user
    if (isGarbageOutput(outputText)) {
      console.error('SCAN: Garbage output detected — returning error instead of showing garbage');
      return res.status(422).json({
        error: 'Could not produce a clean summary from this image. The text may be too noisy or rotated. Try retaking the photo with better lighting and orientation.'
      });
    }

    const topic = parsed.topic || 'Tech';
    const inputLang = parsed.lang || parsed.language || imageScript || 'Unknown';

    const themeMap = {
      'Tech': { bg: '#061420', surface: '#0d1f2d', accent: '#00d4ff' },
      'Legal': { bg: '#0d0d14', surface: '#14141f', accent: '#c8a44a' },
      'Science': { bg: '#061420', surface: '#0a1f2e', accent: '#4dd0e1' },
      'Health': { bg: '#061a0d', surface: '#0d2414', accent: '#4caf50' },
      'Finance': { bg: '#0a0d1a', surface: '#111428', accent: '#7986cb' },
      'Education': { bg: '#0d1014', surface: '#141c24', accent: '#42a5f5' },
      'Food': { bg: '#1a0e00', surface: '#241400', accent: '#ff8f00' },
      'Politics': { bg: '#1a0505', surface: '#240808', accent: '#ef5350' },
      'Philosophy': { bg: '#0d0a1a', surface: '#140f24', accent: '#9c27b0' },
      'Creative': { bg: '#1a0a12', surface: '#240f1a', accent: '#f06292' },
      'News': { bg: '#0a0a0a', surface: '#141414', accent: '#ff7043' },
      'Business': { bg: '#0a1014', surface: '#111820', accent: '#26c6da' },
      'Culture': { bg: '#1a0a0a', surface: '#240f0f', accent: '#ff6b9d' }
    };

    const theme = themeMap[topic] || themeMap['Tech'];

    return res.status(200).json({
      simplified: outputText,
      summary: outputText,
      extracted_text: extractedText,   // Raw OCR output
      cleaned_text: cleanedText,        // After cleanup pass
      image_script: imageScript,        // Detected script of the image
      ocr_has_burmese: hasBurmese,
      ocr_has_thai: hasThai,
      language: inputLang,
      theme: {
        mood: topic,
        bg: theme.bg,
        surface: theme.surface,
        text: '#f0ede8',
        accent: theme.accent,
        muted: 'rgba(240,237,232,0.45)',
        border: 'rgba(255,255,255,0.08)'
      }
    });

  } catch (error) {
    console.error('Scanner error:', error.message);
    return res.status(500).json({ error: error.message || 'Scanner error' });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ClearIt API v2.0 running ✅' });
});

// ✅ STRIPE — Create checkout session (kept but payment gate disabled on frontend)
app.post('/api/create-checkout', async (req, res) => {
  try {
    const { userId, userEmail } = req.body;
    const stripeKey = process.env.STRIPE_SECRET_KEY;

    if (!stripeKey) return res.status(500).json({ error: 'Stripe not configured' });
    if (!userId || !userEmail) return res.status(400).json({ error: 'Missing user info' });

    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        'mode': 'subscription',
        'payment_method_types[]': 'card',
        'line_items[0][price]': 'price_1TXOK2LFYeTifgM8TW6jcTbv',
        'line_items[0][quantity]': '1',
        'customer_email': userEmail,
        'metadata[user_id]': userId,
        'success_url': 'https://chanmyaeso33.github.io/Clearit?payment=success',
        'cancel_url': 'https://chanmyaeso33.github.io/Clearit?payment=cancelled',
      })
    });

    const session = await response.json();
    if (session.error) return res.status(400).json({ error: session.error.message });
    return res.status(200).json({ url: session.url, sessionId: session.id });

  } catch (error) {
    console.error('Stripe error:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// ✅ STRIPE — Check subscription status
app.post('/api/check-subscription', async (req, res) => {
  try {
    const { userEmail } = req.body;
    const stripeKey = process.env.STRIPE_SECRET_KEY;

    if (!stripeKey) return res.status(200).json({ status: 'free' });

    const custRes = await fetch(
      `https://api.stripe.com/v1/customers/search?query=email:'${userEmail}'`,
      { headers: { 'Authorization': `Bearer ${stripeKey}` } }
    );
    const custData = await custRes.json();

    if (!custData.data || !custData.data.length) return res.status(200).json({ status: 'free' });

    const customerId = custData.data[0].id;
    const subRes = await fetch(
      `https://api.stripe.com/v1/subscriptions?customer=${customerId}&status=active`,
      { headers: { 'Authorization': `Bearer ${stripeKey}` } }
    );
    const subData = await subRes.json();

    if (subData.data && subData.data.length > 0) return res.status(200).json({ status: 'pro', customerId });
    return res.status(200).json({ status: 'free' });

  } catch (error) {
    return res.status(200).json({ status: 'free' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ClearIt server v2.0 on port ${PORT}`);
});
