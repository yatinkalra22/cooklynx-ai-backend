# Infrastructure Setup Guide

This guide provides step-by-step instructions to set up the necessary
infrastructure for the CookLynx AI backend.

## Step 1: Install Required Tools (5 minutes)

### Install Firebase CLI

```bash
# Install Firebase tools globally
npm install -g firebase-tools

# Verify installation
firebase --version
# Should show: 13.x.x or higher
```

### Install Google Cloud CLI

```bash
# macOS
brew install --cask google-cloud-sdk

# Linux
curl https://sdk.cloud.google.com | bash
exec -l $SHELL

# Windows
# Download from: https://cloud.google.com/sdk/docs/install

# Verify installation
gcloud --version
```

### Install Terraform

```bash
# macOS
brew install terraform

# Linux
wget https://releases.hashicorp.com/terraform/1.6.0/terraform_1.6.0_linux_amd64.zip
unzip terraform_1.6.0_linux_amd64.zip
sudo mv terraform /usr/local/bin/

# Windows (use Chocolatey)
choco install terraform

# Verify
terraform --version
# Should show: Terraform v1.6.0 or higher
```

## Step 2: Create Firebase Project (5 minutes)

### 2.1 Login to Firebase

```bash
# Login to Firebase
firebase login

# This will open browser - sign in with your Google account
# You should see: "✔ Success! Logged in as your-email@gmail.com"
```

### 2.2 Create Firebase Project via Console (Easier for first time)

1.  Go to: https://console.firebase.google.com
2.  Click "Add project"
3.  Project name: `cooklynx-ai`
4.  Project ID: `cooklynx-ai-xxxxx` (Firebase auto-generates)
5.  Disable Google Analytics for now (we'll add later)
6.  Click "Create project"
7.  Wait ~30 seconds
8.  Click "Continue"

**Save your Project ID! You'll need it.**

### 2.3 Enable Required Services

In Firebase Console
(https://console.firebase.google.com/project/cooklynx-ai-xxxxx):

**Enable Authentication:**

1.  Left sidebar → Authentication
2.  Click "Get started"
3.  Click "Email/Password"
4.  Enable "Email/Password"
5.  Click "Save"

**Enable Realtime Database:**

1.  Left sidebar → Realtime Database
2.  Click "Create Database"
3.  Select location: United States (or closest to you)
4.  Start in "locked mode" (we'll add rules via code)
5.  Click "Enable"

**Enable Storage:**

1.  Left sidebar → Storage
2.  Click "Get started"
3.  Start in "production mode"
4.  Use same location as database
5.  Click "Done"

**Configure Storage CORS:**

After enabling Storage, configure CORS to allow browser downloads:

```bash
# Create storage-cors.json in project root with your allowed origins
# See deployment.md for the full configuration

# Apply CORS configuration
gsutil cors set storage-cors.json gs://YOUR-PROJECT-ID.firebasestorage.app

# Verify CORS is applied
gsutil cors get gs://YOUR-PROJECT-ID.firebasestorage.app
```

This allows your web app to download images and videos directly from Storage.

## Step 3: Set Up Google Cloud Project (3 minutes)

### 3.1 Link Firebase to GCP

```bash
# Set your project
gcloud config set project cooklynx-ai-xxxxx
# Replace xxxxx with your actual project ID

# Login to GCP
gcloud auth login

# Set up application default credentials (for Terraform)
gcloud auth application-default login
```

### 3.2 Enable Required APIs

```bash
# Enable Cloud Functions API
gcloud services enable cloudfunctions.googleapis.com

# Enable Cloud Build API (required for deployment)
gcloud services enable cloudbuild.googleapis.com

# Enable Cloud Storage API
gcloud services enable storage.googleapis.com

# Enable Firebase Realtime Database API
gcloud services enable firebasedatabase.googleapis.com

# Enable Secret Manager (for API keys)
gcloud services enable secretmanager.googleapis.com
```

## Troubleshooting

### Firebase Custom Token Error: `iam.serviceAccounts.signBlob` Permission Denied

If you encounter this error when creating Firebase custom tokens:

```
Permission 'iam.serviceAccounts.signBlob' denied on resource
```

This happens when the Cloud Run/Functions service account lacks permission to
sign custom tokens.

**Fix:**

1. Find the service account being used:

```bash
gcloud run services describe api \
  --region=us-central1 \
  --format="value(spec.template.spec.serviceAccountName)"
```

2. Grant the Service Account Token Creator role:

```bash
gcloud iam service-accounts add-iam-policy-binding YOUR_SERVICE_ACCOUNT@developer.gserviceaccount.com \
  --member="serviceAccount:YOUR_SERVICE_ACCOUNT@developer.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"
```

Replace `YOUR_SERVICE_ACCOUNT` with the actual service account email from
step 1.

The `serviceAccountTokenCreator` role includes the
`iam.serviceAccounts.signBlob` permission required for Firebase Admin SDK to
create custom tokens.
