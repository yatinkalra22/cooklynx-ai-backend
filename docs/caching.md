# Redis Caching & Image Deduplication Architecture

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Client Request                                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Firebase Cloud Functions                            │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                        Express Middleware Stack                         │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │ │
│  │  │    CORS      │→ │   Auth       │→ │   Cache      │→ Controllers     │ │
│  │  │  Middleware  │  │  Middleware  │  │  Middleware  │                  │ │
│  │  └──────────────┘  └──────────────┘  └──────────────┘                  │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                       │
│  ┌───────────────────────────────────┼───────────────────────────────────┐  │
│  │                           Services Layer                               │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │  │
│  │  │   AI        │  │   Storage    │  │   Cache      │  │   Dedup    │ │  │
│  │  │   Service   │  │   Service    │  │   Service    │  │   Service  │ │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘  └────────────┘ │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                    │                    │                    │
                    ▼                    ▼                    ▼
        ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
        │   Google Gemini  │  │  Cloud Storage   │  │     Redis        │
        │   AI APIs        │  │  (Images)        │  │  (Memorystore)   │
        └──────────────────┘  └──────────────────┘  └──────────────────┘
                                      │                    │
                                      ▼                    ▼
                            ┌──────────────────────────────────────┐
                            │        Firebase Realtime DB          │
                            │  (Primary persistent storage)        │
                            └──────────────────────────────────────┘
```

## Data Flow: Image Upload with Deduplication

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ IMAGE UPLOAD FLOW                                     │
└─────────────────────────────────────────────────────────────────────────────┘

1. User uploads image
        │
        ▼
2. Generate SHA-256 hash of image bytes
        │
        ▼
3. Check Redis cache: imagehash:{userId}:{hash}
        │
        ├──── CACHE HIT ────┐
        │                   │
        ▼                   ▼
4. Check DB:          Return existing
   imageHashes/       image metadata
   {userId}/{hash}    (NO AI call!)
        │
        ├──── FOUND ────────┐
        │                   │
        ▼                   ▼
5. NEW IMAGE:         Return existing
   - Upload to        image metadata
     Cloud Storage    (NO AI call!)
   - Save metadata
   - Record hash
   - Start AI analysis
        │
        ▼
6. AI Analysis (async):
   - Gemini analyzes food items
   - Generates recipe recommendations
   - Save to DB
   - Cache result in Redis
```

## Data Flow: URL Recipe Extraction with Deduplication

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        URL RECIPE EXTRACTION FLOW                            │
└─────────────────────────────────────────────────────────────────────────────┘

1. User submits URL
        │
        ▼
2. Generate SHA-256 hash of normalized URL
        │
        ▼
3. Check Redis: urlhash:{hash}
        │
        ├──── CACHE HIT ────┐
        │                   │
        ▼                   ▼
4. Check DB:          Get cached urlId,
   sharedUrlRecipes/  return completed
   {hash}             extraction (NO AI!)
        │
        ├──── FOUND ────────┐
        │                   │
        ▼                   ▼
5. NEW URL:           Link to existing
   - Call Gemini      shared recipe
     (YouTube or      (NO AI call!)
     URL Context)
   - Save individual
     extraction
   - Save to shared
     storage
   - Cache result
```

---

4. Check DB for Get cached fixId, completed fix return result with same sig (NO
   AI call!) │ ├──── FOUND ────────┐ │ │ ▼ ▼
5. NEW FIX: Reuse existing
   - Call Gemini fix result image gen (NO AI call!)
   - Upload result
   - Cache result
   - Cache signature

````

## Redis Key Schema

| Key Pattern | Description | TTL | Example |
|-------------|-------------|-----|---------|
| `user:{userId}:images` | User's image list | 5 min | `user:abc123:images` |
| `image:{imageId}:metadata` | Image metadata | 15 min | `image:img_xyz:metadata` |
| `analysis:{imageId}` | AI analysis result + recipes | 24 hours | `analysis:img_xyz` |
| `imagehash:{userId}:{hash}` | Image dedup lookup | 30 days | `imagehash:abc123:a1b2c3...` |
| `recipe:{urlId}` | URL recipe result | 7 days | `recipe:url_123` |
| `urlhash:{hash}` | URL dedup lookup | 30 days | `urlhash:abc123...` |
| `sub:{userId}` | Subscription info | 15 min | `sub:abc123` |
| `api:{endpoint}:{params}` | API response cache | varies | `api:images:list:u:abc123` |

## TTL Configuration Table

| Cache Type | Default TTL | Environment Variable | Purpose |
|------------|-------------|---------------------|---------|
| User Profile | 10 min | `CACHE_TTL_USER_PROFILE` | Short - user data |
| Subscription Info | 15 min | `CACHE_TTL_SUBSCRIPTION` | Medium - changes occasionally |
| Image Metadata | 15 min | `CACHE_TTL_IMAGE_METADATA` | Medium - image data |
| Image List | 5 min | `CACHE_TTL_IMAGE_LIST` | Short - list changes on upload |
| Analysis Result | 24 hours | `CACHE_TTL_ANALYSIS` | Long - immutable once complete |
| Recipe Result | 7 days | `CACHE_TTL_RECIPE` | Long - immutable once extracted |
| Image Hash | 30 days | `CACHE_TTL_IMAGE_HASH` | Very long - dedup lookup |
| URL Hash | 30 days | `CACHE_TTL_URL_HASH` | Very long - dedup lookup |
| API Short | 5 min | `CACHE_TTL_API_SHORT` | Quick refresh endpoints |
| API Medium | 15 min | `CACHE_TTL_API_MEDIUM` | Standard endpoints |
| API Long | 1 hour | `CACHE_TTL_API_LONG` | Static/config endpoints |

## Cost Savings Analysis

### AI API Costs (Gemini)
- **Food Analysis + Recipes**: ~$0.002-0.003 per image
- **URL Recipe (YouTube)**: ~$0.01-0.02 per extraction
- **URL Recipe (Webpage)**: ~$0.003-0.005 per extraction
- **Content Moderation**: ~$0.001 per check (free tier)

### Deduplication Savings

| Scenario | Without Dedup | With Dedup | Savings |
|----------|---------------|------------|---------|
| User uploads same image 5x | 5 AI calls = $0.015 | 1 AI call = $0.003 | **$0.012 (80%)** |
| 100 users extract same YouTube URL | 100 AI calls = $1.50 | 1 AI call = $0.015 | **$1.485 (99%)** |
| 1000 users, 10% duplicate images | 1000 analyses = $3 | 900 analyses = $2.70 | **$0.30/day** |
| 1000 users, 50% duplicate URLs | 1000 extractions = $10 | 500 extractions = $5 | **$5/day** |

### Caching Savings

| Operation | DB Reads/min | With Cache | Savings |
|-----------|--------------|------------|---------|
| Get analysis (polling) | 60 | 1 + cache hits | **98% DB reads** |
| List images | 30 | 6 + cache hits | **80% DB reads** |
| Get recipe (polling) | 60 | 1 + cache hits | **98% DB reads** |
| Get subscription info | 20 | 2 + cache hits | **90% DB reads** |

---

## Cache Invalidation Strategy

### Automatic Invalidation (TTL-based)
- All cached data has TTL
- Stale data expires automatically
- Safe default for read-heavy workloads

### Manual Invalidation (Event-based)

| Event | Keys Invalidated |
|-------|------------------|
| Image uploaded | `user:{userId}:images` |
| Analysis completed | `image:{imageId}:metadata`, `analysis:{imageId}` |
| Image deleted | `imagehash:{userId}:{hash}`, `analysis:{imageId}`, `user:{userId}:images` |
| URL extraction completed | `recipe:{urlId}` |
| URL extraction failed | `recipe:{urlId}` |
| Subscription updated | `sub:{userId}` |

### Why TTL + Manual?
1. **Safety**: TTL ensures eventual consistency even if manual invalidation fails
2. **Simplicity**: Not every state change needs explicit invalidation
3. **Performance**: Aggressive TTL on volatile data, long TTL on immutable data

---

## Environment Variables

```bash
# Redis Connection
REDIS_HOST=localhost              # Memorystore IP or localhost
REDIS_PORT=6379                   # Default Redis port
REDIS_PASSWORD=                   # Optional: auth password
REDIS_DB=0                        # Database number (0-15)
REDIS_CONNECT_TIMEOUT=5000        # Connection timeout (ms)
REDIS_COMMAND_TIMEOUT=3000        # Command timeout (ms)
REDIS_RETRY_DELAY_MS=1000         # Retry delay base (ms)
REDIS_MAX_RETRIES=3               # Max reconnection attempts

# Cache TTLs (seconds)
CACHE_TTL_USER_PROFILE=600        # 10 minutes
CACHE_TTL_SUBSCRIPTION=900        # 15 minutes
CACHE_TTL_IMAGE_METADATA=900      # 15 minutes
CACHE_TTL_IMAGE_LIST=300          # 5 minutes
CACHE_TTL_ANALYSIS=86400          # 24 hours
CACHE_TTL_RECIPE=604800           # 7 days
CACHE_TTL_IMAGE_HASH=2592000      # 30 days
CACHE_TTL_URL_HASH=2592000        # 30 days
CACHE_TTL_API_SHORT=300           # 5 minutes
CACHE_TTL_API_MEDIUM=900          # 15 minutes
CACHE_TTL_API_LONG=3600           # 1 hour
````

---

## Database Schema Additions

### New Collections

```
/imageHashes/{userId}/{hash}
  - hash: string (SHA-256)
  - userId: string
  - imageId: string
  - originalName: string
  - uploadedAt: string (ISO)
  - fileSize: number

/sharedUrlRecipes/{urlHash}
  - urlHash: string (SHA-256 of normalized URL)
  - urlId: string (first extraction)
  - extractedAt: string
  - extractionCount: number
```

### Modified Collections

```
/images/{imageId}
  + contentHash: string  // SHA-256 hash of original image
  + analysisSourceId?: string  // Reference to original (if duplicate)

/urlExtractions/{urlId}
  + urlHash: string  // SHA-256 of normalized URL
  + sharedRecipeId?: string  // Reference to shared recipe if duplicate
```

---

## Graceful Degradation

The caching system is designed to degrade gracefully:

1. **Redis Unavailable**: All operations continue using Firebase DB
2. **Cache Miss**: Fetches from DB, attempts to cache result
3. **Cache Error**: Logs warning, continues without caching
4. **Connection Loss**: Automatic reconnection with exponential backoff

```typescript
// Example: Read-through cache with fallback
const analysis = await CacheService.getOrSet(
  CACHE_KEYS.analysis(imageId),
  async () => {
    // This runs only on cache miss
    const snapshot = await database.ref(`analysis/${imageId}`).get();
    return snapshot.val();
  },
  {ttl: CACHE_TTL.ANALYSIS}
);
```

---

## Files Reference

| File                                            | Purpose                                             |
| ----------------------------------------------- | --------------------------------------------------- |
| `src/config/redis.config.ts`                    | Redis client singleton, TTL constants, key patterns |
| `src/services/cache.service.ts`                 | High-level caching operations, domain helpers       |
| `src/services/dedup.service.ts`                 | Image & URL deduplication using SHA-256             |
| `src/middleware/cache.middleware.ts`            | Express middleware for API response caching         |
| `src/controllers/image.tsoa.controller.ts`      | Image upload with dedup, analysis with cache        |
| `src/controllers/recipe-url.tsoa.controller.ts` | URL extraction with shared dedup                    |
| `src/services/subscription.service.ts`          | Subscription info caching via RevenueCat            |

---

## Production Deployment

### Google Memorystore Setup

1. Create Memorystore Redis instance in same region as Cloud Functions
2. Configure VPC connector for Cloud Functions
3. Set `REDIS_HOST` to Memorystore IP
4. Enable AUTH if using Redis AUTH

### Monitoring

- Monitor cache hit rate via `CacheService.getStats()`
- Set up alerts for Redis connection failures
- Track deduplication savings in logs (`dedup:cache_hit`,
  `url:shared_recipe_reused`)

### Scaling Considerations

- Redis Memorystore: Start with Basic tier, scale to Standard for HA
- Consider Redis Cluster for >100GB data
- Use read replicas for read-heavy workloads
- URL deduplication provides massive savings at scale (1 extraction → many
  users)
