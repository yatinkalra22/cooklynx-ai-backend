# URL Recipe Extraction Architecture

## Overview

Extract a complete, grocery-list-ready recipe from **any URL** - YouTube videos,
Instagram posts, TikTok videos, recipe blogs, or any public webpage.

The system uses two Gemini AI capabilities depending on the platform:

- **YouTube** - Gemini native `fileData` (watches the actual video)
- **Everything else** - Gemini URL Context tool (reads the webpage content)

No downloads, no file storage, no third-party scrapers. The original URL is
preserved for frontend embed/preview rendering.

## Data Flow

```
User submits URL  (POST /v1/recipes/extract-from-url)
    |
    v
Validate URL format + detect platform
    |
    v
Check sharedUrlRecipes for existing extraction (deduplication)
    |
    +-- Recipe exists?
    |     |
    |     YES --> Return urlId instantly (status: completed)
    |     |      Create urlExtractions/{urlId} + urlRecipes/{urlId}
    |     |      pointing to shared data (no AI call, no credit cost)
    |     |
    |     NO
    v
Reserve 1 credit atomically (Firebase transaction)
    |
    v
Save metadata to /urlExtractions/{urlId}  (status: "queued")
    |
    v
Publish to Pub/Sub: url-recipe-extraction-queue
    |
    v
[urlRecipeExtractionWorker picks up job]
    |
    +-- YouTube?
    |     |
    |     YES --> geminiModel.generateContent([
    |     |         { fileData: { fileUri: url, mimeType: "video/*" } },
    |     |         { text: recipePrompt }
    |     |       ])
    |     |       Gemini watches the video natively (audio + visuals)
    |     |
    |     NO  --> axios.post(Gemini REST API, {
    |               contents: [{ text: prompt + url }],
    |               tools: [{ url_context: {} }]
    |             })
    |             Gemini visits the URL and reads the page content
    |
    v
Parse AI JSON response --> ExtractedRecipe
    |
    v
Save to /urlRecipes/{urlId}  +  Update status to "completed"
    |
    v
Save to /sharedUrlRecipes/{urlHash} for future deduplication
    |
    v
Client polls GET /v1/recipes/url/{urlId}  --> gets full recipe
```

## Platform Support

| Platform      | AI Method          | What Gets Analyzed                            | Quality   |
| ------------- | ------------------ | --------------------------------------------- | --------- |
| YouTube       | Gemini `fileData`  | Full video (audio, visuals, on-screen text)   | Excellent |
| Recipe blogs  | Gemini URL Context | Full recipe page (ingredients, steps, photos) | Excellent |
| Instagram     | Gemini URL Context | Post caption, description, comments           | Good      |
| TikTok        | Gemini URL Context | Video description, pinned comments            | Good      |
| Facebook      | Gemini URL Context | Post text, comments, linked content           | Good      |
| Any other URL | Gemini URL Context | Best-effort from page content                 | Varies    |

### Why Two Methods?

- **YouTube** has native Gemini integration. Gemini can watch YouTube videos
  directly via `fileData` without any download. This gives the best quality
  since the AI sees everything - spoken instructions, on-screen measurements,
  and cooking techniques.

- **Non-YouTube URLs** use Gemini's URL Context tool, which fetches and reads
  webpage content. This works great for recipe blogs (which have structured
  recipe cards) and reasonably well for social media (where recipes appear in
  captions/descriptions).

## API Endpoints

### POST /v1/recipes/extract-from-url

Submit a URL for recipe extraction. Costs 1 credit.

**Request:**

```json
{
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
}
```

**Response (201):**

```json
{
  "message": "URL submitted for recipe extraction. Analysis queued.",
  "urlId": "url_550e8400-e29b-41d4-a716-446655440000",
  "sourceUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "platform": "youtube",
  "status": "queued",
  "creditsUsed": 1
}
```

### GET /v1/recipes/url/{urlId}

Poll for extraction status and results.

**Response (completed):**

```json
{
  "status": "completed",
  "extraction": {
    "urlId": "url_550e8400...",
    "sourceUrl": "https://www.youtube.com/watch?v=...",
    "platform": "youtube",
    "submittedAt": "2026-02-10T10:00:00Z"
  },
  "recipe": {
    "urlId": "url_550e8400...",
    "sourceUrl": "https://www.youtube.com/watch?v=...",
    "platform": "youtube",
    "recipe": {
      "title": "Creamy Garlic Tuscan Chicken",
      "description": "A rich, creamy one-pan chicken dish",
      "ingredients": [
        {
          "name": "chicken breast",
          "quantity": 2,
          "unit": "pieces",
          "category": "Meat & Seafood",
          "preparation": "pounded to even thickness",
          "optional": false
        },
        {
          "name": "heavy cream",
          "quantity": 1,
          "unit": "cup",
          "category": "Dairy & Eggs",
          "optional": false
        },
        {
          "name": "garlic",
          "quantity": 4,
          "unit": "cloves",
          "category": "Produce",
          "preparation": "minced",
          "optional": false
        },
        {
          "name": "red pepper flakes",
          "quantity": null,
          "unit": "to taste",
          "category": "Spices & Seasonings",
          "optional": true
        }
      ],
      "steps": [
        {
          "stepNumber": 1,
          "instruction": "Season chicken breasts with salt and pepper.",
          "durationMinutes": 2,
          "tip": "Pat dry with paper towels first"
        },
        {
          "stepNumber": 2,
          "instruction": "Heat olive oil in a large skillet over medium-high heat. Sear chicken 5-6 minutes per side.",
          "durationMinutes": 12
        }
      ],
      "timings": {
        "prepMinutes": 10,
        "cookMinutes": 25,
        "totalMinutes": 35,
        "restMinutes": 5
      },
      "servings": 4,
      "difficulty": "easy",
      "cuisine": "Italian",
      "mealType": "dinner",
      "dietaryTags": ["gluten-free"],
      "nutrition": {
        "calories": 450,
        "proteinGrams": 35,
        "carbsGrams": 8,
        "fatGrams": 30,
        "fiberGrams": 2
      },
      "equipment": ["large skillet", "tongs"]
    },
    "confidence": 0.95,
    "isRecipeVideo": true,
    "modelUsed": "gemini-3-flash-preview",
    "processingDurationMs": 12340,
    "analyzedAt": "2026-02-10T10:00:15Z",
    "version": "1.0"
  }
}
```

### GET /v1/recipes/urls

List all URL extractions by the authenticated user. Returns full recipe data for
completed extractions.

**Response (200):**

```json
{
  "extractions": [
    {
      "metadata": {
        "urlId": "url_550e8400...",
        "userId": "user123",
        "sourceUrl": "https://www.youtube.com/watch?v=...",
        "normalizedUrl": "https://www.youtube.com/watch?v=...",
        "platform": "youtube",
        "analysisStatus": "completed",
        "videoTitle": "Creamy Garlic Tuscan Chicken",
        "submittedAt": "2026-02-10T10:00:00Z",
        "completedAt": "2026-02-10T10:00:15Z"
      },
      "recipe": {
        "urlId": "url_550e8400...",
        "recipe": {
          /* full recipe data */
        },
        "confidence": 0.95,
        "isRecipeVideo": true
      }
    }
  ]
}
```

### GET /v1/recipes/combined

Get a combined list of user's image uploads and URL recipe extractions in a
single response.

**Response (200):**

```json
{
  "images": [
    {
      "imageId": "img_123",
      "uploadedAt": "2026-02-10T09:00:00Z",
      "fileName": "recipe.jpg",
      "thumbnailUrl": "",
      "analysisStatus": "completed"
    }
  ],
  "urlExtractions": [
    {
      "metadata": {
        /* extraction metadata */
      },
      "recipe": {
        /* full recipe data */
      }
    }
  ]
}
```

## Grocery List Integration

Ingredients are structured specifically for grocery list generation:

```typescript
interface RecipeIngredient {
  name: string; // "chicken breast"
  quantity: number | null; // 2 (null for "to taste")
  unit: string; // "pieces", "cups", "tbsp", "to taste"
  category: string; // "Meat & Seafood", "Produce", "Dairy & Eggs"
  preparation?: string; // "diced", "minced", "room temperature"
  optional?: boolean; // true for optional ingredients
}
```

**Ingredient categories** (for grocery aisle grouping):

- Produce (fruits, vegetables, herbs)
- Meat & Seafood
- Dairy & Eggs
- Bakery & Bread
- Pantry (flour, sugar, rice, pasta, canned goods)
- Spices & Seasonings
- Oils & Condiments
- Frozen
- Beverages
- Other

The frontend can directly map `category` to grocery store aisles for a organized
shopping list.

## Database Schema

```
urlExtractions/{urlId}/
  urlId: string
  userId: string
  sourceUrl: string              Original URL submitted by user
  normalizedUrl: string          Canonical URL (YouTube IDs normalized)
  platform: string               "youtube" | "instagram" | "tiktok" | "facebook" | "other" | "unknown"
  analysisStatus: string         "pending" | "queued" | "validating" | "analyzing" | "completed" | "failed"
  videoTitle: string             Populated after analysis from recipe title
  submittedAt: string            ISO timestamp
  completedAt: string            ISO timestamp (when done)
  error: string                  Error message (if failed)

urlRecipes/{urlId}/
  urlId: string
  userId: string
  sourceUrl: string
  platform: string
  recipe/
    title: string
    description: string
    ingredients/                  Array of RecipeIngredient (grocery-list ready)
    steps/                       Array of RecipeStep (numbered instructions)
    timings/                     { prepMinutes, cookMinutes, totalMinutes, restMinutes }
    servings: number
    difficulty: string           "easy" | "medium" | "hard"
    cuisine: string              "Italian", "Japanese", etc.
    mealType: string             "dinner", "breakfast", etc.
    dietaryTags: string[]        ["vegetarian", "gluten-free", etc.]
    nutrition/                   { calories, proteinGrams, carbsGrams, fatGrams, fiberGrams }
    equipment: string[]          ["oven", "blender", etc.]
  confidence: number             0-1 extraction quality score
  isRecipeVideo: boolean         false if URL was not recipe content
  modelUsed: string              Gemini model identifier
  processingDurationMs: number
  analyzedAt: string
  version: string

sharedUrlRecipes/{urlHash}/     🆕 Deduplication index
  urlHash: string                SHA-256 hash of normalizedUrl
  normalizedUrl: string          Canonical URL
  platform: string
  recipe/                        Complete ExtractedRecipe object
  confidence: number
  isRecipeVideo: boolean
  modelUsed: string
  firstExtractedAt: string       When first processed
  firstExtractedBy: string       UserId of first extraction
  extractionCount: number        How many times this URL was submitted
  version: string
```

## URL Deduplication

### How It Works

1. **Hash Generation**: When a URL is submitted, it's normalized (e.g., YouTube
   URLs are converted to canonical form) and hashed using SHA-256.

2. **Check Shared Storage**: Before processing, the system checks
   `sharedUrlRecipes/{urlHash}` to see if this URL has been processed before by
   any user.

3. **Instant Results**: If found and valid (confidence ≥ 0.5, isRecipeVideo =
   true):
   - No AI call is made
   - User gets instant results
   - Credit is still charged (for consistency)
   - Processing time: ~0ms

4. **First-Time Processing**: If not found:
   - URL is queued for AI processing
   - After successful extraction, recipe is saved to shared storage
   - Future submissions of the same URL will reuse this data

5. **Cross-User Sharing**: The same YouTube video submitted by 100 different
   users = 1 AI call, 99 instant results.

### Benefits

- **Cost Savings**: Popular recipes (e.g., viral YouTube videos) are processed
  once
- **Instant Results**: Subsequent submissions get immediate responses
- **Consistency**: All users get the same high-quality extraction for the same
  URL
- **Analytics**: Track extraction counts to identify popular recipes

### Cache Layers

1. **Redis** (30 days): Fast in-memory lookup for recently processed URLs
2. **Realtime Database**: Permanent storage of shared recipes

## Async Processing

URL recipe extraction runs asynchronously via Pub/Sub to avoid HTTP timeout
limits (Gemini video analysis can take 30-60 seconds for long videos).

**Pub/Sub Topic:** `url-recipe-extraction-queue`

**Worker Configuration:**

```typescript
{
  memory: "1GiB",        // Less than video upload (no frame extraction)
  timeoutSeconds: 300,   // 5 minutes for Gemini video analysis
  maxInstances: 10,      // Higher concurrency (lightweight processing)
}
```

**Status flow:** `queued` -> `analyzing` -> `completed` | `failed`

The client polls `GET /v1/recipes/url/{urlId}` until status is `completed` or
`failed`.

## Cost Analysis

### YouTube (fileData - video analysis)

- Video = ~258 tokens/second
- 5-minute video: 300s x 258 = ~77,400 input tokens
- Recipe JSON output: ~2,000 output tokens
- **Gemini 2.5 Flash**: $0.10/M input + $0.40/M output = ~$0.009
- **Gemini 3 Flash Preview**: ~$0.01 per video (slightly higher)

### Non-YouTube (URL Context - webpage analysis)

- Webpage content: ~5,000-20,000 input tokens
- Recipe JSON output: ~2,000 output tokens
- **Gemini 3 Flash Preview**: ~$0.003-$0.005 per URL

### Scale Projections

| Scale      | YouTube cost | Webpage cost | Total         |
| ---------- | ------------ | ------------ | ------------- |
| 100/day    | $1/day       | $0.50/day    | ~$45/month    |
| 1,000/day  | $10/day      | $5/day       | ~$450/month   |
| 10,000/day | $100/day     | $50/day      | ~$4,500/month |

YouTube URL feature is currently in Gemini **preview at no extra charge**, so
actual costs may be lower.

## Key Implementation Files

| File                                            | Purpose                                          |
| ----------------------------------------------- | ------------------------------------------------ |
| `src/types/recipe-url.types.ts`                 | All TypeScript interfaces                        |
| `src/services/url-recipe.service.ts`            | Core logic: URL validation, Gemini calls, DB ops |
| `src/controllers/recipe-url.tsoa.controller.ts` | API endpoints (3 routes)                         |
| `src/functions.ts`                              | Pub/Sub worker export                            |
| `src/config/pubsub.config.ts`                   | Topic + publish function                         |
| `src/config/constants.ts`                       | Credit cost, URL patterns                        |

## Limitations

### All Platforms

1. **Public URLs only** - Private/restricted content cannot be accessed
2. **1 credit consumed per user** - Even if URL was previously processed (fair
   usage)
3. **Single recipe per URL** - If content has multiple recipes, the primary one
   is extracted
4. **English-centric** - Non-English content may have lower extraction quality
5. **Quantity estimation** - If recipe doesn't state exact quantities, AI
   estimates (lower confidence)
6. **Deduplication by normalized URL** - Same recipe at different URLs will be
   processed separately

### YouTube-Specific

7. **Public/unlisted only** - Private YouTube videos will fail
8. **8 hours/day limit** - Gemini daily YouTube video processing cap (shared
   across all users)
9. **1 hour max video duration** - Gemini 1M context window limit
10. **Preview feature** - YouTube URL support in Gemini may change

### Non-YouTube (URL Context)

11. **Webpage text only** - AI reads the page, not embedded videos (no video
    analysis)
12. **Platform accessibility** - Some platforms may block automated page
    fetching
13. **Recipe in descriptions** - Quality depends on how much recipe info is in
    the page text vs. the video itself
14. **Paywalled content** - Cannot access content behind login walls

## Edge Cases

### Not a Recipe URL

- AI sets `isRecipeVideo: false`
- Returns minimal recipe object with empty arrays
- Client should check `isRecipeVideo` and show appropriate message
- Credit is still consumed

### Gemini Fails / Timeout

- Worker catches error, sets status to `failed` with error message
- Does NOT re-throw (prevents infinite Pub/Sub retries)
- Client sees `{ status: "failed", error: "..." }`

### Invalid URL

- Caught at validation before credit deduction
- Returns 400 with descriptive error message
- No credit consumed

## Future Enhancements

1. ~~**URL deduplication**~~ ✅ **IMPLEMENTED** - Cache results by normalized
   URL to avoid re-processing
2. **Batch extraction** - Submit multiple URLs in one request
3. **User preferences** - Filter by dietary restrictions, exclude allergens
4. **Recipe scaling** - Adjust ingredient quantities for different serving sizes
5. **Grocery list aggregation** - Combine ingredients from multiple recipes
6. **Save to collection** - Organize extracted recipes into folders/collections
7. **Recipe updates** - Re-process URLs to get updated versions of recipes

---

**Last Updated**: February 10, 2026 **Version**: 1.0
