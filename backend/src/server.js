import 'dotenv/config'
import fs from 'node:fs'
import express from 'express'
import cors from 'cors'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { getApps, initializeApp, cert } from 'firebase-admin/app'
import { getAuth as getFirebaseAuth } from 'firebase-admin/auth'
import { ObjectId } from 'mongodb'
import { closeDb, getDb } from './db.js'

const app = express()
const port = Number(process.env.PORT || 4000)
const allowedOrigins = (process.env.FRONTEND_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173').split(',')
app.use(cors({ origin: (origin, callback) => {
  if (!origin || allowedOrigins.includes(origin)) return callback(null, true)
  callback(new Error('Origin is not allowed by CORS'))
} }))
app.use(express.json())

function firebaseAdminAuth() {
  let credentials = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (!credentials && process.env.FIREBASE_SERVICE_ACCOUNT_FILE) credentials = fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_FILE, 'utf8')
  if (!credentials && fs.existsSync(new URL('../firebase-service-account.json', import.meta.url))) credentials = fs.readFileSync(new URL('../firebase-service-account.json', import.meta.url), 'utf8')
  if (!credentials) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_FILE is not configured')
  if (!getApps().length) initializeApp({ credential: cert(JSON.parse(credentials)) })
  return getFirebaseAuth()
}

async function requireFirebaseUser(req, res, next) {
  const header = String(req.headers.authorization || '')
  if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required.' })
  try {
    req.firebaseUser = await firebaseAdminAuth().verifyIdToken(header.slice(7))
    next()
  } catch (error) {
    if (error.message.includes('FIREBASE_SERVICE_ACCOUNT')) {
      console.error('Customer account API is not configured:', error.message)
      return res.status(503).json({ error: 'Customer accounts are not fully configured. Add Firebase Admin credentials to the backend and restart it.' })
    }
    console.error('Firebase token verification failed:', error.message)
    res.status(401).json({ error: 'Your session has expired. Please sign in again.' })
  }
}

function customerProfile(decoded, body = {}) {
  const name = String(body.name || decoded.name || '').trim()
  const [firstName = '', ...lastParts] = name.split(/\s+/)
  return {
    firebaseUid: decoded.uid,
    firstName: String(body.firstName || firstName).trim(),
    lastName: String(body.lastName || lastParts.join(' ')).trim(),
    displayName: name,
    email: decoded.email || '',
    emailVerified: Boolean(decoded.email_verified),
    phone: String(body.phone || '').trim(),
    photoURL: String(body.photoURL || decoded.picture || '').trim(),
    updatedAt: new Date(),
  }
}

async function getCustomer(db, decoded, create = true) {
  const collection = db.collection('customers')
  let customer = await collection.findOne({ firebaseUid: decoded.uid })
  if (!customer && create) {
    const profile = customerProfile(decoded)
    profile.createdAt = new Date()
    await collection.updateOne({ firebaseUid: decoded.uid }, { $setOnInsert: profile }, { upsert: true })
    customer = await collection.findOne({ firebaseUid: decoded.uid })
  }
  return customer
}

async function accountData(req, res, next) {
  try {
    const db = await getDb()
    req.customer = await getCustomer(db, req.firebaseUser)
    if (!req.customer) return res.status(404).json({ error: 'Customer profile not found.' })
    req.db = db
    next()
  } catch (error) { next(error) }
}

app.use('/api/account', requireFirebaseUser, accountData)
app.get('/api/account/overview', async (req, res, next) => {
  try {
    const [orders, unread, wishlist] = await Promise.all([
      req.db.collection('orders').find({ firebaseUid: req.firebaseUser.uid }).sort({ createdAt: -1 }).limit(100).toArray(),
      req.db.collection('notifications').countDocuments({ firebaseUid: req.firebaseUser.uid, read: { $ne: true } }),
      req.db.collection('wishlists').countDocuments({ firebaseUid: req.firebaseUser.uid }),
    ])
    const delivered = orders.filter((order) => order.status === 'delivered').length
    res.json({
      profile: { ...req.customer, _id: undefined },
      stats: { totalOrders: orders.length, pendingOrders: orders.filter((order) => !['delivered', 'cancelled', 'refunded'].includes(order.status)).length, deliveredOrders: delivered, wishlistItems: wishlist, totalSpent: orders.filter((order) => order.status !== 'cancelled').reduce((sum, order) => sum + Number(order.total || 0), 0), unreadNotifications: unread },
      orders: orders.slice(0, 5).map(({ _id, ...order }) => ({ ...order, id: String(_id) })),
    })
  } catch (error) { next(error) }
})
app.get('/api/account/profile', (req, res) => res.json({ profile: req.customer }))
app.patch('/api/account/profile', async (req, res, next) => {
  try {
    const update = customerProfile(req.firebaseUser, req.body)
    delete update.firebaseUid
    delete update.email
    await req.db.collection('customers').updateOne({ firebaseUid: req.firebaseUser.uid }, { $set: update })
    res.json({ profile: { ...req.customer, ...update } })
  } catch (error) { next(error) }
})
app.get('/api/account/orders', async (req, res, next) => {
  try {
    const query = { firebaseUid: req.firebaseUser.uid }
    if (req.query.search) query.orderNumber = { $regex: String(req.query.search), $options: 'i' }
    if (req.query.status && req.query.status !== 'all') query.status = req.query.status
    const orders = await req.db.collection('orders').find(query).sort({ createdAt: -1 }).toArray()
    res.json({ orders: orders.map(({ _id, ...order }) => ({ ...order, id: String(_id) })) })
  } catch (error) { next(error) }
})
app.get('/api/account/orders/:orderId', async (req, res, next) => {
  try {
    const query = { firebaseUid: req.firebaseUser.uid, $or: [{ orderNumber: req.params.orderId }] }
    if (ObjectId.isValid(req.params.orderId)) query.$or.push({ _id: new ObjectId(req.params.orderId) })
    const order = await req.db.collection('orders').findOne(query)
    if (!order) return res.status(404).json({ error: 'Order not found.' })
    const { _id, ...safeOrder } = order
    res.json({ order: { ...safeOrder, id: String(_id) } })
  } catch (error) { next(error) }
})
app.get('/api/account/wishlist', async (req, res, next) => {
  try { res.json({ products: await req.db.collection('wishlists').find({ firebaseUid: req.firebaseUser.uid }).sort({ createdAt: -1 }).toArray() }) } catch (error) { next(error) }
})
app.put('/api/account/wishlist/:productId', async (req, res, next) => {
  try {
    const product = { ...req.body, productId: req.params.productId, firebaseUid: req.firebaseUser.uid, createdAt: new Date() }
    await req.db.collection('wishlists').updateOne({ firebaseUid: req.firebaseUser.uid, productId: req.params.productId }, { $set: product }, { upsert: true })
    res.status(201).json({ product })
  } catch (error) { next(error) }
})
app.delete('/api/account/wishlist/:productId', async (req, res, next) => {
  try { await req.db.collection('wishlists').deleteOne({ firebaseUid: req.firebaseUser.uid, productId: req.params.productId }); res.status(204).end() } catch (error) { next(error) }
})
app.get('/api/account/addresses', async (req, res, next) => {
  try { res.json({ addresses: req.customer.addresses || [] }) } catch (error) { next(error) }
})
app.put('/api/account/addresses', async (req, res, next) => {
  try {
    const address = { id: req.body.id || `address-${Date.now()}`, fullName: String(req.body.fullName || '').trim(), phone: String(req.body.phone || '').trim(), line1: String(req.body.line1 || '').trim(), line2: String(req.body.line2 || '').trim(), area: String(req.body.area || '').trim(), city: String(req.body.city || '').trim(), division: String(req.body.division || '').trim(), postalCode: String(req.body.postalCode || '').trim(), country: String(req.body.country || '').trim(), isDefault: Boolean(req.body.isDefault) }
    if (!address.fullName || !address.line1 || !address.city || !address.postalCode || !address.country) return res.status(400).json({ error: 'Name, address, city, postal code, and country are required.' })
    const addresses = (req.customer.addresses || []).filter((item) => item.id !== address.id).map((item) => ({ ...item, isDefault: address.isDefault ? false : item.isDefault }))
    if (!addresses.length || address.isDefault) address.isDefault = true
    addresses.push(address)
    await req.db.collection('customers').updateOne({ firebaseUid: req.firebaseUser.uid }, { $set: { addresses, updatedAt: new Date() } })
    res.json({ addresses })
  } catch (error) { next(error) }
})
app.delete('/api/account/addresses/:addressId', async (req, res, next) => {
  try { const addresses = (req.customer.addresses || []).filter((item) => item.id !== req.params.addressId); await req.db.collection('customers').updateOne({ firebaseUid: req.firebaseUser.uid }, { $set: { addresses } }); res.json({ addresses }) } catch (error) { next(error) }
})
app.get('/api/account/notifications', async (req, res, next) => {
  try { res.json({ notifications: await req.db.collection('notifications').find({ firebaseUid: req.firebaseUser.uid }).sort({ createdAt: -1 }).limit(100).toArray() }) } catch (error) { next(error) }
})
app.patch('/api/account/notifications/read', async (req, res, next) => {
  try { await req.db.collection('notifications').updateMany({ firebaseUid: req.firebaseUser.uid, ...(req.body.id ? { _id: new ObjectId(req.body.id) } : {}) }, { $set: { read: true } }); res.json({ ok: true }) } catch (error) { next(error) }
})
app.get('/api/account/reviews', async (req, res, next) => {
  try { res.json({ reviews: await req.db.collection('reviews').find({ firebaseUid: req.firebaseUser.uid }).sort({ createdAt: -1 }).toArray() }) } catch (error) { next(error) }
})
app.delete('/api/account/reviews/:reviewId', async (req, res, next) => {
  try { await req.db.collection('reviews').deleteOne({ _id: new ObjectId(req.params.reviewId), firebaseUid: req.firebaseUser.uid }); res.status(204).end() } catch (error) { next(error) }
})
app.put('/api/account/recently-viewed', async (req, res, next) => {
  try { await req.db.collection('recentlyViewed').updateOne({ firebaseUid: req.firebaseUser.uid, productId: req.body.productId }, { $set: { ...req.body, firebaseUid: req.firebaseUser.uid, viewedAt: new Date() } }, { upsert: true }); res.status(204).end() } catch (error) { next(error) }
})
app.get('/api/account/recently-viewed', async (req, res, next) => {
  try { res.json({ products: await req.db.collection('recentlyViewed').find({ firebaseUid: req.firebaseUser.uid }).sort({ viewedAt: -1 }).limit(20).toArray() }) } catch (error) { next(error) }
})
app.delete('/api/account/recently-viewed', async (req, res, next) => {
  try { await req.db.collection('recentlyViewed').deleteMany({ firebaseUid: req.firebaseUser.uid }); res.status(204).end() } catch (error) { next(error) }
})

const products = [
  { slug: 'classic-billfold', name: 'The Classic Billfold', category: "Men's Wallets", price: 89 },
  { slug: 'luna-card-holder', name: 'Luna Card Holder', category: "Women's Wallets", price: 54 },
  { slug: 'traveler', name: 'The Traveler', category: 'Premium Collection', price: 120 },
  { slug: 'mini-zip', name: 'Mini Zip Wallet', category: "Women's Wallets", price: 68 },
  { slug: 'essential-card', name: 'Essential Card Case', category: 'Card Holders', price: 42 },
  { slug: 'heritage-wallet', name: 'Heritage Long Wallet', category: "Men's Wallets", price: 145 },
]

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'sable-co-api' }))
app.get('/api/products', async (req, res, next) => {
  try {
    const category = String(req.query.category || '')
    const stored = await (await getDb()).collection('products').find({}).sort({ createdAt: -1 }).toArray()
    const source = stored.length ? stored.map(({ _id, ...product }) => ({ ...product, id: String(_id), slug: product.slug || product.id || String(_id), colors: product.colors || ['Cognac'], specs: product.specs || [] })) : products
    res.json(category && category !== 'All Wallets' ? source.filter((product) => product.category === category || (category === 'Sale' && product.oldPrice)) : source)
  } catch (error) { next(error) }
})
app.get('/api/store/settings', async (_req, res, next) => {
  try {
    const record = await (await getDb()).collection('settings').findOne({ key: 'store-settings' })
    if (!record) return res.json({ settings: null })
    const { _id, key, ...settings } = record
    res.json({ settings })
  } catch (error) { next(error) }
})
app.get('/api/store/categories', async (_req, res, next) => {
  try {
    const records = await (await getDb()).collection('categories').find({ active: { $ne: false } }).sort({ name: 1 }).toArray()
    res.json({ categories: records.map(({ _id, ...category }) => ({ ...category, id: String(_id) })) })
  } catch (error) { next(error) }
})
app.get('/api/store/homepage', async (_req, res, next) => {
  try {
    const sections = await (await getDb()).collection('homepage').find({ enabled: { $ne: false } }).sort({ order: 1, createdAt: 1 }).toArray()
    res.json({ sections: sections.map(({ _id, ...section }) => ({ ...section, id: String(_id) })) })
  } catch (error) { next(error) }
})
app.post('/api/store/coupons/validate', async (req, res, next) => {
  try {
    const code = String(req.body.code || '').trim().toUpperCase()
    const subtotal = Number(req.body.subtotal)
    if (!code || !Number.isFinite(subtotal) || subtotal < 0) return res.status(400).json({ error: 'Enter a valid coupon code and subtotal.' })
    const coupon = await (await getDb()).collection('coupons').findOne({ code, enabled: { $ne: false } })
    if (!coupon) return res.status(404).json({ error: 'Coupon not found.' })
    const now = Date.now()
    if (new Date(coupon.startDate).getTime() > now || new Date(coupon.expiryDate).getTime() <= now) return res.status(400).json({ error: 'This coupon is not currently active.' })
    if (coupon.usageLimit !== null && Number(coupon.usedCount || 0) >= Number(coupon.usageLimit)) return res.status(400).json({ error: 'This coupon has reached its usage limit.' })
    if (subtotal < Number(coupon.minimumOrderAmount || 0)) return res.status(400).json({ error: `This coupon requires a minimum order of ${coupon.minimumOrderAmount}.` })
    const rawDiscount = coupon.discountType === 'percentage' ? subtotal * Number(coupon.discountValue) / 100 : Number(coupon.discountValue)
    const discount = Math.min(rawDiscount, Number(coupon.maximumDiscount || rawDiscount), subtotal)
    res.json({ coupon: { code: coupon.code, discountType: coupon.discountType, discountValue: coupon.discountValue }, discount, subtotal, total: subtotal - discount })
  } catch (error) { next(error) }
})
function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Valid admin key required.' })
  next()
}
async function requireAdminFirebase(req, res, next) {
  try {
    const header = String(req.headers.authorization || '')
    if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Firebase authentication required.' })
    req.firebaseUser = await firebaseAdminAuth().verifyIdToken(header.slice(7))
    next()
  } catch (error) {
    console.error('Admin Firebase verification failed:', error.message)
    if (error.message.includes('FIREBASE_SERVICE_ACCOUNT')) {
      return res.status(503).json({ error: 'Firebase Admin is not configured. Add the service-account JSON to backend/.env or backend/firebase-service-account.json, then restart the API.' })
    }
    res.status(401).json({ error: 'Your admin session has expired. Please sign in again.' })
  }
}
app.get('/api/admin/overview', requireAdmin, async (_req, res, next) => {
  try {
    const db = await getDb()
    const [storedProducts, orders, customers] = await Promise.all([
      db.collection('products').find({}).sort({ createdAt: -1 }).toArray(),
      db.collection('orders').find({}).sort({ createdAt: -1 }).limit(100).toArray(),
      db.collection('customers').countDocuments(),
    ])
    res.json({
      products: storedProducts.map(({ _id, ...product }) => ({ ...product, id: String(_id) })),
      orders: orders.map(({ _id, ...order }) => ({ ...order, id: String(_id) })),
      customers,
      revenue: orders.reduce((total, order) => total + Number(order.total || 0), 0),
    })
    app.get('/api/admin/customers', requireAdmin, async (req, res, next) => {
      try {
        const db = await getDb()
        const search = String(req.query.search || '').trim()
        const page = Math.max(1, Number(req.query.page || 1))
        const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20)))
        const filter = search ? { $or: [{ email: { $regex: search, $options: 'i' } }, { displayName: { $regex: search, $options: 'i' } }, { firstName: { $regex: search, $options: 'i' } }, { lastName: { $regex: search, $options: 'i' } }] } : {}
        const [customers, total] = await Promise.all([db.collection('customers').find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(), db.collection('customers').countDocuments(filter)])
        const ids = customers.map((customer) => customer.firebaseUid).filter(Boolean)
        const orders = await db.collection('orders').find({ firebaseUid: { $in: ids } }).sort({ createdAt: -1 }).toArray()
        const result = customers.map(({ _id, ...customer }) => {
          const customerOrders = orders.filter((order) => order.firebaseUid === customer.firebaseUid)
          return { ...customer, id: String(_id), totalOrders: customerOrders.length, totalSpent: customerOrders.filter((order) => order.status !== 'cancelled').reduce((sum, order) => sum + Number(order.total || 0), 0), lastOrder: customerOrders[0]?.createdAt || null, status: customer.status || 'active' }
        })
        res.json({ customers: result, page, limit, total, pages: Math.ceil(total / limit) })
      } catch (error) { next(error) }
    })
    app.get('/api/admin/reviews', requireAdmin, async (req, res, next) => {
      try {
        const filter = {}
        if (req.query.status) filter.status = String(req.query.status)
        if (req.query.rating) filter.rating = Number(req.query.rating)
        const reviews = await (await getDb()).collection('reviews').find(filter).sort({ createdAt: -1 }).limit(200).toArray()
        res.json({ reviews: reviews.map(({ _id, ...review }) => ({ ...review, id: String(_id), status: review.status || 'pending', featured: Boolean(review.featured) })) })
      } catch (error) { next(error) }
    })
    app.patch('/api/admin/reviews/:id', requireAdmin, async (req, res, next) => {
      try {
        if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid review id.' })
        const update = {}
        if (['pending', 'approved', 'rejected'].includes(req.body.status)) update.status = req.body.status
        if (typeof req.body.featured === 'boolean') update.featured = req.body.featured
        update.updatedAt = new Date()
        const result = await (await getDb()).collection('reviews').findOneAndUpdate({ _id: new ObjectId(req.params.id) }, { $set: update }, { returnDocument: 'after' })
        if (!result) return res.status(404).json({ error: 'Review not found.' })
        const { _id, ...review } = result
        res.json({ ...review, id: String(_id) })
      } catch (error) { next(error) }
    })
    app.delete('/api/admin/reviews/:id', requireAdmin, async (req, res, next) => {
      try {
        if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid review id.' })
        const result = await (await getDb()).collection('reviews').deleteOne({ _id: new ObjectId(req.params.id) })
        if (!result.deletedCount) return res.status(404).json({ error: 'Review not found.' })
        res.status(204).end()
      } catch (error) { next(error) }
    })
    app.get('/api/admin/analytics', requireAdmin, async (req, res, next) => {
      try {
        const db = await getDb()
        const days = Math.min(365, Math.max(1, Number(req.query.days || 30)))
        const since = new Date(Date.now() - days * 86400000)
        const [orders, customers, products] = await Promise.all([db.collection('orders').find({ createdAt: { $gte: since } }).sort({ createdAt: 1 }).toArray(), db.collection('customers').countDocuments(), db.collection('products').find({}).toArray()])
        const byDay = {}
        const bestSelling = {}
        orders.forEach((order) => { const day = new Date(order.createdAt).toISOString().slice(0, 10); byDay[day] = byDay[day] || { date: day, revenue: 0, orders: 0 }; byDay[day].revenue += Number(order.total || 0); byDay[day].orders += 1; (order.items || []).forEach((item) => { const name = item.name || item.productName || item.slug || 'Unknown product'; bestSelling[name] = (bestSelling[name] || 0) + Number(item.quantity || 1) }) })
        res.json({ days, totalRevenue: orders.reduce((sum, order) => sum + Number(order.total || 0), 0), totalOrders: orders.length, totalCustomers: customers, averageOrderValue: orders.length ? orders.reduce((sum, order) => sum + Number(order.total || 0), 0) / orders.length : 0, series: Object.values(byDay), bestSelling: Object.entries(bestSelling).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, quantity]) => ({ name, quantity })), productCount: products.length })
      } catch (error) { next(error) }
    })
  } catch (error) { next(error) }
})
const adminResources = {
  Customers: { collection: 'customers', writable: false },
  Reviews: { collection: 'reviews', writable: true },
  Coupons: { collection: 'coupons', writable: true },
  Homepage: { collection: 'homepage', writable: true },
  Categories: { collection: 'categories', writable: true },
  Payments: { collection: 'payments', writable: false },
  Notifications: { collection: 'notifications', writable: true },
  Settings: { collection: 'settings', writable: true },
  'Admin Profile': { collection: 'adminProfile', writable: true },
}
const defaultPermissions = Object.fromEntries(['Dashboard', 'Products', 'Orders', 'Customers', 'Reviews', 'Coupons', 'Homepage', 'Categories', 'Payments', 'Analytics', 'Notifications', 'Settings'].map((name) => [name, { view: true, create: true, edit: true, delete: true }]))
app.get('/api/admin/profile', requireAdmin, requireAdminFirebase, async (req, res, next) => {
  try {
    const db = await getDb()
    const now = new Date()
    const collection = db.collection('adminProfiles')
    let profile = await collection.findOne({ firebaseUid: req.firebaseUser.uid })
    if (!profile) {
      profile = { firebaseUid: req.firebaseUser.uid, adminId: `ADM-${req.firebaseUser.uid.slice(0, 8).toUpperCase()}`, fullName: req.firebaseUser.name || '', email: req.firebaseUser.email || '', phone: '', photoURL: req.firebaseUser.picture || '', role: 'Super Admin', status: 'Active', permissions: defaultPermissions, preferences: { emailNotifications: true, securityAlerts: true, orderAlerts: true, marketing: false }, createdAt: now, updatedAt: now, lastLoginAt: now }
      await collection.insertOne(profile)
    } else {
      await collection.updateOne({ _id: profile._id }, { $set: { email: req.firebaseUser.email || profile.email, lastLoginAt: now, updatedAt: now } })
      profile = { ...profile, email: req.firebaseUser.email || profile.email, lastLoginAt: now }
    }
    await db.collection('adminActivity').insertOne({ firebaseUid: req.firebaseUser.uid, action: 'Admin profile accessed', actorEmail: req.firebaseUser.email || '', createdAt: now })
    const activities = await db.collection('adminActivity').find({ firebaseUid: req.firebaseUser.uid }).sort({ createdAt: -1 }).limit(12).toArray()
    const { _id, ...safeProfile } = profile
    res.json({ profile: safeProfile, activities: activities.map(({ _id: activityId, ...activity }) => ({ ...activity, id: String(activityId) })) })
  } catch (error) { next(error) }
})
app.patch('/api/admin/profile', requireAdmin, requireAdminFirebase, async (req, res, next) => {
  try {
    const allowed = ['fullName', 'phone', 'photoURL', 'preferences', 'permissions']
    const update = Object.fromEntries(Object.entries(req.body).filter(([key]) => allowed.includes(key)))
    update.updatedAt = new Date()
    const db = await getDb()
    const result = await db.collection('adminProfiles').findOneAndUpdate({ firebaseUid: req.firebaseUser.uid }, { $set: update }, { upsert: true, returnDocument: 'after' })
    await db.collection('adminActivity').insertOne({ firebaseUid: req.firebaseUser.uid, action: 'Admin profile updated', actorEmail: req.firebaseUser.email || '', createdAt: new Date() })
    const { _id, ...profile } = result
    res.json({ profile })
  } catch (error) { next(error) }
})
app.get('/api/admin/admins', requireAdmin, requireAdminFirebase, async (_req, res, next) => {
  try {
    const admins = await (await getDb()).collection('adminProfiles').find({}).sort({ createdAt: 1 }).toArray()
    res.json({ admins: admins.map(({ _id, firebaseUid, ...admin }) => ({ ...admin, id: String(_id), firebaseUid })) })
  } catch (error) { next(error) }
})
app.post('/api/admin/admins', requireAdmin, requireAdminFirebase, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase()
    const fullName = String(req.body.fullName || '').trim()
    if (!email || !fullName) return res.status(400).json({ error: 'Full name and email are required.' })
    const firebase = firebaseAdminAuth()
    const user = await firebase.createUser({ email, displayName: fullName, emailVerified: false, disabled: false })
    const now = new Date()
    const profile = { firebaseUid: user.uid, adminId: `ADM-${user.uid.slice(0, 8).toUpperCase()}`, fullName, email, phone: '', photoURL: '', role: 'Super Admin', status: 'Active', permissions: defaultPermissions, preferences: { emailNotifications: true, securityAlerts: true, orderAlerts: true, marketing: false }, createdAt: now, updatedAt: now, lastLoginAt: null }
    const db = await getDb()
    await db.collection('adminProfiles').insertOne(profile)
    await db.collection('adminActivity').insertOne({ firebaseUid: req.firebaseUser.uid, action: `Added administrator ${email}`, actorEmail: req.firebaseUser.email || '', createdAt: now })
    const invitationLink = await firebase.generatePasswordResetLink(email)
    res.status(201).json({ admin: { ...profile, id: user.uid }, invitationLink })
  } catch (error) {
    if (error.code === 'auth/email-already-exists') return res.status(409).json({ error: 'A Firebase account already exists for this email.' })
    next(error)
  }
})
app.get('/api/admin/resources/:resource', requireAdmin, async (req, res, next) => {
  try {
    const resource = adminResources[req.params.resource]
    if (!resource) return res.status(404).json({ error: 'Unsupported admin resource.' })
    const documents = await (await getDb()).collection(resource.collection).find({}).sort({ updatedAt: -1, createdAt: -1 }).limit(200).toArray()
    res.json({ writable: resource.writable, documents: documents.map(({ _id, ...document }) => ({ ...document, id: String(_id) })) })
  } catch (error) { next(error) }
})
app.post('/api/admin/resources/:resource', requireAdmin, async (req, res, next) => {
  try {
    const resource = adminResources[req.params.resource]
    if (!resource?.writable) return res.status(403).json({ error: 'This resource is read-only.' })
    const document = { ...req.body, createdAt: new Date(), updatedAt: new Date() }
    const result = await (await getDb()).collection(resource.collection).insertOne(document)
    res.status(201).json({ ...document, id: String(result.insertedId) })
  } catch (error) { next(error) }
})
app.patch('/api/admin/resources/:resource/:id', requireAdmin, async (req, res, next) => {
  try {
    const resource = adminResources[req.params.resource]
    if (!resource?.writable || !ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid or read-only admin resource.' })
    const update = { ...req.body, updatedAt: new Date() }
    delete update.id
    const result = await (await getDb()).collection(resource.collection).findOneAndUpdate({ _id: new ObjectId(req.params.id) }, { $set: update }, { returnDocument: 'after' })
    if (!result) return res.status(404).json({ error: 'Record not found.' })
    const { _id, ...document } = result
    res.json({ ...document, id: String(_id) })
  } catch (error) { next(error) }
})
app.delete('/api/admin/resources/:resource/:id', requireAdmin, async (req, res, next) => {
  try {
    const resource = adminResources[req.params.resource]
    if (!resource?.writable || !ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid or read-only admin resource.' })
    const result = await (await getDb()).collection(resource.collection).deleteOne({ _id: new ObjectId(req.params.id) })
    if (!result.deletedCount) return res.status(404).json({ error: 'Record not found.' })
    res.status(204).end()
  } catch (error) { next(error) }
})
function couponDocument(body, existing = {}) {
  const code = String(body.code ?? existing.code ?? '').trim().toUpperCase()
  const discountType = String(body.discountType ?? existing.discountType ?? '').toLowerCase()
  const discountValue = Number(body.discountValue ?? existing.discountValue)
  const minimumOrderAmount = Number(body.minimumOrderAmount ?? existing.minimumOrderAmount ?? 0)
  const maximumDiscount = body.maximumDiscount === '' || body.maximumDiscount === null ? null : Number(body.maximumDiscount ?? existing.maximumDiscount)
  const startDate = new Date(body.startDate ?? existing.startDate)
  const expiryDate = new Date(body.expiryDate ?? existing.expiryDate)
  const usageLimit = body.usageLimit === '' || body.usageLimit === null ? null : Number(body.usageLimit ?? existing.usageLimit)
  const usedCount = Number(existing.usedCount || body.usedCount || 0)
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) throw new Error('Coupon code must be 3-32 letters, numbers, underscores, or hyphens.')
  if (!['percentage', 'fixed'].includes(discountType)) throw new Error('Choose percentage or fixed amount discount.')
  if (!Number.isFinite(discountValue) || discountValue <= 0 || (discountType === 'percentage' && discountValue > 100)) throw new Error('Enter a valid discount value.')
  if (!Number.isFinite(minimumOrderAmount) || minimumOrderAmount < 0) throw new Error('Minimum order amount cannot be negative.')
  if (maximumDiscount !== null && (!Number.isFinite(maximumDiscount) || maximumDiscount < 0)) throw new Error('Maximum discount cannot be negative.')
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(expiryDate.getTime()) || expiryDate <= startDate) throw new Error('Expiry date must be after the start date.')
  if (usageLimit !== null && (!Number.isInteger(usageLimit) || usageLimit < 1 || usageLimit < usedCount)) throw new Error('Usage limit must be a whole number greater than used count.')
  return { code, discountType, discountValue, minimumOrderAmount, maximumDiscount, startDate, expiryDate, usageLimit, usedCount, enabled: body.enabled === undefined ? existing.enabled !== false : Boolean(body.enabled), updatedAt: new Date() }
}
function couponStatus(coupon) {
  if (coupon.enabled === false) return 'Disabled'
  const now = Date.now()
  if (new Date(coupon.expiryDate).getTime() <= now) return 'Expired'
  if (new Date(coupon.startDate).getTime() > now) return 'Scheduled'
  if (coupon.usageLimit !== null && Number(coupon.usedCount || 0) >= Number(coupon.usageLimit)) return 'Expired'
  return 'Active'
}
app.get('/api/admin/coupons', requireAdmin, async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1))
    const limit = Math.min(50, Math.max(1, Number(req.query.limit || 10)))
    const filter = {}
    const search = String(req.query.search || '').trim()
    if (search) filter.code = { $regex: search, $options: 'i' }
    const documents = await (await getDb()).collection('coupons').find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray()
    const total = await (await getDb()).collection('coupons').countDocuments(filter)
    let coupons = documents.map(({ _id, ...coupon }) => ({ ...coupon, id: String(_id), status: couponStatus(coupon) }))
    if (req.query.status && req.query.status !== 'all') coupons = coupons.filter((coupon) => coupon.status.toLowerCase() === String(req.query.status).toLowerCase())
    res.json({ coupons, page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) })
  } catch (error) { next(error) }
})
app.post('/api/admin/coupons', requireAdmin, async (req, res, next) => {
  try {
    const db = await getDb()
    const document = couponDocument(req.body)
    if (await db.collection('coupons').findOne({ code: document.code })) return res.status(409).json({ error: 'A coupon with this code already exists.' })
    document.createdAt = new Date()
    const result = await db.collection('coupons').insertOne(document)
    res.status(201).json({ ...document, id: String(result.insertedId), status: couponStatus(document) })
  } catch (error) {
    if (error.message.includes('Coupon') || error.message.includes('discount') || error.message.includes('amount') || error.message.includes('date') || error.message.includes('limit')) return res.status(400).json({ error: error.message })
    next(error)
  }
})
app.patch('/api/admin/coupons/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid coupon id.' })
    const db = await getDb()
    const current = await db.collection('coupons').findOne({ _id: new ObjectId(req.params.id) })
    if (!current) return res.status(404).json({ error: 'Coupon not found.' })
    const document = couponDocument(req.body, current)
    const duplicate = await db.collection('coupons').findOne({ code: document.code, _id: { $ne: current._id } })
    if (duplicate) return res.status(409).json({ error: 'A coupon with this code already exists.' })
    const result = await db.collection('coupons').findOneAndUpdate({ _id: current._id }, { $set: document }, { returnDocument: 'after' })
    const { _id, ...coupon } = result
    res.json({ ...coupon, id: String(_id), status: couponStatus(coupon) })
  } catch (error) {
    if (error.message.includes('Coupon') || error.message.includes('discount') || error.message.includes('amount') || error.message.includes('date') || error.message.includes('limit')) return res.status(400).json({ error: error.message })
    next(error)
  }
})
app.delete('/api/admin/coupons/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid coupon id.' })
    const result = await (await getDb()).collection('coupons').deleteOne({ _id: new ObjectId(req.params.id) })
    if (!result.deletedCount) return res.status(404).json({ error: 'Coupon not found.' })
    res.status(204).end()
  } catch (error) { next(error) }
})
const settingsSections = ['store', 'shipping', 'tax', 'orders', 'notifications', 'social', 'system']
const settingsShape = {
  store: { storeName: '', logo: '', contactEmail: '', phone: '', address: '', currency: 'USD' },
  shipping: { methods: [], charges: 0, freeShippingThreshold: 0 },
  tax: { percentage: 0, enabled: false },
  orders: { allowedStatuses: [], cancellationEnabled: true, returnsEnabled: true, refundPolicy: '' },
  notifications: { emailNotifications: true, orderNotifications: true, lowStockAlerts: false },
  social: { facebook: '', instagram: '', youtube: '', other: '' },
  system: { maintenanceMode: false },
}
function validateSettings(body) {
  const value = {}
  for (const section of settingsSections) {
    if (body[section] === undefined) continue
    if (!body[section] || typeof body[section] !== 'object' || Array.isArray(body[section])) throw new Error(`Invalid ${section} settings.`)
    value[section] = { ...settingsShape[section], ...body[section] }
  }
  if (value.store?.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.store.contactEmail)) throw new Error('Enter a valid contact email.')
  if (value.tax && (Number(value.tax.percentage) < 0 || Number(value.tax.percentage) > 100)) throw new Error('Tax percentage must be between 0 and 100.')
  for (const key of ['shipping']) if (value[key] && Number(value[key].charges) < 0) throw new Error('Shipping charges cannot be negative.')
  return value
}
app.get('/api/admin/settings', requireAdmin, async (_req, res, next) => {
  try {
    const record = await (await getDb()).collection('settings').findOne({ key: 'store-settings' })
    if (!record) return res.json({ settings: null })
    const { _id, key, ...settings } = record
    res.json({ settings })
  } catch (error) { next(error) }
})
app.patch('/api/admin/settings', requireAdmin, async (req, res, next) => {
  try {
    const updates = validateSettings(req.body)
    const now = new Date()
    const result = await (await getDb()).collection('settings').findOneAndUpdate(
      { key: 'store-settings' },
      { $set: { ...updates, updatedAt: now }, $setOnInsert: { key: 'store-settings', createdAt: now } },
      { upsert: true, returnDocument: 'after' },
    )
    const { _id, key, ...settings } = result
    res.json({ settings, updatedAt: settings.updatedAt })
  } catch (error) {
    if (error.message.startsWith('Invalid ') || error.message.includes('percentage') || error.message.includes('charges') || error.message.includes('email')) return res.status(400).json({ error: error.message })
    next(error)
  }
})
const adminNotificationTypes = ['new-order', 'low-stock', 'failed-payment', 'new-review', 'new-customer', 'system']
app.get('/api/admin/notifications', requireAdmin, async (req, res, next) => {
  try {
    const filter = {}
    if (req.query.type && adminNotificationTypes.includes(String(req.query.type))) filter.type = String(req.query.type)
    if (req.query.read === 'read') filter.read = true
    if (req.query.read === 'unread') filter.read = { $ne: true }
    const collection = (await getDb()).collection('notifications')
    const [documents, unread] = await Promise.all([
      collection.find(filter).sort({ createdAt: -1, date: -1 }).limit(200).toArray(),
      collection.countDocuments({ read: { $ne: true } }),
    ])
    res.json({ unread, notifications: documents.map(({ _id, ...document }) => ({ ...document, id: String(_id), read: Boolean(document.read), createdAt: document.createdAt || document.date || null })) })
  } catch (error) { next(error) }
})
app.patch('/api/admin/notifications/:id/read', requireAdmin, async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid notification id.' })
    const result = await (await getDb()).collection('notifications').findOneAndUpdate({ _id: new ObjectId(req.params.id) }, { $set: { read: true, readAt: new Date(), updatedAt: new Date() } }, { returnDocument: 'after' })
    if (!result) return res.status(404).json({ error: 'Notification not found.' })
    const { _id, ...notification } = result
    res.json({ ...notification, id: String(_id), read: true })
  } catch (error) { next(error) }
})
app.post('/api/admin/notifications/read-all', requireAdmin, async (_req, res, next) => {
  try {
    const result = await (await getDb()).collection('notifications').updateMany({ read: { $ne: true } }, { $set: { read: true, readAt: new Date(), updatedAt: new Date() } })
    res.json({ updated: result.modifiedCount })
  } catch (error) { next(error) }
})
app.delete('/api/admin/notifications/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid notification id.' })
    const result = await (await getDb()).collection('notifications').deleteOne({ _id: new ObjectId(req.params.id) })
    if (!result.deletedCount) return res.status(404).json({ error: 'Notification not found.' })
    res.status(204).end()
  } catch (error) { next(error) }
})
app.post('/api/admin/products', requireAdmin, async (req, res, next) => {
  try {
    const { name, slug, category, price, image } = req.body
    if (!name || !slug || !category || !Number.isFinite(Number(price))) return res.status(400).json({ error: 'Name, slug, category, and a valid price are required.' })
    const db = await getDb()
    const product = { name: String(name).trim(), slug: String(slug).trim(), category: String(category).trim(), price: Number(price), image: image || '', inventory: Number(req.body.inventory || 0), updatedAt: new Date(), createdAt: new Date() }
    const result = await db.collection('products').insertOne(product)
    res.status(201).json({ ...product, id: String(result.insertedId) })
  } catch (error) { next(error) }
})
app.patch('/api/admin/products/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid product id.' })
    const allowed = ['name', 'slug', 'category', 'price', 'image', 'inventory']
    const update = Object.fromEntries(Object.entries(req.body).filter(([key, value]) => allowed.includes(key) && value !== undefined))
    if (update.price !== undefined) update.price = Number(update.price)
    if (update.inventory !== undefined) update.inventory = Number(update.inventory)
    if (!update.name || !update.slug || !update.category || !Number.isFinite(update.price) || !Number.isFinite(update.inventory)) return res.status(400).json({ error: 'Name, slug, category, price, and inventory are required.' })
    update.updatedAt = new Date()
    const collection = (await getDb()).collection('products')
    const result = await collection.findOneAndUpdate({ _id: new ObjectId(req.params.id) }, { $set: update }, { returnDocument: 'after' })
    if (!result) return res.status(404).json({ error: 'Product not found.' })
    const { _id, ...product } = result
    res.json({ ...product, id: String(_id) })
  } catch (error) { next(error) }
})
app.delete('/api/admin/products/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid product id.' })
    const result = await (await getDb()).collection('products').deleteOne({ _id: new ObjectId(req.params.id) })
    if (!result.deletedCount) return res.status(404).json({ error: 'Product not found.' })
    res.status(204).end()
  } catch (error) { next(error) }
})
app.patch('/api/admin/orders/:orderNumber/status', requireAdmin, async (req, res, next) => {
  try {
    const allowed = ['pending', 'processing', 'shipped', 'delivered', 'cancelled']
    if (!allowed.includes(req.body.status)) return res.status(400).json({ error: 'Unsupported order status.' })
    const result = await (await getDb()).collection('orders').updateOne({ orderNumber: req.params.orderNumber }, { $set: { status: req.body.status, updatedAt: new Date() } })
    if (!result.matchedCount) return res.status(404).json({ error: 'Order not found.' })
    res.json({ orderNumber: req.params.orderNumber, status: req.body.status })
  } catch (error) { next(error) }
})
app.post('/api/auth/register', async (req, res, next) => {
  try {
    const { name, email, password } = req.body
    if (!name || !email || !password || password.length < 8) return res.status(400).json({ error: 'Name, email, and an 8-character password are required.' })
    const db = await getDb()
    if (await db.collection('users').findOne({ email: email.toLowerCase() })) return res.status(409).json({ error: 'An account with this email already exists.' })
    const user = { name, email: email.toLowerCase(), passwordHash: await bcrypt.hash(password, 12), createdAt: new Date() }
    const result = await db.collection('users').insertOne(user)
    res.status(201).json({ token: signToken(result.insertedId), user: { id: result.insertedId, name, email: user.email } })
  } catch (error) { next(error) }
})
app.post('/api/auth/login', async (req, res, next) => {
  try {
    const db = await getDb()
    const user = await db.collection('users').findOne({ email: String(req.body.email || '').toLowerCase() })
    if (!user || !(await bcrypt.compare(req.body.password || '', user.passwordHash))) return res.status(401).json({ error: 'Invalid email or password.' })
    res.json({ token: signToken(user._id), user: { id: user._id, name: user.name, email: user.email } })
  } catch (error) { next(error) }
})
app.post('/api/orders', async (req, res, next) => {
  try {
    const { customer, items, couponCode } = req.body
    if (!customer?.email || !customer?.address || !Array.isArray(items) || !items.length) return res.status(400).json({ error: 'A customer email, address, and at least one item are required.' })
    const db = await getDb()
    let firebaseUid
    if (String(req.headers.authorization || '').startsWith('Bearer ') && process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      try { firebaseUid = (await firebaseAdminAuth().verifyIdToken(String(req.headers.authorization).slice(7))).uid } catch { return res.status(401).json({ error: 'Your session has expired. Please sign in again.' }) }
    }
    const subtotal = items.reduce((sum, item) => sum + Number(item.price) * Number(item.quantity), 0)
    let discount = 0
    let coupon
    if (couponCode) {
      coupon = await db.collection('coupons').findOne({ code: String(couponCode).trim().toUpperCase(), enabled: { $ne: false } })
      if (!coupon) return res.status(400).json({ error: 'Coupon not found.' })
      const now = Date.now()
      if (new Date(coupon.startDate).getTime() > now || new Date(coupon.expiryDate).getTime() <= now) return res.status(400).json({ error: 'This coupon is not currently active.' })
      if (coupon.usageLimit !== null && Number(coupon.usedCount || 0) >= Number(coupon.usageLimit)) return res.status(400).json({ error: 'This coupon has reached its usage limit.' })
      if (subtotal < Number(coupon.minimumOrderAmount || 0)) return res.status(400).json({ error: 'The order does not meet this coupon minimum.' })
      const rawDiscount = coupon.discountType === 'percentage' ? subtotal * Number(coupon.discountValue) / 100 : Number(coupon.discountValue)
      discount = Math.min(rawDiscount, Number(coupon.maximumDiscount || rawDiscount), subtotal)
    }
    const total = subtotal - discount
    const order = { ...(firebaseUid ? { firebaseUid } : {}), orderNumber: `SB-${Date.now().toString().slice(-8)}`, customer, items, ...(coupon ? { couponCode: coupon.code, discount } : {}), subtotal, total, status: 'confirmed', createdAt: new Date() }
    await db.collection('orders').insertOne(order)
    if (coupon) await db.collection('coupons').updateOne({ _id: coupon._id }, { $inc: { usedCount: 1 } })
    res.status(201).json({ orderNumber: order.orderNumber, total })
  } catch (error) { next(error) }
})
app.get('/api/orders/:orderNumber', async (req, res, next) => {
  try {
    const order = await (await getDb()).collection('orders').findOne({ orderNumber: req.params.orderNumber }, { projection: { _id: 0 } })
    if (!order) return res.status(404).json({ error: 'Order not found.' })
    res.json(order)
  } catch (error) { next(error) }
})

function signToken(id) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not configured')
  return jwt.sign({ sub: String(id) }, process.env.JWT_SECRET, { expiresIn: '7d' })
}

app.use((error, _req, res, _next) => {
  console.error(error)
  if (error.name === 'MongoServerSelectionError' || error.name === 'MongoNetworkError') {
    return res.status(503).json({ error: 'MongoDB is unreachable from this machine. Check Atlas Network Access, credentials, and TLS/proxy settings.' })
  }
  res.status(500).json({ error: 'Unexpected server error.' })
})
const server = app.listen(port, () => console.log(`Sable & Co. API listening on http://localhost:${port}`))
process.on('SIGTERM', async () => { server.close(); await closeDb() })
process.on('SIGINT', async () => { server.close(); await closeDb() })
