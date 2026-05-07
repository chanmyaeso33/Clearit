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
function safeParseJSON(raw) {
  console.log('RAW MODEL OUTPUT:', raw.substring(0, 500));

  try {
    return JSON.parse(cleanJsonString(raw));
  } catch (e1) {
    console.warn('Parse 1 failed:', e1.message);
  }

  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      return JSON.parse(raw.slice(start, end + 1));
    }
  } catch (e2) {
    console.warn('Parse 2 failed:', e2.message);
  }

  try {
    const fieldMatch = raw.match(/"(?:simplified|summary)"\s*:\s*"([\s\S]*?)(?<!\\)"/);
    const langMatch = raw.match(/"language"\s*:\s*"([^"]+)"/);
    const moodMatch = raw.match(/"mood"\s*:\s*"([^"]+)"/);
    const bgMatch = raw.match(/"bg"\s*:\s*"([^"]+)"/);
    const accentMatch = raw.match(/"accent"\s*:\s*"([^"]+)"/);

    if (fieldMatch) {
      return {
        simplified: fieldMatch[1],
        summary: fieldMatch[1],
        language: langMatch ? langMatch[1] : 'Unknown',
        theme: {
          mood: moodMatch ? moodMatch[1] : 'Tech',
          bg: bgMatch ? bgMatch[1] : '#0a0a0f',
          surface: '#13131a',
          text: '#f0ede8',
          accent: accentMatch ? accentMatch[1] : '#c8f050',
          muted: 'rgba(240,237,232,0.45)',
          border: 'rgba(255,255,255,0.08)'
        }
      };
    }
  } catch (e3) {
    console.warn('Parse 3 failed:', e3.message);
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
    const parsed = safeParseJSON(raw);

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

    let { messages, outputLang } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid messages format' });
    }

    const targetLang = outputLang || 'English';

    // ✅ Override system prompt with stronger version on backend
    if (messages[0] && messages[0].role === 'system') {
      messages[0].content = `You are ClearIt.

The required output language is: ${targetLang}

You MUST output ONLY in ${targetLang}.
${targetLang === 'Burmese' ? `
- Use ONLY Burmese Unicode characters (Myanmar script \u1000-\u109F)
- NEVER output English in the simplified or summary field
- Every word in simplified/summary MUST be Burmese` : ''}

Return ONLY valid JSON. No markdown. No backticks. No explanation before or after JSON.`;
    }

    const result = await callModelWithRetry(messages, targetLang);
    if (result && result.error) return res.status(500).json(result);
    return res.status(200).json(result);

  } catch (error) {
    console.error('Server error:', error.message);
    return res.status(500).json({ error: error.message || 'Server error' });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ClearIt API v2.0 running ✅' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ClearIt server v2.0 on port ${PORT}`);
});
