# Cost Estimation

Estimated costs for running CookLynx AI backend services.

## Service Cost Breakdown

### Google Cloud Functions

| Resource         | Free Tier | Paid Tier       | Notes                          |
| ---------------- | --------- | --------------- | ------------------------------ |
| Invocations      | 2M/month  | $0.40/million   | Both api + videoAnalysisWorker |
| Compute (GB-s)   | 400K GB-s | $0.0000025/GB-s | Video worker uses 2GiB         |
| Network (egress) | 5GB/month | $0.12/GB        | Minimal for API responses      |

**Video Worker Cost per Invocation:**

- 2GiB memory × 9 minutes max = 18 GB-minutes = 1,080 GB-seconds
- Cost: ~$0.0027 per video processed

### Google Cloud Storage

| Resource             | Free Tier | Paid Tier      | Notes                    |
| -------------------- | --------- | -------------- | ------------------------ |
| Storage              | 5GB       | $0.02/GB/month | Images + videos + frames |
| Operations (Class A) | 50K/month | $0.05/10K      | Writes                   |
| Operations (Class B) | 5M/month  | $0.004/10K     | Reads                    |
| Network (egress)     | 1GB/day   | $0.12/GB       | Signed URLs reduce this  |

**Per Video Storage:**

- Video file: ~10-50MB
- Thumbnail: ~50KB
- Frames (12 max): ~600KB total
- Estimated: ~$0.001/month per video stored

### Google Cloud Pub/Sub

| Resource | Free Tier  | Paid Tier | Notes                   |
| -------- | ---------- | --------- | ----------------------- |
| Messages | 10GB/month | $40/TiB   | Message payload is tiny |

**Cost:** Negligible (~$0.0001 per video)

### Gemini AI (Google AI Studio)

| Model                           | Input Cost         | Output Cost        | Notes                |
| ------------------------------- | ------------------ | ------------------ | -------------------- |
| Gemini 3 Flash (images + video) | $0.10/1M tokens    | $0.40/1M tokens    | Multimodal analysis  |
| Gemini 2.0 Flash (moderation)   | Free tier eligible | Free tier eligible | Content moderation   |
| Gemini 3 Pro Image              | $0.0625/image      | -                  | Image fix generation |
| Gemini 3 Pro Video              | ~$0.10/video       | -                  | Video fix generation |

**Per Video Analysis Cost:**

- Video input tokens: ~5K-10K tokens for 60s video
- 12 frame moderation: ~$0.002
- Total AI cost: ~$0.005-0.01 per video

**Per Image Analysis Cost:**

- Image moderation: ~$0.0001
- Room analysis: ~$0.002
- Total: ~$0.003 per image

**Per Image Fix Generation Cost:**

- Image generation: ~$0.0625
- Re-analysis: ~$0.002
- Total: ~$0.065 per image fix

**Per Video Fix Generation Cost:**

- Video generation: ~$0.10
- Thumbnail extraction: ~$0.0001
- Total: ~$0.10 per video fix

### Firebase Realtime Database

| Resource    | Free Tier        | Paid Tier          |
| ----------- | ---------------- | ------------------ |
| Storage     | 1GB              | $1/GB/month        |
| Downloads   | 10GB/month       | $1/GB              |
| Connections | 100 simultaneous | Unlimited on Blaze |

**Cost:** Negligible for metadata storage

---

## Estimated Cost Per Operation

| Operation                   | Compute | Storage | AI     | Total   |
| --------------------------- | ------- | ------- | ------ | ------- |
| **Image Upload + Analysis** | $0.001  | $0.0001 | $0.003 | ~$0.004 |
| **Video Upload + Analysis** | $0.003  | $0.001  | $0.01  | ~$0.015 |
| **Image Fix Generation**    | $0.002  | $0.0001 | $0.065 | ~$0.067 |
| **Video Fix Generation**    | $0.003  | $0.0001 | $0.10  | ~$0.103 |

---

## Monthly Cost Scenarios

### Hackathon Demo (Low Usage)

| Volume     | Cost             |
| ---------- | ---------------- |
| 100 images | $0.40            |
| 50 videos  | $0.75            |
| 20 fixes   | $1.34            |
| **Total**  | **~$2.50/month** |

### Beta Launch (Medium Usage)

| Volume       | Cost           |
| ------------ | -------------- |
| 1,000 images | $4             |
| 500 videos   | $7.50          |
| 200 fixes    | $13.40         |
| **Total**    | **~$25/month** |

### Production (High Usage)

| Volume        | Cost            |
| ------------- | --------------- |
| 10,000 images | $40             |
| 5,000 videos  | $75             |
| 2,000 fixes   | $134            |
| **Total**     | **~$250/month** |

---

## Cost Optimization Tips

1. **Use Gemini 2.0 Flash for moderation** - Free tier eligible
2. **Deduplicate content** - Same content reuses previous analysis
3. **Limit video duration** - 60s max reduces AI costs
4. **Video generation** - Direct video generation is more efficient than
   frame-by-frame
5. **Fix deduplication** - Same fix requests reuse cached results
6. **Signed URLs** - 7-day expiration reduces storage egress
7. **Redis caching** - Reduces database reads for repeated queries

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

For a hackathon, you'll likely stay within free tier limits.

---

## Pricing Links

- [Cloud Functions Pricing](https://cloud.google.com/functions/pricing)
- [Cloud Storage Pricing](https://cloud.google.com/storage/pricing)
- [Cloud Pub/Sub Pricing](https://cloud.google.com/pubsub/pricing)
- [Gemini API Pricing](https://ai.google.dev/pricing)
- [Firebase Pricing](https://firebase.google.com/pricing)
