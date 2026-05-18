import config from '../../config.js'

export default {
  async complete(systemPrompt, userContent) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify({
        model: config.llm.model || 'gpt-4o',
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
    return data.choices[0].message.content
  },
}
