# Sable & Co. API

## Setup

1. Copy `.env.example` to `.env`.
2. Set `MONGODB_URI` to your MongoDB Atlas connection string, without committing the file.
3. Set a long random `JWT_SECRET`.
4. Add the Firebase Admin service account JSON to `FIREBASE_SERVICE_ACCOUNT_JSON`. This is required for customer account APIs and must never be exposed to the frontend.
5. Configure an unsigned Cloudinary upload preset in the frontend environment for profile photos.
6. Install and run:

```powershell
npm install
npm run dev
```

The API runs on `http://localhost:4000`.

## Endpoints

- `GET /api/health`
- `GET /api/products`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/orders`
- `GET /api/orders/:orderNumber`
- Protected customer APIs under `/api/account/*` (Firebase ID token required): overview, profile, orders, wishlist, addresses, notifications, reviews, and recently viewed.

The API reuses one `MongoClient` for the process. The pool is intentionally conservative for local development and a small traditional OLTP storefront; tune it after observing Atlas connection and wait-queue metrics in production.
