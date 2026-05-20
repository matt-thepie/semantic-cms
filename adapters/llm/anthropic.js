import config from '../../config.js'

export default {
  async complete(systemPrompt, userContent, { maxTokens = 8192 } = {}) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.llm.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.llm.model || 'claude-sonnet-4-6',
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      }),
    })
    if (!response.ok) {
      const err = await response.text()
      throw new Error(`Anthropic API error ${response.status}: ${err}`)
    }
    const data = await response.json()
    // Signal truncation so callers can reject incomplete output (e.g. a CSS
    // file cut off mid-rule) rather than saving it.
    if (data.stop_reason === 'max_tokens') {
      throw new Error('Response was truncated (hit the token limit). Try a smaller request.')
    }
    return data.content[0].text
  },
}
