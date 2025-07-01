# 🌐 Multi-Workspace Setup Guide for Paper

Paper now supports both **single-workspace** (token mode) and **multi-workspace** (OAuth mode) deployments.

## 🔧 Current Mode: Token (Single Workspace)

Your app is currently running in **token mode** - perfect for single workspace use.

## 🚀 Enable Multi-Workspace Support

To enable OAuth multi-workspace support, add these environment variables to your Render deployment:

### Required Environment Variables for OAuth Mode

```bash
# OAuth Configuration (add these to enable multi-workspace)
SLACK_CLIENT_ID=your_app_client_id
SLACK_CLIENT_SECRET=your_app_client_secret
SLACK_STATE_SECRET=any_random_string_for_security

# Keep existing variables
SLACK_SIGNING_SECRET=your_signing_secret  
SLACK_APP_TOKEN=your_app_token
OPENAI_API_KEY=your_openai_key
```

### 📋 Steps to Enable

1. **Get OAuth Credentials** from your Slack app:
   - Go to [Slack API Apps](https://api.slack.com/apps)
   - Select your Paper app
   - Go to **Basic Information** → **App Credentials**
   - Copy **Client ID** and **Client Secret**

2. **Add Environment Variables** in Render:
   - Go to your Render dashboard
   - Navigate to your Paper service
   - Go to **Environment** tab
   - Add the new OAuth variables above

3. **Deploy** - Render will automatically redeploy with OAuth support

4. **Update App Settings** in Slack:
   - Go to **OAuth & Permissions** in your Slack app
   - Add redirect URL: `https://your-app-url.onrender.com/slack/oauth_redirect`
   - Enable **Distribute App** if you want public distribution

## 🎯 What Changes

**Token Mode (Current):**
- ✅ Works with one workspace
- ✅ Simple setup with bot token
- ✅ No OAuth flow needed

**OAuth Mode (Multi-Workspace):**
- ✅ Works with unlimited workspaces
- ✅ Public installation page at `/install`
- ✅ Proper OAuth installation flow
- ✅ Automatic workspace management
- ✅ Fallback to token mode if OAuth vars missing

## 🔍 Testing

Visit these URLs after enabling OAuth:
- `https://your-app.onrender.com/install` - Installation page
- `https://your-app.onrender.com/debug` - Configuration debug
- `https://your-app.onrender.com/workspaces` - Installed workspaces

## 🔄 Automatic Detection

The app automatically detects which mode to use:
- **OAuth variables present** → Multi-workspace mode
- **Only token variables present** → Single workspace mode  
- **Neither** → Error with helpful message

No code changes needed - just add the environment variables! 🎉 