import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import config from '../../config.js'

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${config.storage.accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: config.storage.accessKeyId,
    secretAccessKey: config.storage.secretKey,
  },
})

export default {
  async upload(buffer, filename, mime) {
    await client.send(new PutObjectCommand({
      Bucket: config.storage.bucket,
      Key: filename,
      Body: buffer,
      ContentType: mime,
    }))
    return { url: `${config.storage.publicUrl}/${filename}` }
  },

  async delete(filename) {
    await client.send(new DeleteObjectCommand({
      Bucket: config.storage.bucket,
      Key: filename,
    }))
  },
}
