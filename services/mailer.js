import nodemailer from 'nodemailer'
import config from '../config.js'

function createTransport() {
  return nodemailer.createTransport({
    host:   config.smtp.host,
    port:   config.smtp.port,
    secure: config.smtp.port === 465,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.password,
    },
  })
}

export async function sendContactEmail(fields) {
  const transport = createTransport()
  const lines = Object.entries(fields)
    .filter(([k]) => k !== '_honeypot')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')

  await transport.sendMail({
    from:    config.smtp.from,
    to:      config.smtp.to,
    subject: 'New contact form submission',
    text:    lines,
  })
}

export async function sendTestEmail() {
  const transport = createTransport()
  await transport.sendMail({
    from:    config.smtp.from,
    to:      config.smtp.to,
    subject: 'Semantic CMS — SMTP test',
    text:    'If you received this, your SMTP settings are working correctly.',
  })
}
