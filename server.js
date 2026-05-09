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

  // Attempt 3 — extract the text value between field name and next field
  // This handles Burmese text that contains quotes or special chars
  try {
    // Find the field value — everything between "fieldName": " and the next ",\n
    const patterns = [
      new RegExp(`"${fieldName}"\\s*:\\s*"([\\s\\S]+?)"\\s*,\\s*"(?:language|theme)"`, 'm'),
      new RegExp(`"${fieldName}"\\s*:\\s*"([\\s\\S]+?)"\\s*}`, 'm'),
      /"(?:simplified|summary)"\s*:\s*"([\s\S]+?)"\s*[,}]/m
    ];

    let textValue = null;
    for (const pattern of patterns) {
      const match = raw.match(pattern);
      if (match && match[1]) { textValue = match[1]; break; }
    }

    const langMatch = raw.match(/"language"\s*:\s*"([^"]{2,50})"/);
    const moodMatch = raw.match(/"mood"\s*:\s*"([^"]{2,30})"/);
    const bgMatch = raw.match(/"bg"\s*:\s*"(#[0-9a-fA-F]{3,8})"/);
    const accentMatch = raw.match(/"accent"\s*:\s*"(#[0-9a-fA-F]{3,8})"/);
    const surfaceMatch = raw.match(/"surface"\s*:\s*"(#[0-9a-fA-F]{3,8})"/);

    if (textValue) {
      console.log('Parse 3 success — extracted text:', textValue.substring(0, 100));
      return {
        [fieldName]: textValue,
        simplified: textValue,
        summary: textValue,
        language: langMatch ? langMatch[1] : 'Unknown',
        theme: {
          mood: moodMatch ? moodMatch[1] : 'Tech',
          bg: bgMatch ? bgMatch[1] : '#0a0a0f',
          surface: surfaceMatch ? surfaceMatch[1] : '#13131a',
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

    let { messages, outputLang } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid messages format' });
    }

    const targetLang = outputLang || 'English';

    // Extract actual input text from the prompt
    const userMsg = messages[1]?.content || messages[0]?.content || '';
    const isSummarize = userMsg.includes('summary') || userMsg.includes('Summarize');
    const fieldName = isSummarize ? 'summary' : 'simplified';

    // Extract the actual input text between triple quotes
    let inputText = '';
    const tripleQuoteMatch = userMsg.match(/"""\s*([\s\S]+?)\s*"""/);
    if (tripleQuoteMatch) {
      inputText = tripleQuoteMatch[1];
    } else {
      // Fallback — use the whole user message
      inputText = userMsg;
    }

    console.log('Extracted input text:', inputText.substring(0, 200));
    console.log('Output lang:', targetLang);
    console.log('Mode:', isSummarize ? 'summarize' : 'simplify');

    // ✅ Completely new approach — ask for SIMPLE response, build theme separately
    const simplifyMessages = [
      {
        role: 'system',
        content: `You are a text simplification assistant.
Output language: ${targetLang}
${targetLang === 'Burmese' ? 'You MUST write ONLY in Burmese script (Myanmar Unicode). No English.' : ''}
Respond ONLY with a JSON object. No markdown. No explanation.`
      },
      {
        role: 'user',
        content: `${isSummarize ? 'Summarize' : 'Simplify'} this text in ${targetLang}:

${inputText}

Return this exact JSON:
{
  "text": "your ${isSummarize ? 'summary' : 'simplified text'} in ${targetLang}",
  "lang": "language of the input text",
  "topic": "one word topic: Tech, Legal, Science, Health, Finance, Education, Food, Politics, Philosophy, Creative, News, Business"
}`
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

    // Parse the simplified response
    const parsed = safeParseJSON(raw, 'text');
    console.log('PARSED:', JSON.stringify(parsed)?.substring(0, 300));

    if (!parsed) {
      return res.status(500).json({ error: 'JSON parse failed', raw });
    }

    // Extract text from either 'text' field or fieldName
    const outputText = parsed.text || parsed[fieldName] || parsed.simplified || parsed.summary || '';
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
      'Business': { bg: '#0a1014', surface: '#111820', accent: '#26c6da' }
    };

    const theme = themeMap[topic] || themeMap['Tech'];

    return res.status(200).json({
      [fieldName]: outputText,
      simplified: outputText,
      summary: outputText,
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

app.get('/', (req, res) => {
  res.json({ status: 'ClearIt API v2.0 running ✅' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ClearIt server v2.0 on port ${PORT}`);
});
