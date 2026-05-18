import config from '../../config.js'

export default {
  async complete(systemPrompt, userContent) {
    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.llm.model || 'llama3',
        system: systemPrompt,
        prompt: userContent,
        stream: false,
      }),
    })
    if (!response.ok) {
      const err = await response.text()
      throw new Error(`Ollama error ${response.status}: ${err}`)
    }
    const data = await response.json()
    return data.response
  },
}
