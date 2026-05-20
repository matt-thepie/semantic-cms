import config from '../../config.js'

export default {
  async complete(systemPrompt, userContent, { maxTokens = 8192 } = {}) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify({
        model: config.llm.model || 'gpt-4o',
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      }),
    })
    if (!response.ok) {
      const err = await response.text()
      throw new Error(`OpenAI API error ${response.status}: ${err}`)
    }
    const data = await response.json()
    if (data.choices[0].finish_reason === 'length') {
      throw new Error('Response was truncated (hit the token limit). Try a smaller request.')
    }
    return data.choices[0].message.content
  },
}
