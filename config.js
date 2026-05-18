const config = {
  port:          process.env.PORT || 3000,
  adminPassword: process.env.ADMIN_PASSWORD,
  sessionSecret: process.env.SESSION_SECRET,

  llm: {
    adapter: process.env.LLM_ADAPTER || 'anthropic',
    apiKey:  process.env.LLM_API_KEY,
    model:   process.env.LLM_MODEL,
  },

  storage: {
    adapter:     process.env.STORAGE_ADAPTER || 'local',
    bucket:      process.env.STORAGE_BUCKET,
    accountId:   process.env.STORAGE_ACCOUNT_ID,
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
    secretKey:   process.env.STORAGE_SECRET_KEY,
    publicUrl:   process.env.STORAGE_PUBLIC_URL,
  },

  smtp: {
    host:     process.env.SMTP_HOST,
    port:     parseInt(process.env.SMTP_PORT || '587'),
    user:     process.env.SMTP_USER,
    password: process.env.SMTP_PASSWORD,
    from:     process.env.SMTP_FROM,
    to:       process.env.SMTP_TO,
  },

  db: {
    path: process.env.DB_PATH || './data/cms.db',
  },
}

export default config
