import { Router } from 'express'
import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const adminDir = path.join(__dirname, '../public/admin')

const router = Router()

router.get('/login', (req, res) => {
  res.sendFile(path.join(adminDir, 'login.html'))
})

router.use((req, res, next) => {
  if (req.session?.admin !== true) return res.redirect('/admin/login')
  next()
})

router.use('/', express.static(adminDir))

export default router
