const { App } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const OpenAI = require('openai');
require('dotenv').config();

console.log('🚀 Paper Enterprise - Multi-Workspace Canvas Summarizer');
console.log('📊 Starting fresh with clean architecture...');
console.log('🎯 VERSION: Paper Enterprise v2.0 (Clean Multi-Workspace Build)');
console.log('⚡️ This is the NEW system - OAuth + Multi-tenant + No duplicates');

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

// Workspace data storage with concurrency protection
const workspaceData = new Map(); // teamId -> { channels: Map(channelId -> data) }
const processingLocks = new Map(); // channelId -> Promise (prevents race conditions)

function getWorkspaceData(teamId) {
  if (!workspaceData.has(teamId)) {
    workspaceData.set(teamId, { channels: new Map() });
    console.log(`🏢 Initialized workspace data for team: ${teamId}`);
  }
  return workspaceData.get(teamId);
}

function getChannelData(teamId, channelId) {
  const workspace = getWorkspaceData(teamId);
  if (!workspace.channels.has(channelId)) {
    workspace.channels.set(channelId, {
      messages: [],
      canvasId: null,
      lastUpdate: Date.now(),
      processing: false
    });
    console.log(`📺 Initialized channel data: ${teamId}/${channelId}`);
  }
  return workspace.channels.get(channelId);
}

// Check if canvas already exists for this channel
async function getExistingCanvasId(teamId, channelId) {
  try {
    const client = await getWorkspaceClient(teamId);
    if (!client) return null;

    const channelInfo = await client.conversations.info({
      channel: channelId,
      include_locale: false
    });
    
    if (channelInfo.channel.properties?.canvas?.document_id) {
      const existingCanvasId = channelInfo.channel.properties.canvas.document_id;
      console.log(`📄 Found existing canvas: ${existingCanvasId} for ${teamId}/${channelId}`);
      
      // Update our local cache
      const channelData = getChannelData(teamId, channelId);
      channelData.canvasId = existingCanvasId;
      
      return existingCanvasId;
    }
    
    return null;
  } catch (error) {
    console.error(`❌ Error checking existing canvas for ${teamId}/${channelId}:`, error.message);
    return null;
  }
}

// Create or update Canvas with race condition protection
async function updateCanvas(teamId, channelId, summaryData) {
  const lockKey = `${teamId}/${channelId}`;
  
  // Prevent concurrent canvas operations for same channel
  if (processingLocks.has(lockKey)) {
    console.log(`⏳ Canvas operation already in progress for ${lockKey}, skipping`);
    return;
  }
  
  try {
    // Set processing lock
    const lockPromise = (async () => {
      const client = await getWorkspaceClient(teamId);
      if (!client) {
        console.error(`❌ No client available for team: ${teamId}`);
        return;
      }

      const channelData = getChannelData(teamId, channelId);
      
      // Check if canvas already exists (both locally and in Slack)
      if (!channelData.canvasId) {
        channelData.canvasId = await getExistingCanvasId(teamId, channelId);
      }

      const canvasContent = createCanvasContent(summaryData);
      const canvasTitle = await generateCanvasTitle(summaryData);

      if (!channelData.canvasId) {
        // Create new Canvas
        console.log(`🎨 Creating NEW Canvas for ${teamId}/${channelId}`);
        
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
          console.log(`✅ Canvas created successfully: ${response.canvas_id}`);
        } else {
          console.error(`❌ Failed to create canvas:`, response.error);
        }
      } else {
        // Update existing Canvas
        console.log(`📝 Updating EXISTING Canvas: ${channelData.canvasId} for ${teamId}/${channelId}`);
        
        const response = await client.apiCall('canvases.edit', {
          canvas_id: channelData.canvasId,
          changes: [{
            operation: 'replace',
            document_content: {
              type: 'markdown',
              markdown: canvasContent
            }
          }]
        });
        
        if (response.ok) {
          console.log(`✅ Canvas updated successfully: ${channelData.canvasId}`);
        } else {
          console.error(`❌ Failed to update canvas:`, response.error);
        }
      }

      channelData.lastUpdate = Date.now();
    })();
    
    processingLocks.set(lockKey, lockPromise);
    await lockPromise;
    
  } catch (error) {
    console.error(`❌ Canvas error for ${teamId}/${channelId}:`, error.message);
  } finally {
    // Always clear the lock
    processingLocks.delete(lockKey);
  }
}

// Process messages and create summary with concurrency protection
async function processMessages(teamId, channelId) {
  const lockKey = `${teamId}/${channelId}`;
  
  try {
    const channelData = getChannelData(teamId, channelId);
    
    // Prevent concurrent processing
    if (channelData.processing) {
      console.log(`⏳ Already processing messages for ${teamId}/${channelId}, skipping`);
      return;
    }
    
    if (channelData.messages.length < 3) {
      console.log(`📝 Channel ${channelId} has only ${channelData.messages.length} messages, need at least 3`);
      return;
    }

    // Set processing flag
    channelData.processing = true;
    console.log(`📊 Processing ${channelData.messages.length} messages for ${teamId}/${channelId}`);
    
    const client = await getWorkspaceClient(teamId);
    if (!client) {
      console.error(`❌ No client available for team: ${teamId}`);
      return;
    }

    // Create a copy of messages to process
    const messagesToProcess = [...channelData.messages];
    
    const summaryData = await generateSummary(messagesToProcess, client);
    await updateCanvas(teamId, channelId, summaryData);

    // Clear processed messages only if no new ones arrived during processing
    if (channelData.messages.length === messagesToProcess.length) {
      channelData.messages = [];
      console.log(`🧹 Cleared ${messagesToProcess.length} processed messages for ${teamId}/${channelId}`);
    } else {
      // Keep newer messages that arrived during processing
      channelData.messages = channelData.messages.slice(messagesToProcess.length);
      console.log(`🔄 Kept ${channelData.messages.length} new messages that arrived during processing`);
    }
    
  } catch (error) {
    console.error(`❌ Error processing messages for ${teamId}/${channelId}:`, error.message);
  } finally {
    // Always clear processing flag
    const channelData = getChannelData(teamId, channelId);
    channelData.processing = false;
  }
}

// Extract team ID from context - enhanced for all event types
function getTeamId(context, event = null) {
  // Priority order: context first, then event, then nested properties
  const candidates = [
    context?.teamId,
    context?.team_id, 
    context?.team,
    event?.team_id,
    event?.team,
    context?.body?.team_id,
    context?.payload?.team_id,
    context?.envelope?.team_id
  ];
  
  const teamId = candidates.find(id => id && typeof id === 'string');
  
  if (!teamId) {
    console.error('🚨 No team ID found in context:', {
      contextKeys: Object.keys(context || {}),
      eventKeys: Object.keys(event || {}),
      contextValues: context,
      eventValues: event
    });
  } else {
    console.log(`🔍 Team ID extracted: ${teamId}`);
  }
  
  return teamId;
}

// Message handler with enhanced team ID extraction
app.message(async ({ message, context }) => {
  try {
    if (message.subtype || message.bot_id) return;

    const teamId = getTeamId(context, message);
    const channelId = message.channel;

    if (!teamId) {
      console.error('🚨 CRITICAL: No team ID found in message - multi-tenant will fail');
      console.error('Context keys:', Object.keys(context || {}));
      console.error('Message keys:', Object.keys(message || {}));
      return;
    }

    console.log(`💬 Message received: ${teamId}/${channelId} from user ${message.user}`);

    const channelData = getChannelData(teamId, channelId);
    channelData.messages.push({
      user: message.user,
      text: message.text,
      timestamp: message.ts
    });

    // Keep only last 100 messages per channel
    if (channelData.messages.length > 100) {
      const removedCount = channelData.messages.length - 100;
      channelData.messages = channelData.messages.slice(-100);
      console.log(`🧹 Trimmed ${removedCount} old messages, keeping last 100`);
    }

    // Process every 10 messages or after 2 minutes
    const timeSinceLastUpdate = Date.now() - channelData.lastUpdate;
    const shouldProcess = channelData.messages.length >= 10 || 
                         timeSinceLastUpdate > (2 * 60 * 1000);

    if (shouldProcess && !channelData.processing) {
      console.log(`🎯 Triggering processing: ${channelData.messages.length} messages, ${Math.round(timeSinceLastUpdate/1000)}s since last update`);
      setTimeout(() => processMessages(teamId, channelId), 1000);
    }
  } catch (error) {
    console.error('❌ Message handler error:', error.message);
  }
});

// App mention handler with enhanced team ID extraction
app.event('app_mention', async ({ event, context, say }) => {
  try {
    console.log('🔍 APP MENTION DEBUG:');
    console.log('   Context keys:', Object.keys(context || {}));
    console.log('   Event keys:', Object.keys(event || {}));
    console.log('   Event text:', event.text);
    console.log('   Event channel:', event.channel);
    console.log('   Event user:', event.user);
    
    const teamId = getTeamId(context, event);
    const channelId = event.channel;

    console.log(`🎯 EXTRACTED TEAM ID: ${teamId}`);
    console.log(`📺 CHANNEL ID: ${channelId}`);

    if (!teamId) {
      console.error('🚨 CRITICAL: No team ID found in app_mention - multi-tenant will fail');
      console.error('🔍 Full context object:', JSON.stringify(context, null, 2));
      console.error('🔍 Full event object:', JSON.stringify(event, null, 2));
      await say("❌ Sorry, I couldn't identify your workspace. Please ensure Paper is properly installed.");
      return;
    }

    console.log(`🏷️ App mention: ${teamId}/${channelId} - "${event.text}"`);

    if (event.text.includes('summary') || event.text.includes('update')) {
      console.log(`📊 Manual summary requested for ${teamId}/${channelId}`);
      
      console.log(`🔍 Looking up workspace client for team: ${teamId}`);
      console.log(`📋 Available installations: ${Array.from(installationStore.installations.keys()).join(', ')}`);
      
      const client = await getWorkspaceClient(teamId);
      if (!client) {
        console.error(`❌ No workspace client for team: ${teamId}`);
        console.error(`📋 Installation store contents:`, Object.fromEntries(installationStore.installations));
        await say(`❌ Sorry, I couldn't connect to your workspace (${teamId}). This workspace may not be properly installed via OAuth. Please visit https://paperforslack.onrender.com/install to install Paper Enterprise.`);
        return;
      }
      
      console.log(`✅ Got workspace client for team: ${teamId}`);

      // Fetch recent messages
      try {
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

          console.log(`📚 Found ${messages.length} valid messages for manual summary`);

          if (messages.length >= 3) {
            const summaryData = await generateSummary(messages, client);
            await updateCanvas(teamId, channelId, summaryData);
            await say(`📄 Canvas updated with summary of ${messages.length} messages! Check the channel canvas for the latest insights.`);
          } else {
            await say("📄 Need at least 3 messages to create a meaningful summary! Have a conversation and try again.");
          }
        } else {
          await say("📄 No messages found in this channel.");
        }
      } catch (fetchError) {
        console.error(`❌ Error fetching messages for ${teamId}/${channelId}:`, fetchError.message);
        await say("❌ Sorry, I couldn't fetch the conversation history. Please check my permissions.");
      }
    } else if (event.text.includes('debug') || event.text.includes('status')) {
      // Debug command to check installation status
      const installations = installationStore.getAllInstallations();
      const currentInstallation = installations.find(inst => inst.teamId === teamId);
      
      await say(`📊 **Paper Enterprise Debug Info**\n\n**Team ID:** ${teamId}\n**Channel:** ${channelId}\n**Installation Status:** ${currentInstallation ? '✅ Installed' : '❌ Not Found'}\n**Total Installations:** ${installations.length}\n\n${currentInstallation ? 'Ready to create summaries!' : 'Please install via https://paperforslack.onrender.com/install'}`);
    } else {
      await say("📄 Hi! I'm **Paper Enterprise** - I create Canvas summaries of conversations.\n\nMention me with:\n• `@Paper summary` - Create manual summary\n• `@Paper debug` - Check installation status\n\nOr just have conversations and I'll automatically create summaries every 10 messages or 2 minutes!");
    }
  } catch (error) {
    console.error('❌ App mention error:', error.message);
    await say("❌ Sorry, something went wrong. Please try again or contact support.");
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
      
      // Force HTTPS for production (Render always serves over HTTPS)
      const protocol = process.env.NODE_ENV === 'production' ? 'https' : req.protocol;
      const redirectUri = encodeURIComponent(`${protocol}://${req.get('host')}/slack/oauth_redirect`);
      
      const installUrl = `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${redirectUri}`;
      console.log(`🔗 OAuth install URL: ${installUrl}`);
      res.redirect(installUrl);
    }));

    // OAuth callback - handle both automatic and manual flows
    httpApp.get('/slack/oauth_redirect', async (req, res) => {
      try {
        console.log('🔄 OAuth callback received:', { 
          code: req.query.code ? 'present' : 'missing',
          state: req.query.state,
          error: req.query.error 
        });

        const { code, state, error } = req.query;
        
        if (error) {
          console.error('❌ OAuth error:', error);
          return res.status(400).send(`
            <!DOCTYPE html>
            <html>
              <head><title>Paper Enterprise - Error</title></head>
              <body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; text-align: center; padding: 50px;">
                <h1>❌ Installation Failed</h1>
                <p>OAuth error: ${error}</p>
                <a href="/install">Try Again</a>
              </body>
            </html>
          `);
        }

        if (!code) {
          console.error('❌ No authorization code received');
          return res.status(400).send(`
            <!DOCTYPE html>
            <html>
              <head><title>Paper Enterprise - Error</title></head>
              <body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; text-align: center; padding: 50px;">
                <h1>❌ Missing Authorization Code</h1>
                <p>The OAuth flow didn't complete properly.</p>
                <a href="/install">Try Again</a>
              </body>
            </html>
          `);
        }

        // Exchange code for tokens
        console.log('🔄 Exchanging OAuth code for tokens...');
        const { WebClient } = require('@slack/web-api');
        const oauthClient = new WebClient();
        
        // Force HTTPS for production (Render always serves over HTTPS)
        const protocol = process.env.NODE_ENV === 'production' ? 'https' : req.protocol;
        const redirectUri = `${protocol}://${req.get('host')}/slack/oauth_redirect`;
        
        console.log(`🔗 Using redirect URI: ${redirectUri}`);
        
        const result = await oauthClient.oauth.v2.access({
          client_id: process.env.SLACK_CLIENT_ID,
          client_secret: process.env.SLACK_CLIENT_SECRET,
          code: code,
          redirect_uri: redirectUri
        });

        if (result.ok) {
          console.log('✅ OAuth token exchange successful');
          
          // Store installation
          const installation = {
            team: { id: result.team.id, name: result.team.name },
            bot: {
              token: result.access_token,
              scopes: result.scope?.split(',') || [],
              id: result.bot_user_id,
              userId: result.bot_user_id
            },
            user: { 
              token: result.authed_user?.access_token || result.access_token, 
              id: result.authed_user?.id 
            },
            appId: result.app_id,
            installedAt: new Date().toISOString()
          };

          await installationStore.storeInstallation(installation);
          console.log(`🎉 Installation stored for team: ${result.team.name} (${result.team.id})`);

          // Success page
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
                  p { font-size: 18px; color: #6e6e73; line-height: 1.5; margin-bottom: 16px; }
                  .team-info { background: #f8f9fa; padding: 16px; border-radius: 8px; margin: 20px 0; }
                  .next-steps { text-align: left; margin-top: 24px; }
                  .step { margin: 8px 0; }
                </style>
              </head>
              <body>
                <div class="container">
                  <div class="success">🎉</div>
                  <h1>Paper Enterprise Installed!</h1>
                  <div class="team-info">
                    <strong>Workspace:</strong> ${result.team.name}<br>
                    <strong>Team ID:</strong> ${result.team.id}
                  </div>
                  <p>Your workspace is now connected to Paper Enterprise!</p>
                  
                  <div class="next-steps">
                    <strong>Next Steps:</strong>
                    <div class="step">1. Add Paper to any channel</div>
                    <div class="step">2. Have a conversation (3+ messages)</div>
                    <div class="step">3. Watch Canvas summaries appear automatically!</div>
                  </div>
                </div>
              </body>
            </html>
          `);
        } else {
          console.error('❌ OAuth token exchange failed:', result);
          res.status(400).send(`
            <!DOCTYPE html>
            <html>
              <head><title>Paper Enterprise - Error</title></head>
              <body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; text-align: center; padding: 50px;">
                <h1>❌ Installation Failed</h1>
                <p>Failed to exchange OAuth tokens.</p>
                <a href="/install">Try Again</a>
              </body>
            </html>
          `);
        }
      } catch (error) {
        console.error('❌ OAuth callback error:', error);
        res.status(500).send(`
          <!DOCTYPE html>
          <html>
            <head><title>Paper Enterprise - Error</title></head>
            <body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; text-align: center; padding: 50px;">
              <h1>❌ Installation Error</h1>
              <p>Something went wrong during installation.</p>
              <a href="/install">Try Again</a>
            </body>
          </html>
        `);
      }
    });

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