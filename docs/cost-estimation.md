# Cost Estimation

Estimated costs for running CookLynx AI backend services.

## Service Cost Breakdown

### Google Cloud Functions

| Resource         | Free Tier | Paid Tier       | Notes                     |
| ---------------- | --------- | --------------- | ------------------------- |
| Invocations      | 2M/month  | $0.40/million   | api + urlRecipeWorker     |
| Compute (GB-s)   | 400K GB-s | $0.0000025/GB-s | Workers use 2GiB          |
| Network (egress) | 5GB/month | $0.12/GB        | Minimal for API responses |

**URL Recipe Worker Cost per Invocation:**

- 2GiB memory × 2 minutes avg = 4 GB-minutes = 240 GB-seconds
- Cost: ~$0.0006 per URL processed

### Google Cloud Storage

| Resource             | Free Tier | Paid Tier      | Notes                   |
| -------------------- | --------- | -------------- | ----------------------- |
| Storage              | 5GB       | $0.02/GB/month | Images only             |
| Operations (Class A) | 50K/month | $0.05/10K      | Writes                  |
| Operations (Class B) | 5M/month  | $0.004/10K     | Reads                   |
| Network (egress)     | 1GB/day   | $0.12/GB       | Signed URLs reduce this |

**Per Image Storage:**

- Optimized image: ~200-500KB
- Estimated: ~$0.00001/month per image stored

### Google Cloud Pub/Sub

| Resource | Free Tier  | Paid Tier | Notes                   |
| -------- | ---------- | --------- | ----------------------- |
| Messages | 10GB/month | $40/TiB   | Message payload is tiny |

**Cost:** Negligible (~$0.00001 per message)

### Gemini AI (Google AI Studio)

| Model                           | Input Cost         | Output Cost        | Notes                |
| ------------------------------- | ------------------ | ------------------ | -------------------- |
| Gemini 3 Flash (food analysis)  | $0.10/1M tokens    | $0.40/1M tokens    | Image + text output  |
| Gemini 3 Flash (URL extraction) | $0.10/1M tokens    | $0.40/1M tokens    | Video or URL context |
| Gemini 2.0 Flash (moderation)   | Free tier eligible | Free tier eligible | Content moderation   |

**Per Food Image Analysis Cost:**

- Image input tokens: ~1K-2K tokens
- Recipe recommendations output: ~500-800 tokens
- Total AI cost: ~$0.002-0.003 per image

**Per URL Recipe Extraction Cost:**

- YouTube video (fileData): ~10K-15K tokens input
- Recipe extraction output: ~1K-2K tokens
- Total: ~$0.01-0.02 per YouTube URL

- Webpage (URL Context): ~3K-5K tokens input
- Recipe extraction output: ~1K-2K tokens
- Total: ~$0.003-0.005 per webpage URL

**Per Moderation Check Cost:**

- Free tier eligible (Gemini 2.0 Flash)
- Total: ~$0 per check

### Firebase Realtime Database

| Resource    | Free Tier        | Paid Tier          |
| ----------- | ---------------- | ------------------ |
| Storage     | 1GB              | $1/GB/month        |
| Downloads   | 10GB/month       | $1/GB              |
| Connections | 100 simultaneous | Unlimited on Blaze |

**Cost:** Minimal for metadata storage (~$1-5/month at scale)

### RevenueCat

| Plan   | Cost          | Notes          |
| ------ | ------------- | -------------- |
| Free   | $0            | Up to $10k MRR |
| Growth | 1% of revenue | After $10k MRR |

**Cost:** Free for early stages, scales with revenue

---

## Estimated Cost Per Operation

| Operation                   | Compute | Storage  | AI     | Total   |
| --------------------------- | ------- | -------- | ------ | ------- |
| **Image Upload + Analysis** | $0.0001 | $0.00001 | $0.003 | ~$0.003 |
| **URL Recipe (YouTube)**    | $0.0006 | $0       | $0.015 | ~$0.016 |
| **URL Recipe (Webpage)**    | $0.0006 | $0       | $0.004 | ~$0.005 |

---

## Monthly Cost Scenarios

### Free Tier Demo (Low Usage)

| Volume      | Cost             |
| ----------- | ---------------- |
| 100 images  | $0.30            |
| 50 YouTube  | $0.80            |
| 50 webpages | $0.25            |
| **Total**   | **~$1.35/month** |

### Beta Launch (Medium Usage)

| Volume       | Cost              |
| ------------ | ----------------- |
| 1,000 images | $3                |
| 500 YouTube  | $8                |
| 500 webpages | $2.50             |
| **Total**    | **~$13.50/month** |

### Production (High Usage)

| Volume         | Cost            |
| -------------- | --------------- |
| 10,000 images  | $30             |
| 5,000 YouTube  | $80             |
| 5,000 webpages | $25             |
| **Total**      | **~$135/month** |

---

## Cost Optimization Tips

1. **Use Gemini 2.0 Flash for moderation** - Free tier eligible
2. **Deduplicate content** - Same content reuses previous analysis
3. **URL deduplication** - Same URL extraction is shared across all users
4. **Single AI call for food analysis** - Combined ingredient detection + recipe
   recommendations
5. **Signed URLs** - 7-day expiration reduces storage egress
6. **Redis caching** - Reduces database reads for repeated queries
7. **RevenueCat handles subscriptions** - No custom subscription logic needed

---

## Free Tier Limits (Blaze Plan)

Even on the pay-as-you-go Blaze plan, you get free quotas:

| Service                     | Free Monthly Quota |
| --------------------------- | ------------------ |
| Cloud Functions invocations | 2,000,000          |
| Cloud Functions compute     | 400,000 GB-seconds |
| Cloud Storage               | 5 GB               |
| Realtime Database storage   | 1 GB               |
| Realtime Database downloads | 10 GB              |
| Pub/Sub messages            | 10 GB              |

For early development and testing, you'll likely stay within free tier limits.

---

## Revenue vs Cost Analysis

### With Subscription Model

| Scenario | Monthly Users | Revenue (Avg $5/user) | Cloud Costs | RevenueCat FeeFEE | Net Profit    |
| -------- | ------------- | --------------------- | ----------- | ----------------- | ------------- |
| Launch   | 100           | $500                  | ~$15        | $0 (free tier)    | $485 (97%)    |
| Growth   | 1,000         | $5,000                | ~$135       | $0 (free tier)    | $4,865 (97%)  |
| Scale    | 10,000        | $50,000               | ~$1,350     | $500 (1%)         | $48,150 (96%) |

---

## Pricing Links

- [Cloud Functions Pricing](https://cloud.google.com/functions/pricing)
- [Cloud Storage Pricing](https://cloud.google.com/storage/pricing)
- [Cloud Pub/Sub Pricing](https://cloud.google.com/pubsub/pricing)
- [Gemini API Pricing](https://ai.google.dev/pricing)
- [Firebase Pricing](https://firebase.google.com/pricing)
- [RevenueCat Pricing](https://www.revenuecat.com/pricing)
