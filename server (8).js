const express = require('express');
const cors = require('cors');

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

// ✅ Burmese Unicode detection
function isBurmese(text) {
  return /[\u1000-\u109F]/.test(text);
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

// ✅ Call model with retry and Burmese validation
async function callModelWithRetry(messages, outputLang, maxRetries = 3) {
  const groqApiKey = process.env.GROQ_API_KEY;
  const model = 'meta-llama/llama-4-scout-17b-16e-instruct';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`Attempt ${attempt}/${maxRetries} | Lang: ${outputLang}`);

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqApiKey}`
      },
      body: JSON.stringify({
        model,
        max_tokens: 1500,
        temperature: 0.3,
        messages
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || `Groq API error ${response.status}`);
    }

    const data = await response.json();
    const raw = data.choices[0].message.content;
    const fieldName = messages[1]?.content?.includes('"summary"') ? 'summary' : 'simplified';
    const parsed = safeParseJSON(raw, fieldName);

    if (!parsed) {
      console.error(`Attempt ${attempt}: JSON parse failed`);
      if (attempt === maxRetries) return { error: 'JSON parse failed', raw };
      continue;
    }

    if (outputLang === 'Burmese') {
      const outputText = parsed.simplified || parsed.summary || '';
      if (!isBurmese(outputText)) {
        console.warn(`Attempt ${attempt}: LANGUAGE FAIL — English returned instead of Burmese`);
        if (attempt === maxRetries) return parsed;
        messages[0].content += `\n\n⚠️ RETRY ${attempt}: Your previous response was in English. WRONG. Output MUST be 100% Burmese Unicode (Myanmar script). No English.`;
        continue;
      }
    }

    console.log(`✅ Success on attempt ${attempt}`);
    return parsed;
  }
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

    if (targetLang === 'Burmese' && outputText && !/[\u1000-\u109F]/.test(outputText)) {
      console.warn('Burmese validation failed — retrying with stronger instruction');
      simplifyMessages[0].content += '\n\nCRITICAL: Previous response was NOT in Burmese script. You MUST use Myanmar Unicode characters ONLY. Every word must be Burmese.';
      const retryRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqApiKey}` },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 2000, temperature: 0.1, messages: simplifyMessages })
      });
      if (retryRes.ok) {
        const retryData = await retryRes.json();
        const retryRaw = retryData.choices[0].message.content;
        const retryParsed = safeParseJSON(retryRaw, 'text');
        if (retryParsed) Object.assign(parsed, retryParsed);
      }
    }

    if (targetLang === 'Thai' && outputText && !/[\u0E00-\u0E7F]/.test(outputText)) {
      console.warn('Thai validation failed — retrying');
      simplifyMessages[0].content += '\n\nCRITICAL: You MUST write in Thai script only. Use Thai Unicode characters.';
      const retryRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqApiKey}` },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 2000, temperature: 0.1, messages: simplifyMessages })
      });
      if (retryRes.ok) {
        const retryData = await retryRes.json();
        const retryRaw = retryData.choices[0].message.content;
        const retryParsed = safeParseJSON(retryRaw, 'text');
        if (retryParsed) Object.assign(parsed, retryParsed);
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

// ✅ Scanner/Vision endpoint — FIXED: proper 2-step extract + simplify with full quality prompt
app.post('/api/scan', async (req, res) => {
  try {
    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey) return res.status(500).json({ error: 'API key not configured' });

    const { imageBase64, outputLang, mode } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

    const targetLang = outputLang || 'English';
    const isSummarize = mode === 'summarize';

    console.log('Scanner — lang:', targetLang, 'mode:', mode);

    const langInstruction = targetLang === 'Burmese'
      ? `You MUST write ONLY in Burmese script (Myanmar Unicode \u1000-\u109F). No English words allowed. Write naturally for educated native Burmese speakers.`
      : targetLang === 'Thai'
      ? `You MUST write ONLY in Thai script. Write naturally for native Thai speakers — not formal academic Thai.`
      : `Write the output in natural, fluent ${targetLang}.`;

    const scanMessages = [
      {
        role: 'system',
        content: `You are a two-step image text extraction and simplification system.
Step 1: Extract all text from the image with full accuracy.
Step 2: ${isSummarize ? 'Summarize' : 'Simplify'} that extracted text exactly as a professional text simplifier would.
${langInstruction}
ALWAYS return ONLY raw JSON on a single line. No markdown. No explanation. No backticks.`
      },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${imageBase64}` }
          },
          {
            type: 'text',
            text: `STEP 1 — READ THE IMAGE:
- Read ALL text visible in the image carefully
- The text may be rotated, sideways or at an angle — read it regardless
- Preserve every word, number, and punctuation you can see
- Identify the language of the text

STEP 2 — ${isSummarize ? 'SUMMARIZE' : 'SIMPLIFY'} IN ${targetLang.toUpperCase()}:
${isSummarize
  ? `- Write a concise summary that captures all key information from the extracted text
- Preserve all important facts, numbers, names, and dates
- Put the most important point first
- Length: 3-5 clear sentences`
  : `- Rewrite the extracted text as plain, clear language that anyone can understand
- Preserve ALL meaning — causal relationships, key facts, technical precision
- Do NOT oversimplify — never sacrifice precision for brevity
- Target audience: educated high school student or general adult reader
- Sound natural and educational — not academic or bureaucratic`}
- Rewrite naturally for native speakers of ${targetLang} — avoid direct translation structure

CRITICAL: The output text quality must match professional text simplification — same accuracy as if the user had typed the text manually.

Return ONLY this JSON with no extra text:
{"text":"your complete ${isSummarize ? 'summary' : 'simplified version'} in ${targetLang}","extracted":"the raw text you read from the image","lang":"detected language of the image text","topic":"one of: Tech Legal Science Health Finance Education Food Politics Philosophy Creative News Business Culture"}`
          }
        ]
      }
    ];

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqApiKey}`
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        max_tokens: 1500,
        temperature: 0.3,
        messages: scanMessages
      })
    });

    if (!groqRes.ok) {
      const error = await groqRes.json();
      return res.status(groqRes.status).json({ error: error.error?.message || 'Groq error' });
    }

    const groqData = await groqRes.json();
    const raw = groqData.choices[0].message.content;
    console.log('Scanner RAW:', raw.substring(0, 500));

    let parsed = safeParseJSON(raw, 'text');

    // If ALL parsing failed, use the raw text directly as the result
    if (!parsed) {
      console.log('All parsing failed — using raw text as fallback');
      const cleanRaw = raw.replace(/```json|```|\{|\}/g, '').trim();
      parsed = {
        text: cleanRaw || 'Could not extract text from image.',
        simplified: cleanRaw || 'Could not extract text from image.',
        summary: cleanRaw || 'Could not extract text from image.',
        language: 'Unknown',
        topic: 'Tech'
      };
    }

    const outputText = parsed.text || parsed.simplified || parsed.summary || '';
    const topic = parsed.topic || 'Tech';
    const inputLang = parsed.lang || parsed.language || 'Unknown';

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
      extracted_text: parsed.extracted || '',
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
