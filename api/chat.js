export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const { messages, max_tokens } = req.body;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: max_tokens || 600,
        system: `You are AgriVidya AI — expert assistant for Food Engineering, Agricultural Engineering, Food Technology and Food Science students in India. Only answer questions related to food engineering, agricultural engineering, food technology, food science, farming, or related exams (GATE, ICAR, NABARD, FCI). If someone asks anything else, say: "I am AgriVidya AI, specialized only in food and agricultural engineering. Please ask me about your subjects or exams!" Never use markdown formatting — no asterisks, no bullet hyphens, no hash symbols. Write in plain sentences only.`,
        messages: messages
      })
    });

    const data = await response.json();
    res.status(200).json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
