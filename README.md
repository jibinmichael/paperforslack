# 📄 Paper: Slack Canvas Conversation Summarizer

A minimal Slack app that creates and maintains Slack Canvas summaries of channel conversations in **Granola-style format**.

## ✨ Features

- 🎯 **Smart Batching**: Processes messages in 2-minute windows or 10-message batches
- 🔄 **Auto-Updates**: Canvas updates every 3 minutes maximum
- 🤖 **AI-Powered**: Uses OpenAI GPT-4 for intelligent summaries
- 📋 **Granola-Style**: Clean, structured summaries with decisions and action items
- ⚡ **Serverless**: Deployed on Vercel for reliability and scalability

## 🚀 Quick Setup

### 1. Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click "Create New App" → "From an app manifest"
3. Select your workspace
4. Copy and paste the content from `slack-app-manifest.json`
5. Create the app

### 2. Get API Keys

**Slack Tokens** (from your app's settings):
- **Bot User OAuth Token**: `Settings > OAuth & Permissions`
- **Signing Secret**: `Settings > Basic Information > Signing Secret`
- **App Token**: `Settings > Basic Information > App-Level Tokens` (create one with `connections:write` scope)

**OpenAI API Key**:
- Get from [platform.openai.com/api-keys](https://platform.openai.com/api-keys)

### 3. Deploy to Vercel

1. Fork this repository
2. Connect to Vercel
3. Set environment variables:
   ```bash
   SLACK_BOT_TOKEN=xoxb-your-bot-token
   SLACK_SIGNING_SECRET=your-signing-secret
   SLACK_APP_TOKEN=xapp-your-app-token
   OPENAI_API_KEY=your-openai-key
   ```
4. Deploy!

### 4. Install to Channels

1. Go to any Slack channel
2. Type `/invite @Paper`
3. Start chatting - Paper will automatically create summaries!

## 🔧 Local Development

1. Clone the repository:
   ```bash
   git clone <your-repo>
   cd paper-slack-app
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create `.env` file:
   ```bash
   SLACK_BOT_TOKEN=xoxb-your-bot-token
   SLACK_SIGNING_SECRET=your-signing-secret
   SLACK_APP_TOKEN=xapp-your-app-token
   OPENAI_API_KEY=your-openai-key
   PORT=3000
   NODE_ENV=development
   ```

4. Start development server:
   ```bash
   npm run dev
   ```

## 📋 How It Works

1. **Message Listening**: Listens to all messages in channels where Paper is installed
2. **Smart Batching**: Collects messages for 2 minutes OR until 10 messages accumulate
3. **AI Summarization**: Uses OpenAI GPT-4 to create structured summaries
4. **Canvas Management**: Creates or updates Slack Canvas with the summary
5. **Rate Limiting**: Updates canvas maximum once every 3 minutes per channel

## 🎯 Granola-Style Format

Paper creates summaries with these sections:

- **🗣️ Key Participants**: Main contributors to the discussion
- **💬 Main Discussion Points**: Key topics and conversations
- **✅ Decisions Made**: Clear outcomes and agreements
- **🎯 Action Items**: Tasks and responsibilities
- **📌 Important Notes**: Links, resources, and other relevant info

## 🛡️ Safety Features

- **Debounced Updates**: Prevents canvas spam
- **Message Limits**: Processes max 50 recent messages
- **Error Handling**: Graceful failures with user feedback
- **Memory Cleanup**: Automatic cleanup of old data
- **Rate Limiting**: Built-in delays to respect API limits

## 💡 Usage Tips

- **Manual Updates**: Mention `@Paper summary` to trigger immediate update
- **Channel Integration**: Just add Paper to any channel and it starts working
- **Canvas Access**: Click the "📋 View Summary Canvas" button to see summaries

## 🔧 Configuration

Key settings in `index.js`:

```javascript
const CONFIG = {
  BATCH_TIME_WINDOW: 2 * 60 * 1000,    // 2 minutes
  BATCH_MESSAGE_LIMIT: 10,              // 10 messages
  CANVAS_UPDATE_DEBOUNCE: 3 * 60 * 1000, // 3 minutes
  MAX_MESSAGES_FOR_SUMMARY: 50          // 50 messages max
};
```

## 🚨 Troubleshooting

### Canvas Not Updating
- Check OpenAI API key and credits
- Verify Canvas permissions in Slack app settings
- Look at deployment logs for errors

### Messages Not Being Processed
- Ensure Paper is added to the channel
- Check that bot has `channels:history` permission
- Verify Socket Mode is enabled

### Deployment Issues
- Confirm all environment variables are set
- Check Vercel function logs
- Ensure Node.js version is 18+

## 📄 License

MIT License - feel free to modify and distribute!

## 🤝 Support

- Create GitHub issues for bugs
- Check Slack app logs for errors
- Verify API key permissions and credits 