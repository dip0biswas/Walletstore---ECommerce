import { MongoClient } from 'mongodb'

let client
let database
let connectionPromise

export async function getDb() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not configured')
  if (database) return database
  if (!connectionPromise) {
    connectionPromise = (async () => {
      client = new MongoClient(process.env.MONGODB_URI, {
        maxPoolSize: 20,
        minPoolSize: 0,
        maxIdleTimeMS: 300000,
        connectTimeoutMS: 10000,
        serverSelectionTimeoutMS: 5000,
      })
      await client.connect()
      database = client.db(process.env.MONGODB_DB || 'sable_co')
      return database
    })().catch((error) => {
      connectionPromise = undefined
      client = undefined
      database = undefined
      throw error
    })
  }
  await connectionPromise
  return database
}

export async function closeDb() {
  if (client) await client.close()
  client = undefined
  database = undefined
  connectionPromise = undefined
}
