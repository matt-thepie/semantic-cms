import config from '../config.js'

const adapterModule = await import(`../adapters/storage/${config.storage.adapter}.js`)
const adapter = adapterModule.default

export async function uploadAsset(buffer, filename, mime) {
  return adapter.upload(buffer, filename, mime)
}

export async function deleteAsset(filename) {
  return adapter.delete(filename)
}
