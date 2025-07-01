const { App } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const OpenAI = require('openai');
require('dotenv').config();

console.log('🚀 Paper Enterprise - Multi-Workspace Canvas Summarizer');
console.log('📊 Starting fresh with clean architecture...');

// Validate environment
const requiredEnvVars = {
  SLACK_CLIENT_ID: process.env.SLACK_CLIENT_ID,
  SLACK_CLIENT_SECRET: process.env.SLACK_CLIENT_SECRET,
  SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
  SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY
};

for (const [key, value] of Object.entries(requiredEnvVars)) {
  if (!value) {
    console.error(`❌ Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

console.log('✅ Environment variables validated');

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Enterprise Installation Store (in-memory for now, easily replaceable with DB)
class EnterpriseInstallationStore {
  constructor() {
    this.installations = new Map();
  }

  async storeInstallation(installation) {
    const teamId = installation.team?.id;
    if (teamId) {
      this.installations.set(teamId, {
        ...installation,
        installedAt: new Date().toISOString()
      });
      console.log(`✅ Workspace installed: ${installation.team?.name} (${teamId})`);
    }
    return installation;
  }

  async fetchInstallation(query) {
    const teamId = query.teamId || query.enterpriseId;
    const installation = this.installations.get(teamId);
    
    if (installation) {
      console.log(`🔍 Found installation: ${teamId}`);
      return installation;
    }
    
    console.log(`❌ No installation found: ${teamId}`);
    console.log(`📋 Available workspaces: ${Array.from(this.installations.keys()).join(', ')}`);
    return null;
  }

  async deleteInstallation(query) {
    const teamId = query.teamId || query.enterpriseId;
    this.installations.delete(teamId);
    console.log(`🗑️ Uninstalled workspace: ${teamId}`);
  }

  // Get all installations
  getAllInstallations() {
    return Array.from(this.installations.entries()).map(([teamId, installation]) => ({
      teamId,
      teamName: installation.team?.name || 'Unknown',
      installedAt: installation.installedAt,
      scopes: installation.bot?.scopes || []
    }));
  }
}

const installationStore = new EnterpriseInstallationStore();

// App configuration
const app = new App({
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  stateSecret: process.env.SLACK_STATE_SECRET || 'paper-enterprise-state',
  scopes: [
    'channels:read',
    'channels:history', 
    'chat:write',
    'chat:write.public',
    'app_mentions:read',
    'canvases:write',
    'canvases:read',
    'users:read',
    'team:read',
    'groups:read',
    'groups:history',
    'im:write',
    'mpim:write'
  ],
  installationStore,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  installerOptions: {
    directInstall: true,
    stateVerification: false
  }
});

console.log('✅ Multi-workspace Slack app initialized');

// Enterprise client factory
async function getWorkspaceClient(teamId) {
  try {
    const installation = await installationStore.fetchInstallation({ teamId });
    if (installation?.bot?.token) {
      return new WebClient(installation.bot.token);
    }
    console.error(`❌ No bot token for workspace: ${teamId}`);
    return null;
  } catch (error) {
    console.error(`❌ Error getting client for ${teamId}:`, error.message);
    return null;
  }
}

// Canvas formatting (same as before - keeping what works!)
const GRANOLA_PROMPT = `
You are creating a conversation summary in Granola-style format, optimized for Slack Canvas display. 

**Canvas Formatting Guidelines:**
- Use clean, scannable structure with clear headers
- Include emojis for visual hierarchy
- Focus on actionable insights and key decisions
- Use bullet points and numbered lists effectively
- Include participant context when relevant
- Highlight outcomes, next steps, and important information

**Format the summary exactly as follows:**

## 🗣️ **Key Participants**
- **Real Name**: Their key contributions and role in discussion
- Focus on who drove decisions or important discussions

## 💬 **Main Discussion Points**  
- **Topic 1**: Key insights and context
- **Topic 2**: Important discussions and viewpoints
- Use bullet sub-points for details when needed

## ✅ **Decisions & Agreements**
- **Decision 1**: What was decided and why
- **Decision 2**: Any agreements or conclusions reached
- Include decision owners when mentioned

## 🎯 **Action Items & Next Steps**
- [ ] **Real Name**: Specific task or responsibility with checkbox for tracking
- [ ] **Timeline**: Any deadlines or timeframes mentioned with checkbox
- [ ] **Follow-up**: Required next steps or meetings with interactive checkbox

## 📌 **Key Insights & Resources**
> Important quotes or standout insights
- Key insights and takeaways
- Context that might be valuable later

## 🔍 **Context & Background**
- Why this conversation happened
- Any background context that's important
- Related previous discussions or decisions

**Important**: 
- Use clickable user mentions <@USER_ID> instead of names
- Use blockquotes (>) for standout insights or important quotes
- If the conversation is brief or lacks substantial content, focus on what WAS discussed
- Always provide value even for short conversations
- Use clear, professional language
- Structure for easy scanning and future reference

Summarize this Slack conversation:
`;

// Get user names for better formatting
async function getUserNames(userIds, client) {
  const userNames = {};
  let userTimezone = 'America/New_York';
  
  for (const userId of [...new Set(userIds)]) {
    try {
      const userInfo = await client.users.info({ user: userId });
      userNames[userId] = userInfo.user.real_name || userInfo.user.display_name || userInfo.user.name;
      
      if (userInfo.user.tz && userTimezone === 'America/New_York') {
        userTimezone = userInfo.user.tz;
      }
    } catch (error) {
      console.log(`⚠️ Cannot fetch user info for ${userId}, using fallback`);
      userNames[userId] = `User ${userId.substring(0,8)}`;
    }
  }
  
  return { userNames, userTimezone };
}

// Generate AI summary
async function generateSummary(messages, client) {
  try {
    console.log(`📝 Generating summary from ${messages.length} messages`);
    
    const userIds = messages.map(msg => msg.user);
    const { userNames, userTimezone } = await getUserNames(userIds, client);
    
    const conversationText = messages.map(msg => 
      `${userNames[msg.user] || msg.user}: ${msg.text}`
    ).join('\n');

    const enhancedPrompt = GRANOLA_PROMPT + `

**USER MAPPING FOR NAMES:**
${Object.entries(userNames).map(([id, name]) => `${id} = ${name} → use **${name}**`).join('\n')}

**CONVERSATION CONTEXT:**
- Complete conversation with ${messages.length} messages
- Focus on key decisions, action items, and insights`;

    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: enhancedPrompt },
        { role: "user", content: conversationText }
      ],
      max_tokens: 1500,
      temperature: 0.3
    });

    return {
      summary: response.choices[0].message.content,
      userTimezone,
      messageCount: messages.length
    };
  } catch (error) {
    console.error('❌ Error generating summary:', error.message);
    return {
      summary: "❌ Error generating summary. Please try again later.",
      userTimezone: 'America/New_York',
      messageCount: messages.length
    };
  }
}

// Create Canvas content
function createCanvasContent(summaryData, userTimezone = 'America/New_York') {
  const now = new Date();
  const timeString = now.toLocaleString('en-US', {
    timeZone: userTimezone,
    weekday: 'short',
    year: 'numeric', 
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  });

  return summaryData.summary + `\n\n---

*🤖 Auto-generated by Paper Enterprise • ${timeString}*
*📊 Summarized ${summaryData.messageCount} messages*`;
}

// Generate Canvas title
async function generateCanvasTitle(summaryData) {
  try {
    const titlePrompt = `Based on this conversation summary, generate a SHORT title (max 6 words) that captures the main topic. Return ONLY the title:

${summaryData.summary.substring(0, 500)}...`;

    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: titlePrompt }],
      max_tokens: 50,
      temperature: 0.3
    });

    return response.choices[0].message.content.trim().replace(/^["']|["']$/g, '');
  } catch (error) {
    console.error('❌ Error generating title:', error.message);
    return "Conversation Summary";
  }
}

// Workspace data storage
const workspaceData = new Map(); // teamId -> { channels: Map(channelId -> data) }

function getWorkspaceData(teamId) {
  if (!workspaceData.has(teamId)) {
    workspaceData.set(teamId, { channels: new Map() });
  }
  return workspaceData.get(teamId);
}

function getChannelData(teamId, channelId) {
  const workspace = getWorkspaceData(teamId);
  if (!workspace.channels.has(channelId)) {
    workspace.channels.set(channelId, {
      messages: [],
      canvasId: null,
      lastUpdate: Date.now()
    });
  }
  return workspace.channels.get(channelId);
}

// Create or update Canvas
async function updateCanvas(teamId, channelId, summaryData) {
  try {
    const client = await getWorkspaceClient(teamId);
    if (!client) return;

    const channelData = getChannelData(teamId, channelId);
    const canvasContent = createCanvasContent(summaryData);
    const canvasTitle = await generateCanvasTitle(summaryData);

    if (!channelData.canvasId) {
      // Create new Canvas
      console.log(`🎨 Creating Canvas for ${teamId}/${channelId}`);
      
      const response = await client.apiCall('conversations.canvases.create', {
        channel_id: channelId,
        title: canvasTitle,
        document_content: {
          type: 'markdown',
          markdown: canvasContent
        }
      });

      if (response.ok) {
        channelData.canvasId = response.canvas_id;
        console.log(`✅ Canvas created: ${response.canvas_id}`);
      }
    } else {
      // Update existing Canvas
      console.log(`📝 Updating Canvas: ${channelData.canvasId}`);
      
      await client.apiCall('canvases.edit', {
        canvas_id: channelData.canvasId,
        changes: [{
          operation: 'replace',
          document_content: {
            type: 'markdown',
            markdown: canvasContent
          }
        }]
      });
      
      console.log(`✅ Canvas updated: ${channelData.canvasId}`);
    }

    channelData.lastUpdate = Date.now();
  } catch (error) {
    console.error(`❌ Canvas error for ${teamId}/${channelId}:`, error.message);
  }
}

// Process messages and create summary
async function processMessages(teamId, channelId) {
  try {
    const channelData = getChannelData(teamId, channelId);
    
    if (channelData.messages.length < 3) {
      console.log(`📝 Channel ${channelId} has only ${channelData.messages.length} messages, need at least 3`);
      return;
    }

    console.log(`📊 Processing ${channelData.messages.length} messages for ${teamId}/${channelId}`);
    
    const client = await getWorkspaceClient(teamId);
    if (!client) return;

    const summaryData = await generateSummary(channelData.messages, client);
    await updateCanvas(teamId, channelId, summaryData);

    // Clear processed messages
    channelData.messages = [];
  } catch (error) {
    console.error(`❌ Error processing messages for ${teamId}/${channelId}:`, error.message);
  }
}

// Extract team ID from context
function getTeamId(context) {
  return context.teamId || context.team_id || context.team || null;
}

// Message handler
app.message(async ({ message, context }) => {
  try {
    if (message.subtype || message.bot_id) return;

    const teamId = getTeamId(context);
    const channelId = message.channel;

    if (!teamId) {
      console.log('⚠️ No team ID found in message context');
      return;
    }

    console.log(`💬 Message in ${teamId}/${channelId}`);

    const channelData = getChannelData(teamId, channelId);
    channelData.messages.push({
      user: message.user,
      text: message.text,
      timestamp: message.ts
    });

    // Keep only last 100 messages per channel
    if (channelData.messages.length > 100) {
      channelData.messages = channelData.messages.slice(-100);
    }

    // Process every 10 messages or after 2 minutes
    const shouldProcess = channelData.messages.length >= 10 || 
                         (Date.now() - channelData.lastUpdate) > (2 * 60 * 1000);

    if (shouldProcess) {
      setTimeout(() => processMessages(teamId, channelId), 1000);
    }
  } catch (error) {
    console.error('❌ Message handler error:', error.message);
  }
});

// App mention handler
app.event('app_mention', async ({ event, context, say }) => {
  try {
    const teamId = getTeamId(context);
    const channelId = event.channel;

    if (!teamId) {
      await say("❌ Sorry, I couldn't identify your workspace.");
      return;
    }

    if (event.text.includes('summary') || event.text.includes('update')) {
      console.log(`🏷️ Manual summary requested in ${teamId}/${channelId}`);
      
      const client = await getWorkspaceClient(teamId);
      if (!client) {
        await say("❌ Sorry, I couldn't connect to your workspace.");
        return;
      }

      // Fetch recent messages
      const result = await client.conversations.history({
        channel: channelId,
        limit: 100,
        exclude_archived: true
      });

      if (result.messages && result.messages.length > 0) {
        const messages = result.messages
          .filter(msg => !msg.bot_id && !msg.subtype && msg.text)
          .reverse()
          .map(msg => ({
            user: msg.user,
            text: msg.text,
            timestamp: msg.ts
          }));

        if (messages.length >= 3) {
          const summaryData = await generateSummary(messages, client);
          await updateCanvas(teamId, channelId, summaryData);
          await say(`📄 Canvas updated with summary of ${messages.length} messages!`);
        } else {
          await say("📄 Need at least 3 messages to create a meaningful summary!");
        }
      } else {
        await say("📄 No messages found in this channel.");
      }
    } else {
      await say("📄 Hi! I'm **Paper Enterprise** - I create Canvas summaries of conversations. Mention me with 'summary' to update manually!");
    }
  } catch (error) {
    console.error('❌ App mention error:', error.message);
    await say("❌ Sorry, something went wrong. Please try again.");
  }
});

// Error handling
app.error((error) => {
  console.error('❌ Slack app error:', error.message);
});

// Start the app
(async () => {
  try {
    console.log('🚀 Starting Paper Enterprise...');
    
    // Start HTTP server for OAuth
    const express = require('express');
    const httpApp = express();
    const port = process.env.PORT || 10000;

    // CORS
    httpApp.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
      next();
    });

    // Health check
    httpApp.get('/', (req, res) => {
      res.json({
        app: 'Paper Enterprise',
        status: 'healthy',
        mode: 'Multi-Workspace OAuth',
        workspaces: installationStore.getAllInstallations().length,
        timestamp: new Date().toISOString()
      });
    });

    // Status endpoint
    httpApp.get('/status', (req, res) => {
      const workspaces = installationStore.getAllInstallations();
      res.json({
        app: 'Paper Enterprise',
        status: 'running',
        workspaces: workspaces.length,
        installations: workspaces,
        timestamp: new Date().toISOString()
      });
    });

    // OAuth installation
    httpApp.get('/slack/install', app.installer?.handleInstallPath?.bind(app.installer) || ((req, res) => {
      const clientId = process.env.SLACK_CLIENT_ID;
      const scopes = encodeURIComponent('channels:read,channels:history,chat:write,chat:write.public,app_mentions:read,canvases:write,canvases:read,users:read,team:read,groups:read,groups:history,im:write,mpim:write');
      const redirectUri = encodeURIComponent(`${req.protocol}://${req.get('host')}/slack/oauth_redirect`);
      
      const installUrl = `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${redirectUri}`;
      res.redirect(installUrl);
    }));

    // OAuth callback
    httpApp.get('/slack/oauth_redirect', app.installer?.handleCallback?.bind(app.installer) || ((req, res) => {
      res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Paper Enterprise - Success!</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
                     background: #f5f5f7; min-height: 100vh; display: flex; align-items: center; 
                     justify-content: center; margin: 0; color: #1d1d1f; }
              .container { max-width: 480px; background: white; padding: 48px; border-radius: 18px; 
                          text-align: center; box-shadow: 0 4px 16px rgba(0,0,0,0.04); }
              .success { font-size: 64px; margin-bottom: 24px; }
              h1 { font-size: 28px; font-weight: 700; margin-bottom: 16px; }
              p { font-size: 18px; color: #6e6e73; line-height: 1.5; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="success">🎉</div>
              <h1>Paper Enterprise Installed!</h1>
              <p>Your workspace is now connected. Add Paper to any channel and start having conversations to see Canvas summaries in action!</p>
            </div>
          </body>
        </html>
      `);
    }));

    // Installation page
    httpApp.get('/install', (req, res) => {
      res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Paper Enterprise</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
                     background: #f5f5f7; min-height: 100vh; display: flex; align-items: center; 
                     justify-content: center; margin: 0; color: #1d1d1f; }
              .container { max-width: 480px; background: white; padding: 48px; border-radius: 18px; 
                          text-align: center; box-shadow: 0 4px 16px rgba(0,0,0,0.04); }
              .logo { font-size: 48px; margin-bottom: 16px; }
              h1 { font-size: 32px; font-weight: 700; margin-bottom: 16px; }
              p { font-size: 18px; color: #6e6e73; margin-bottom: 32px; line-height: 1.5; }
              .install-button { display: inline-block; background: #4285f4; color: white; 
                               padding: 16px 32px; border-radius: 12px; text-decoration: none; 
                               font-weight: 600; font-size: 16px; transition: all 0.2s ease; }
              .install-button:hover { background: #3367d6; transform: translateY(-1px); }
              .features { margin-top: 40px; text-align: left; }
              .feature { margin-bottom: 12px; font-size: 16px; color: #1d1d1f; }
              .feature::before { content: "✨"; margin-right: 8px; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="logo">📄</div>
              <h1>Paper Enterprise</h1>
              <p>Multi-workspace AI Canvas conversation summarizer. Clean architecture, unlimited scalability.</p>
              
              <a href="/slack/install" class="install-button">Add to Slack</a>
              
              <div class="features">
                <div class="feature">Enterprise multi-workspace support</div>
                <div class="feature">Real-time Canvas summaries</div>
                <div class="feature">Smart action item tracking</div>
                <div class="feature">Granola-style formatting</div>
                <div class="feature">Clean, scalable architecture</div>
              </div>
            </div>
          </body>
        </html>
      `);
    });

    // Start HTTP server
    httpApp.listen(port, '0.0.0.0', () => {
      console.log(`🌐 HTTP server running on port ${port}`);
      console.log(`📍 Installation: https://paperforslack.onrender.com/install`);
      console.log(`📊 Status: https://paperforslack.onrender.com/status`);
    });

    // Start Slack app
    await app.start();
    console.log('⚡️ Paper Enterprise connected via Socket Mode!');
    console.log('🎯 Multi-workspace OAuth ready for unlimited scale!');
    
  } catch (error) {
    console.error('❌ Failed to start Paper Enterprise:', error.message);
    process.exit(1);
  }
})(); 