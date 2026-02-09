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
│                        IMAGE UPLOAD FLOW                                     │
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
   - Gemini analyzes
   - Save to DB
   - Cache result in Redis
```

## Data Flow: Fix Generation with Caching

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        FIX GENERATION FLOW                                   │
└─────────────────────────────────────────────────────────────────────────────┘

1. User requests fix for problems
        │
        ▼
2. Generate fix signature: SHA256(imageId + sorted(problemIds))
        │
        ▼
3. Check Redis: fixsig:{imageId}:{signature}
        │
        ├──── CACHE HIT ────┐
        │                   │
        ▼                   ▼
4. Check DB for          Get cached fixId,
   completed fix         return result
   with same sig         (NO AI call!)
        │
        ├──── FOUND ────────┐
        │                   │
        ▼                   ▼
5. NEW FIX:              Reuse existing
   - Call Gemini         fix result
     image gen           (NO AI call!)
   - Upload result
   - Cache result
   - Cache signature
```

## Redis Key Schema

| Key Pattern | Description | TTL | Example |
|-------------|-------------|-----|---------|
| `user:{userId}:credits` | User beta credits | 5 min | `user:abc123:credits` |
| `user:{userId}:images` | User's image list | 5 min | `user:abc123:images` |
| `image:{imageId}:metadata` | Image metadata | 15 min | `image:img_xyz:metadata` |
| `analysis:{imageId}` | AI analysis result | 24 hours | `analysis:img_xyz` |
| `imagehash:{userId}:{hash}` | Image dedup lookup | 30 days | `imagehash:abc123:a1b2c3...` |
| `fixresult:{fixId}` | Fix result | 7 days | `fixresult:fix_123` |
| `fixsig:{imageId}:{signature}` | Fix dedup lookup | 7 days | `fixsig:img_xyz:sig123` |
| `fixindex:{imageId}` | List of fixes | 2 hours | `fixindex:img_xyz` |
| `api:{endpoint}:{params}` | API response cache | varies | `api:images:list:u:abc123` |

## TTL Configuration Table

| Cache Type | Default TTL | Environment Variable | Purpose |
|------------|-------------|---------------------|---------|
| User Credits | 5 min | `CACHE_TTL_USER_CREDITS` | Short - changes frequently |
| User Profile | 10 min | `CACHE_TTL_USER_PROFILE` | Short - user data |
| Image Metadata | 15 min | `CACHE_TTL_IMAGE_METADATA` | Medium - image data |
| Image List | 5 min | `CACHE_TTL_IMAGE_LIST` | Short - list changes on upload |
| Analysis Result | 24 hours | `CACHE_TTL_ANALYSIS` | Long - immutable once complete |
| Fix Result | 7 days | `CACHE_TTL_FIX_RESULT` | Long - matches signed URL expiry |
| Fix Index | 2 hours | `CACHE_TTL_FIX_INDEX` | Medium - list of fixes |
| Image Hash | 30 days | `CACHE_TTL_IMAGE_HASH` | Very long - dedup lookup |
| API Short | 5 min | `CACHE_TTL_API_SHORT` | Quick refresh endpoints |
| API Medium | 15 min | `CACHE_TTL_API_MEDIUM` | Standard endpoints |
| API Long | 1 hour | `CACHE_TTL_API_LONG` | Static/config endpoints |

## Cost Savings Analysis

### AI API Costs (Gemini)
- **Room Analysis**: ~$0.01-0.02 per image
- **Image Generation (Fix)**: ~$0.05-0.10 per fix
- **Content Moderation**: ~$0.001 per check

### Deduplication Savings

| Scenario | Without Dedup | With Dedup | Savings |
|----------|---------------|------------|---------|
| User uploads same image 5x | 5 AI calls = $0.10 | 1 AI call = $0.02 | **$0.08 (80%)** |
| User requests same fix 3x | 3 gen calls = $0.30 | 1 gen call = $0.10 | **$0.20 (67%)** |
| 1000 users, 10% duplicate rate | 1000 analyses | 900 analyses | **$2.00/day** |

### Caching Savings

| Operation | DB Reads/min | With Cache | Savings |
|-----------|--------------|------------|---------|
| Get analysis (polling) | 60 | 1 + cache hits | **98% DB reads** |
| List images | 30 | 6 + cache hits | **80% DB reads** |
| Get fix result | 20 | 2 + cache hits | **90% DB reads** |

## Cache Invalidation Strategy

### Automatic Invalidation (TTL-based)
- All cached data has TTL
- Stale data expires automatically
- Safe default for read-heavy workloads

### Manual Invalidation (Event-based)

| Event | Keys Invalidated |
|-------|------------------|
| Image uploaded | `user:{userId}:images` |
| Analysis completed | `image:{imageId}:metadata` |
| Fix completed | `fixindex:{imageId}`, `image:{imageId}:metadata` |
| Fix deleted | `fixresult:{fixId}`, `fixindex:{imageId}` |
| Image deleted | `imagehash:{userId}:{hash}`, `analysis:{imageId}` |
| Credits consumed | `user:{userId}:credits` |

### Why TTL + Manual?
1. **Safety**: TTL ensures eventual consistency even if manual invalidation fails
2. **Simplicity**: Not every state change needs explicit invalidation
3. **Performance**: Aggressive TTL on volatile data, long TTL on immutable data

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
CACHE_TTL_USER_CREDITS=300        # 5 minutes
CACHE_TTL_USER_PROFILE=600        # 10 minutes
CACHE_TTL_IMAGE_METADATA=900      # 15 minutes
CACHE_TTL_IMAGE_LIST=300          # 5 minutes
CACHE_TTL_ANALYSIS=86400          # 24 hours
CACHE_TTL_FIX_RESULT=604800       # 7 days
CACHE_TTL_FIX_INDEX=7200          # 2 hours
CACHE_TTL_IMAGE_HASH=2592000      # 30 days
CACHE_TTL_API_SHORT=300           # 5 minutes
CACHE_TTL_API_MEDIUM=900          # 15 minutes
CACHE_TTL_API_LONG=3600           # 1 hour
```

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

/globalImageHashes/{hash}/{userId}
  - Same structure as above
  - Enables cross-user deduplication (optional)
```

### Modified Collections

```
/images/{imageId}
  + contentHash: string  // SHA-256 hash of original image
  + duplicateOf: string  // Reference to original (if duplicate)
```

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
  { ttl: CACHE_TTL.ANALYSIS_RESULT }
);
```

## Files Reference

| File | Purpose |
|------|---------|
| `src/config/redis.config.ts` | Redis client singleton, TTL constants, key patterns |
| `src/services/cache.service.ts` | High-level caching operations, domain helpers |
| `src/services/dedup.service.ts` | Image deduplication using SHA-256 |
| `src/middleware/cache.middleware.ts` | Express middleware for API response caching |
| `src/controllers/image.tsoa.controller.ts` | Image upload with dedup, analysis with cache |
| `src/services/fix.service.ts` | Fix generation with signature dedup + caching |

## Production Deployment

### Google Memorystore Setup

1. Create Memorystore Redis instance in same region as Cloud Functions
2. Configure VPC connector for Cloud Functions
3. Set `REDIS_HOST` to Memorystore IP
4. Enable AUTH if using Redis AUTH

### Monitoring

- Monitor cache hit rate via `CacheService.getStats()`
- Set up alerts for Redis connection failures
- Track deduplication savings in logs (`dedup:cache_hit`, `fix:cache_hit`)

### Scaling Considerations

- Redis Memorystore: Start with Basic tier, scale to Standard for HA
- Consider Redis Cluster for >100GB data
- Use read replicas for read-heavy workloads
