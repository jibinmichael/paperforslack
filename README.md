# 📄 Paper - Slack Canvas Conversation Summarizer

AI-powered Slack app that automatically creates and maintains Canvas summaries of your team conversations using OpenAI GPT-4.

## 🚀 Quick Setup

### 1. Environment Variables
Create a `.env` file in the root directory with the following variables:

```bash
# Slack App Configuration
# Get these from your Slack app settings at https://api.slack.com/apps

# Bot User OAuth Token (starts with xoxb-)
SLACK_BOT_TOKEN=xoxb-your-token-here

# Signing Secret (from Basic Information tab)
SLACK_SIGNING_SECRET=your-signing-secret-here

# App-Level Token (starts with xapp-, needed for Socket Mode)
SLACK_APP_TOKEN=xapp-your-app-token-here

# OAuth Configuration (for public distribution)
SLACK_CLIENT_ID=your-client-id
SLACK_CLIENT_SECRET=your-client-secret
SLACK_OAUTH_REDIRECT_URI=your-redirect-uri

# OpenAI Configuration
OPENAI_API_KEY=sk-your-openai-key-here

# Server Configuration
PORT=10000
NODE_ENV=production
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Start the App
```bash
npm start
```

## 🔧 Troubleshooting

### Common Issues After Debug Rollback

#### "channel_not_found" Errors
**Symptoms:**
- `Error: An API error occurred: channel_not_found`
- App connects but can't access channels

**Solutions:**
1. **Re-add the bot to channels** where it was working before
2. **Check channel permissions** - the channel may have been archived/deleted
3. **Verify bot scopes** in your Slack app configuration

#### "Missing Environment Variables"
**Symptoms:**
- `[dotenv@16.6.0] injecting env (0) from .env`
- App fails to start or connect

**Solutions:**
1. **Create `.env` file** with all required variables (see template above)
2. **Get fresh tokens** from https://api.slack.com/apps
3. **Verify token format** - Bot tokens start with `xoxb-`, App tokens with `xapp-`

#### "invalid_arguments" Errors
**Symptoms:**
- `Error: An API error occurred: invalid_arguments`
- App home doesn't load

**Solutions:**
1. **Check bot token scopes** - ensure all required permissions are granted
2. **Reinstall the app** if scopes were changed
3. **Verify user permissions** in the workspace

### Required Slack App Scopes
Your Slack app needs these OAuth scopes:
```
channels:read
channels:history
chat:write
chat:write.public
app_mentions:read
canvases:write
canvases:read
im:write
mpim:write
groups:read
groups:history
users:read
team:read
```

### Socket Mode Setup
1. Go to your Slack app settings
2. Navigate to "Socket Mode" 
3. Enable Socket Mode
4. Create an App-Level Token with `connections:write` scope
5. Use this token as your `SLACK_APP_TOKEN`

## 📋 App Features

- **Smart Bootstrapping**: Creates Canvas from 14 days of history when joining channels
- **Automatic Updates**: Summarizes every 10 messages or 2 minutes
- **AI-Powered**: Uses OpenAI GPT-4 for intelligent conversation analysis
- **Multi-Day Support**: Handles conversations with 1000+ messages
- **Granola Format**: Professional, structured summaries with action items
- **Error Recovery**: Graceful handling of channel access issues

## 🔄 Recovery After Issues

If you're experiencing issues after a debug rollback:

1. **Check Environment Variables**
   ```bash
   # Verify your .env file exists and has values
   cat .env
   ```

2. **Verify Slack App Status**
   - Visit https://api.slack.com/apps
   - Check your app's "Install App" status
   - Regenerate tokens if needed

3. **Re-add to Channels**
   - Go to the problematic channel (e.g., `C070Y2NLDFB`)
   - Type `/apps` and add Paper back to the channel
   - Or use "Add to Channel" in the app directory

4. **Test Connection**
   ```bash
   # Look for this log message on startup
   ✅ Environment variables validated
   ⚡️ Paper Slack app connected via Socket Mode!
   ```

5. **Monitor Logs**
   - Watch for specific error messages
   - `channel_not_found` = re-add bot to channel
   - `missing_scope` = check app permissions
   - `invalid_arguments` = verify token validity

## 💡 Usage

1. **Add Paper to any channel**
2. **Have conversations naturally** (5+ messages)
3. **Watch Canvas summaries appear automatically**
4. **Mention `@Paper summary`** for manual updates

## 🛠️ Development

```bash
# Development mode with auto-restart
npm run dev

# Production mode
npm start
```

## 📞 Support

If you continue having issues:
1. Check the logs for specific error messages
2. Verify all environment variables are set
3. Ensure the bot has proper channel access
4. Test with a simple mention: `@Paper summary`

## 📄 License

MIT License - feel free to modify and distribute!

## 🤝 Support

- Create GitHub issues for bugs
- Check Slack app logs for errors
- Verify API key permissions and credits 