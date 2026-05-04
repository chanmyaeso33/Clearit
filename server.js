const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.post('/api/simplify', async (req, res) => {
  try {
    const { messages, model } = req.body;
    const groqApiKey = process.env.GROQ_API_KEY;

    if (!groqApiKey) {
      return res.status(500).json({ error: 'API key not configured' });
    }

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqApiKey}`
      },
      body: JSON.stringify({
        model: model || 'llama-3.3-70b-versatile',
        max_tokens: 1000,
        messages: messages
      })
    });

    if (!response.ok) {
      const error = await response.json();
      return res.status(response.status).json({
        error: error.error?.message || 'Groq API error'
      });
    }

    const data = await response.json();
    return res.status(200).json(data);

  } catch (error) {
    return res.status(500).json({ error: error.message || 'Server error' });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ClearIt API is running!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ClearIt server running on port ${PORT}`);
});
