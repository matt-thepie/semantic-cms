import fs from 'fs'
import path from 'path'

const uploadDir = './public/uploads'

export default {
  async upload(buffer, filename) {
    fs.mkdirSync(uploadDir, { recursive: true })
    fs.writeFileSync(path.join(uploadDir, filename), buffer)
    return { url: `/uploads/${filename}` }
  },

  async delete(filename) {
    const filePath = path.join(uploadDir, filename)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  },
}
