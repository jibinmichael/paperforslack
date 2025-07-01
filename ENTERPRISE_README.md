# 📄 Paper Enterprise

**Clean, scalable multi-workspace Slack Canvas summarizer built from scratch.**

## 🎯 What's New

- ✅ **Pure OAuth Multi-Workspace** - No complexity, just enterprise scale
- ✅ **Clean Architecture** - Built from scratch, no legacy code
- ✅ **Same Canvas Format** - Granola-style formatting you love
- ✅ **Unlimited Workspaces** - Install in any number of Slack workspaces
- ✅ **Enterprise Ready** - Production-grade error handling and monitoring

## 🚀 Quick Start

### Environment Variables
```bash
SLACK_CLIENT_ID=your_client_id
SLACK_CLIENT_SECRET=your_client_secret
SLACK_SIGNING_SECRET=your_signing_secret
SLACK_APP_TOKEN=your_app_token
OPENAI_API_KEY=your_openai_key
```

### Run Locally
```bash
npm run enterprise
```

### Deploy to Production
```bash
# Update Procfile already points to paper-enterprise.js
git push origin main
```

## 🏗️ Architecture

```
📄 Paper Enterprise
├── EnterpriseInstallationStore    # Multi-workspace OAuth management
├── Workspace Client Factory       # Per-workspace Slack clients
├── Canvas Engine                  # Same formatting, clean code
├── Message Processing             # Batch processing & triggers
└── HTTP Endpoints                 # Installation & monitoring
```

## 🔄 How It Works

1. **Installation**: Users visit `/install` → OAuth flow → Workspace added
2. **Message Processing**: 10 messages or 2 minutes → Canvas update
3. **Canvas Creation**: Granola-style format with real usernames
4. **Multi-Workspace**: Each workspace gets isolated data & client

## 📊 Key Features

### Enterprise OAuth
- Proper installation store
- Per-workspace token management
- Clean installation flow
- Unlimited workspace scale

### Canvas Intelligence
- Real user names (not IDs)
- Timezone-aware timestamps  
- Action items with checkboxes
- Granola-style formatting
- Smart content organization

### Production Ready
- Error isolation per workspace
- Comprehensive logging
- Health monitoring endpoints
- Graceful failure handling

## 🌐 Endpoints

- `/` - Health check & basic info
- `/status` - Workspace installations & stats
- `/install` - Beautiful installation page
- `/slack/install` - OAuth installation flow
- `/slack/oauth_redirect` - OAuth callback

## 🔧 Development

### Run Enterprise App
```bash
npm run enterprise
```

### Run Original App (for comparison)
```bash
npm start
```

### Environment Setup
1. Copy your existing `.env` file (same variables work)
2. Ensure OAuth app settings in Slack match the scopes
3. Update redirect URL to include `/slack/oauth_redirect`

## 📈 Monitoring

The app provides comprehensive logging:
- `✅ Workspace installed` - New workspace added
- `🔍 Found installation` - Workspace authentication success  
- `📊 Processing X messages` - Canvas generation triggered
- `🎨 Creating Canvas` / `📝 Updating Canvas` - Canvas operations
- `❌` prefixed logs - Error conditions

## 🎨 Canvas Format

Same beautiful Granola-style format:
- 🗣️ **Key Participants**
- 💬 **Main Discussion Points**
- ✅ **Decisions & Agreements**  
- 🎯 **Action Items & Next Steps**
- 📌 **Key Insights & Resources**
- 🔍 **Context & Background**

## 🚀 Deployment

1. **Update Environment**: Set OAuth variables in Render/deployment platform
2. **Deploy**: App automatically uses `paper-enterprise.js` (Procfile updated)
3. **Install**: Share installation URL with teams
4. **Scale**: No limits on workspace installations

## 🔍 Troubleshooting

### Common Issues
- **"No installation found"**: Workspace needs to install via `/install`
- **Username numbers**: OAuth client authentication issue
- **Canvas not creating**: Check Canvas permissions in Slack app settings

### Logs to Check
```bash
✅ Environment variables validated
✅ Multi-workspace Slack app initialized  
⚡️ Paper Enterprise connected via Socket Mode!
🔍 Found installation: TEAM_ID
```

## 🎯 Next Steps

1. **Database Integration**: Replace in-memory store with Redis/PostgreSQL
2. **Analytics**: Add workspace usage metrics
3. **Advanced Features**: Custom Canvas templates, scheduling
4. **Enterprise SSO**: SAML/OIDC integration for large orgs

---

**Paper Enterprise** - The clean, scalable Slack Canvas summarizer you deserve. 🎉 