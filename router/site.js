import { Router } from 'express'
import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const siteDir = path.join(__dirname, '../public/site')
const uploadsDir = path.join(__dirname, '../public/uploads')

const router = Router()

// Serve uploaded assets (local storage only)
router.use('/uploads', express.static(uploadsDir))

// Serve site static files (CSS, JS)
router.use('/', express.static(siteDir))

// SPA fallback — all routes return the site shell
router.get('*', (req, res) => {
  res.sendFile(path.join(siteDir, 'index.html'))
})

export default router
