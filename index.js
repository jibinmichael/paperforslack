const { App } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const OpenAI = require('openai');
const path = require('path');
const fs = require('fs');

// Debug environment loading
console.log('🔍 Debug Info:');
console.log('   Current working directory:', process.cwd());
console.log('   __dirname:', __dirname);
console.log('   Looking for .env at:', path.join(process.cwd(), '.env'));
console.log('   .env file exists:', fs.existsSync('.env'));

if (fs.existsSync('.env')) {
  const envContent = fs.readFileSync('.env', 'utf8');
  const lines = envContent.split('\n').filter(line => line.trim() && !line.startsWith('#'));
  console.log('   .env file has', lines.length, 'non-empty lines');
  console.log('   First few variable names:', lines.slice(0, 3).map(line => line.split('=')[0]));
}

// Load environment variables
const dotenvResult = require('dotenv').config();
console.log('   dotenv result:', dotenvResult.error ? `Error: ${dotenvResult.error}` : `Loaded ${Object.keys(dotenvResult.parsed || {}).length} variables`);

// Production debugging - check if vars are available from environment
console.log('🌐 Production environment check:');
console.log('   NODE_ENV:', process.env.NODE_ENV);
console.log('   Platform detected env vars:', ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_APP_TOKEN', 'OPENAI_API_KEY'].map(key => `${key}: ${process.env[key] ? '✅' : '❌'}`).join(', '));

// Validate required environment variables
function validateEnvironmentVariables() {
  const required = [
    'SLACK_BOT_TOKEN',
    'SLACK_SIGNING_SECRET', 
    'SLACK_APP_TOKEN',
    'OPENAI_API_KEY'
  ];
  
  // Debug: Show what we actually have
  console.log('🔍 Environment variable status:');
  required.forEach(key => {
    const value = process.env[key];
    const status = value ? '✅' : '❌';
    const preview = value ? `${value.substring(0, 10)}...` : 'undefined';
    console.log(`   ${status} ${key}: ${preview}`);
  });
  
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error('\n❌ Missing required environment variables:');
    missing.forEach(key => console.error(`   - ${key}`));
    console.error('\n📋 Check your .env file format. Each line should be:');
    console.error('VARIABLE_NAME=value');
    console.error('(no spaces around the = sign)');
    console.error('\n💡 Common .env file issues:');
    console.error('   - Extra spaces around = sign');
    console.error('   - Quotes around values (remove them)');
    console.error('   - Empty lines with just variable names');
    console.error('   - File saved with wrong encoding');
    console.error('\n🔗 Get Slack tokens from: https://api.slack.com/apps');
    process.exit(1);
  }
  
  console.log('✅ Environment variables validated');
}

// Validate environment on startup
validateEnvironmentVariables();

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Multi-workspace token storage (MUST be defined before App constructor)
const installationStore = {
  installations: new Map(), // teamId -> installation data
  
  async storeInstallation(installation) {
    const teamId = installation.team?.id;
    if (teamId) {
      this.installations.set(teamId, installation);
      console.log(`✅ Stored installation for workspace: ${teamId}`);
    }
  },
  
  async fetchInstallation(installQuery) {
    const teamId = installQuery.teamId;
    const installation = this.installations.get(teamId);
    if (installation) {
      console.log(`🔍 Found installation for workspace: ${teamId}`);
      return installation;
    }
    console.log(`❌ No installation found for workspace: ${teamId}`);
    return undefined;
  },
  
  async deleteInstallation(installQuery) {
    const teamId = installQuery.teamId;
    this.installations.delete(teamId);
    console.log(`🗑️ Deleted installation for workspace: ${teamId}`);
  }
};

// Initialize Slack app with conditional OAuth support
const hasOAuthCreds = process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET && 
                     process.env.SLACK_CLIENT_ID.trim() !== '' && process.env.SLACK_CLIENT_SECRET.trim() !== '';

console.log('🔍 OAuth Credential Check:');
console.log(`   SLACK_CLIENT_ID: ${process.env.SLACK_CLIENT_ID ? `${process.env.SLACK_CLIENT_ID.substring(0, 10)}...` : 'NOT SET'}`);
console.log(`   SLACK_CLIENT_SECRET: ${process.env.SLACK_CLIENT_SECRET ? `${process.env.SLACK_CLIENT_SECRET.substring(0, 10)}...` : 'NOT SET'}`);
console.log(`   Valid OAuth credentials: ${hasOAuthCreds}`);

console.log(`🔧 App Configuration Mode: ${hasOAuthCreds ? 'Multi-Workspace OAuth' : 'Single-Workspace Token'}`);
if (hasOAuthCreds) {
  console.log('✅ OAuth credentials detected - enabling multi-workspace support');
} else {
  console.log('⚠️ OAuth credentials missing/invalid - falling back to single-workspace mode');
  console.log('   To enable multi-workspace support, add valid SLACK_CLIENT_ID and SLACK_CLIENT_SECRET to environment');
}

const appConfig = {
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  port: process.env.PORT || 10000,
};

// Add OAuth configuration only if credentials are available
if (hasOAuthCreds) {
  appConfig.installationStore = installationStore;
  appConfig.oauth = {
    clientId: process.env.SLACK_CLIENT_ID,
    clientSecret: process.env.SLACK_CLIENT_SECRET,
    stateSecret: 'paper-oauth-state-secret-key',
    redirectUri: process.env.SLACK_OAUTH_REDIRECT_URI || 'https://paperforslack.onrender.com/slack/oauth/callback'
  };
  
  // Add authorize function for OAuth mode
  appConfig.authorize = async (source, body) => {
    const teamId = source.teamId;
    console.log('🔍 Authorizing request for team:', teamId);
    
    const installation = await installationStore.fetchInstallation({
      teamId: teamId,
    });
    
    if (installation) {
      console.log('🔍 Using bot token for API call:', installation.bot.token ? installation.bot.token.substring(0, 15) + '...' : 'MISSING');
      return {
        botToken: installation.bot.token,
        botId: installation.bot.userId,
        botUserId: installation.bot.userId,
      };
    }
    
    console.log('❌ No installation found for workspace:', teamId);
    throw new Error(`No installation found for team ${teamId}`);
  };
} else {
  // Fall back to token-based mode for single workspace
  appConfig.token = process.env.SLACK_BOT_TOKEN;
}

// Initialize App with automatic fallback to token mode if OAuth fails
let app;
let isOAuthMode = false;

try {
  console.log('🚀 Attempting to initialize Slack App...');
  app = new App(appConfig);
  isOAuthMode = hasOAuthCreds; // Track if we're actually in OAuth mode
  console.log('✅ Slack App initialized successfully');
} catch (error) {
  if (hasOAuthCreds && error.code === 'slack_bolt_app_initialization_error') {
    console.log('❌ OAuth initialization failed, falling back to token mode...');
    console.log('   Error:', error.message);
    console.log('🔄 Retrying with single-workspace token configuration...');
    
    // Fallback to token mode
    const tokenConfig = {
      token: process.env.SLACK_BOT_TOKEN,
      signingSecret: process.env.SLACK_SIGNING_SECRET,
      socketMode: true,
      appToken: process.env.SLACK_APP_TOKEN,
      port: process.env.PORT || 10000,
    };
    
    app = new App(tokenConfig);
    isOAuthMode = false; // We fell back to token mode
    console.log('✅ Slack App initialized in token mode (single-workspace)');
  } else {
    console.error('❌ Failed to initialize Slack App:', error);
    throw error; // Re-throw if it's not an OAuth issue
  }
}

// Bootstrap existing workspace installation (only needed for OAuth mode)
if (isOAuthMode && process.env.SLACK_BOT_TOKEN) {
  // Detect the real workspace info for the existing token
  const detectExistingWorkspace = async () => {
    try {
      // Wait a bit to ensure Socket Mode is fully established
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      console.log('🔄 Starting workspace migration...');
      const webClient = new WebClient(process.env.SLACK_BOT_TOKEN);
      const teamInfo = await webClient.team.info();
      const authTest = await webClient.auth.test();
      
      const existingInstallation = {
        team: { 
          id: teamInfo.team.id,
          name: teamInfo.team.name 
        },
        bot: {
          token: process.env.SLACK_BOT_TOKEN,
          scopes: ['channels:read', 'channels:history', 'chat:write', 'chat:write.public', 'app_mentions:read', 'canvases:write', 'canvases:read', 'im:write', 'mpim:write', 'groups:read', 'groups:history', 'users:read', 'team:read'],
          userId: authTest.user_id
        },
        installedAt: new Date().toISOString()
      };
      
      await installationStore.storeInstallation(existingInstallation);
      console.log('✅ Stored installation for workspace:', teamInfo.team.id);
      console.log('🔄 Migrated existing workspace to OAuth store:', teamInfo.team.name, `(${teamInfo.team.id})`);
    } catch (error) {
      console.error('❌ Could not detect existing workspace info:', error.message);
      // Fallback to placeholder installation
      const fallbackInstallation = {
        team: { id: 'EXISTING_WORKSPACE', name: 'Legacy Workspace' },
        bot: {
          token: process.env.SLACK_BOT_TOKEN,
          scopes: ['channels:read', 'channels:history', 'chat:write', 'chat:write.public', 'app_mentions:read', 'canvases:write', 'canvases:read', 'im:write', 'mpim:write', 'groups:read', 'groups:history', 'users:read', 'team:read'],
          userId: 'EXISTING_BOT_USER'
        },
        installedAt: new Date().toISOString()
      };
      await installationStore.storeInstallation(fallbackInstallation);
      console.log('🔄 Migrated existing workspace with fallback data');
    }
  };
  
  // Run detection asynchronously after a delay
  setImmediate(() => {
    detectExistingWorkspace().catch(error => {
      console.error('❌ Workspace migration failed:', error);
    });
  });
}

// In-memory storage for message batching and canvas tracking
const channelData = new Map();
const canvasData = new Map();
const bootstrappedChannels = new Set(); // Track channels we've already bootstrapped

// Configuration - Enhanced for multi-day conversations
const CONFIG = {
  BATCH_TIME_WINDOW: 2 * 60 * 1000, // 2 minutes
  BATCH_MESSAGE_LIMIT: 10,
  CANVAS_UPDATE_DEBOUNCE: 3 * 60 * 1000, // 3 minutes
  MAX_MESSAGES_FOR_SUMMARY: 500, // Increased for multi-day conversations
  MAX_CONVERSATION_HISTORY: 1000, // Max fetch from Slack API
  AI_TOKEN_SAFE_LIMIT: 400, // Safe message count to avoid token limits
  BOOTSTRAP_DAYS_LOOKBACK: 14, // Days to look back when joining existing channels
  MIN_MESSAGES_FOR_BOOTSTRAP: 10 // Minimum messages needed to create bootstrap Canvas
};

// Enhanced Granola-style prompt for Canvas formatting
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
- **<@USER_ID>**: Their key contributions and role in discussion
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
- [ ] **<@USER_ID>**: Specific task or responsibility with checkbox for tracking
- [ ] **Timeline**: Any deadlines or timeframes mentioned with checkbox
- [ ] **Follow-up**: Required next steps or meetings with interactive checkbox

## 📌 **Key Insights & Resources**
> Important quotes or standout insights
- Key insights and takeaways
- Links, documents, or resources shared
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

// Initialize channel data structure
function initChannelData(channelId) {
  if (!channelData.has(channelId)) {
    channelData.set(channelId, {
      messages: [],
      lastBatchTime: Date.now(),
      pendingUpdate: false
    });
  }
}

// Add message to batch
function addMessageToBatch(channelId, message) {
  initChannelData(channelId);
  const data = channelData.get(channelId);
  
  data.messages.push({
    user: message.user,
    text: message.text,
    timestamp: message.ts,
    thread_ts: message.thread_ts
  });

  // Keep only recent messages
  if (data.messages.length > CONFIG.MAX_MESSAGES_FOR_SUMMARY) {
    data.messages = data.messages.slice(-CONFIG.MAX_MESSAGES_FOR_SUMMARY);
  }
}

// Check if batch should be processed
function shouldProcessBatch(channelId) {
  const data = channelData.get(channelId);
  if (!data) return false;

  const timeSinceLastBatch = Date.now() - data.lastBatchTime;
  const messageCount = data.messages.length;

  return (
    timeSinceLastBatch >= CONFIG.BATCH_TIME_WINDOW ||
    messageCount >= CONFIG.BATCH_MESSAGE_LIMIT
  ) && !data.pendingUpdate;
}

// Get user display names for better participant formatting
async function getUserDisplayNames(userIds) {
  const userNames = {};
  
  for (const userId of [...new Set(userIds)]) {
    try {
      const userInfo = await app.client.users.info({ user: userId });
      userNames[userId] = userInfo.user.real_name || userInfo.user.display_name || userInfo.user.name;
    } catch (error) {
      console.log(`⚠️ Cannot fetch user info (missing users:read scope), using user ID: ${userId}`);
      userNames[userId] = `User ${userId.substring(0,8)}`; // More readable fallback
    }
  }
  
  return userNames;
}

// Smart message selection for very long conversations
function selectMessagesForSummary(messages) {
  if (messages.length <= CONFIG.AI_TOKEN_SAFE_LIMIT) {
    return messages; // No need to filter
  }
  
  console.log(`📊 Long conversation detected: ${messages.length} messages, selecting best ${CONFIG.AI_TOKEN_SAFE_LIMIT} for summary`);
  
  // For very long conversations, use a smart selection strategy:
  // 1. Keep the first 50 messages (conversation start context)
  // 2. Keep the last 300 messages (recent context)  
  // 3. Sample 50 messages from the middle (continuity)
  
  const startMessages = messages.slice(0, 50);
  const endMessages = messages.slice(-300);
  
  if (messages.length > 350) {
    // Sample from middle section
    const middleStart = 50;
    const middleEnd = messages.length - 300;
    const middleSection = messages.slice(middleStart, middleEnd);
    
    // Sample every nth message from middle
    const sampleRate = Math.ceil(middleSection.length / 50);
    const middleSample = middleSection.filter((_, index) => index % sampleRate === 0).slice(0, 50);
    
    return [...startMessages, ...middleSample, ...endMessages];
  } else {
    return [...startMessages, ...endMessages];
  }
}

// Generate AI summary with enhanced formatting for multi-day conversations
async function generateSummary(messages) {
  try {
    // Smart selection for very long conversations to avoid token limits
    const selectedMessages = selectMessagesForSummary(messages);
    const isFiltered = selectedMessages.length < messages.length;
    
    console.log(`📝 Generating summary from ${selectedMessages.length} messages${isFiltered ? ` (filtered from ${messages.length})` : ''}`);
    
    // Get user display names
    const userIds = selectedMessages.map(msg => msg.user);
    const userNames = await getUserDisplayNames(userIds);
    
    // Extract links and dates from ALL messages (not just selected ones)
    const links = extractLinks(messages);
    const dates = extractDates(messages);
    
    // Create conversation text with real names and user IDs for mentions
    const conversationText = selectedMessages.map(msg => 
      `${userNames[msg.user] || msg.user}: ${msg.text}`
    ).join('\n');

    const enhancedPrompt = GRANOLA_PROMPT + `

**IMPORTANT FORMATTING INSTRUCTIONS:**
- For action items, use interactive checkboxes: "- [ ] Task description"
- Use clickable user mentions for participants: ${Object.entries(userNames).map(([id, name]) => `<@${id}> (${name})`).join(', ')}
- Make action items specific and actionable with clickable user mentions: "- [ ] Task description <@USER_ID>"
- Use blockquotes (>) for key insights, important decisions, or standout quotes
- If dates/times are mentioned, add a "## 📅 **Important Dates & Times**" section
- If links are shared, they will be added separately - don't include them in your summary
- Format participant names as clickable mentions: <@USER_ID> instead of just names

**USER MAPPING FOR MENTIONS:**
${Object.entries(userNames).map(([id, name]) => `${id} = ${name} (use <@${id}>)`).join('\n')}

**CONVERSATION CONTEXT:**
${isFiltered ? `- This is a LONG conversation (${messages.length} total messages) - you're seeing selected key messages from beginning, middle, and recent activity` : `- Complete conversation with ${messages.length} messages`}
${isFiltered ? '- Focus on capturing the overall flow, key decisions, and current status even though some messages are omitted' : ''}

**EXTRACTED CONTEXT:**
${dates.length > 0 ? `- Dates/Times mentioned: ${dates.join(', ')}` : ''}
${links.length > 0 ? `- Links shared: ${links.length} links (will be grouped separately)` : ''}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: enhancedPrompt
        },
        {
          role: "user",
          content: conversationText
        }
      ],
      max_tokens: 1500,
      temperature: 0.3
    });

    return {
      summary: response.choices[0].message.content,
      links: links,
      dates: dates,
      messageCount: {
        total: messages.length,
        processed: selectedMessages.length,
        isFiltered: isFiltered
      }
    };
  } catch (error) {
    console.error('Error generating summary:', error);
    return {
      summary: "❌ Error generating summary. Please try again later.",
      links: [],
      dates: [],
      messageCount: {
        total: messages.length,
        processed: 0,
        isFiltered: false
      }
    };
  }
}

// Create beautiful Canvas with enhanced formatting (no title duplication)
async function createCanvasContent(summaryData) {
  let content = summaryData.summary;
  
  // Add links section if any links were shared
  if (summaryData.links && summaryData.links.length > 0) {
    content += `\n\n---\n\n## 🔗 **Links & Resources**\n\n`;
    summaryData.links.forEach(link => {
      content += `- [${link}](${link})\n`;
    });
  }
  
  // Add dates section if any dates were mentioned
  if (summaryData.dates && summaryData.dates.length > 0) {
    content += `\n\n## 📅 **Important Dates & Times**\n\n`;
    summaryData.dates.forEach(date => {
      content += `- ${date}\n`;
    });
  }
  
  const messageInfo = summaryData.messageCount;
  const messageStats = messageInfo ? 
    (messageInfo.isFiltered ? 
      `📊 Summarized ${messageInfo.processed} key messages from ${messageInfo.total} total messages` :
      `📊 Summarized all ${messageInfo.total} messages`) : '';

  content += `\n\n---

*🤖 Auto-generated by Paper • Last updated: ${new Date().toLocaleString()}*
${messageStats ? `\n*${messageStats}*` : ''}

---

### 🔄 **How Paper Works**
- **Smart Bootstrap**: Creates Canvas from 14 days of history when joining
- **Smart Batching**: Summarizes every 10 messages or 2 minutes
- **Auto-Updates**: Canvas refreshes automatically  
- **AI-Powered**: Uses OpenAI GPT-4 for intelligent summaries
- **Multi-Day Support**: Handles conversations with 1000+ messages
- **Granola Format**: Structured, scannable conversation insights

*💡 Mention @Paper with "summary" to trigger manual updates*`;

  return content;
}

// Check if channel already has a canvas
async function getExistingCanvasId(channelId) {
  try {
    const channelInfo = await app.client.conversations.info({
      channel: channelId,
      include_locale: false
    });
    
    // Check if channel has a canvas in properties
    if (channelInfo.channel.properties && channelInfo.channel.properties.canvas) {
      return channelInfo.channel.properties.canvas.document_id;
    }
    
    return null;
  } catch (error) {
    if (error.data?.error === 'channel_not_found') {
      console.log(`⚠️ Channel ${channelId} not accessible - app may have been removed`);
      // Clean up data for inaccessible channel
      channelData.delete(channelId);
      canvasData.delete(channelId);
      bootstrappedChannels.delete(channelId);
      return 'CHANNEL_INACCESSIBLE';
    }
    console.error('Error checking for existing canvas:', error);
    return null;
  }
}

// Generate dynamic canvas title based on conversation content
async function generateCanvasTitle(summaryData) {
  try {
    const titlePrompt = `Based on this conversation summary, generate a SHORT, descriptive title (max 6 words) that captures the main topic or purpose of the discussion. Return ONLY the title, nothing else:

${summaryData.summary.substring(0, 500)}...`;

    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "user",
          content: titlePrompt
        }
      ],
      max_tokens: 50,
      temperature: 0.3
    });

    const title = response.choices[0].message.content.trim().replace(/^["']|["']$/g, '');
    return title; // Clean title without emoji
  } catch (error) {
    console.error('Error generating canvas title:', error);
    return "Conversation Summary";
  }
}

// Extract links from messages
function extractLinks(messages) {
  const linkRegex = /(https?:\/\/[^\s]+)/g;
  const links = [];
  
  messages.forEach(msg => {
    const foundLinks = msg.text.match(linkRegex);
    if (foundLinks) {
      foundLinks.forEach(link => {
        // Clean up link (remove trailing punctuation)
        const cleanLink = link.replace(/[.,;!?]$/, '');
        if (!links.includes(cleanLink)) {
          links.push(cleanLink);
        }
      });
    }
  });
  
  return links;
}

// Extract dates from messages  
function extractDates(messages) {
  const dateRegex = /(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},? \d{4}|(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2},? \d{4}|\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*,? \d{4})/gi;
  const timeRegex = /(\d{1,2}:\d{2}(?:\s?[AP]M)?)/gi;
  const relativeDateRegex = /(today|tomorrow|yesterday|next week|this week|next month|this month)/gi;
  const dates = [];
  
  messages.forEach(msg => {
    const foundDates = msg.text.match(dateRegex);
    const foundTimes = msg.text.match(timeRegex);
    const foundRelativeDates = msg.text.match(relativeDateRegex);
    
    if (foundDates) {
      foundDates.forEach(date => {
        if (!dates.includes(date)) {
          dates.push(date);
        }
      });
    }
    
    if (foundTimes) {
      foundTimes.forEach(time => {
        if (!dates.includes(time)) {
          dates.push(time);
        }
      });
    }
    
    if (foundRelativeDates) {
      foundRelativeDates.forEach(relativeDate => {
        if (!dates.includes(relativeDate.toLowerCase())) {
          dates.push(relativeDate.toLowerCase());
        }
      });
    }
  });
  
  return dates;
}

// Bootstrap channel with Canvas from existing conversation history (with authenticated client)
async function bootstrapChannelCanvasWithClient(channelId, client, teamId, say = null) {
  // Skip if already bootstrapped
  if (bootstrappedChannels.has(channelId)) {
    console.log(`📄 Channel ${channelId} already bootstrapped, skipping`);
    return;
  }

  try {
    console.log(`🎯 Bootstrapping Canvas for channel: ${channelId} in team ${teamId}`);
    
    // Calculate 14 days ago timestamp
    const fourteenDaysAgo = Math.floor((Date.now() - (CONFIG.BOOTSTRAP_DAYS_LOOKBACK * 24 * 60 * 60 * 1000)) / 1000);
    
    // Fetch conversation history from last 14 days with better error handling
    let result;
    try {
      result = await client.conversations.history({
        channel: channelId,
        oldest: fourteenDaysAgo.toString(),
        limit: CONFIG.MAX_CONVERSATION_HISTORY,
        exclude_archived: true
      });
    } catch (historyError) {
      if (historyError.data?.error === 'channel_not_found') {
        console.log(`🚫 Channel ${channelId} not accessible - app may have been removed or channel deleted`);
        bootstrappedChannels.add(channelId); // Mark as processed to avoid retries
        if (say) {
          await say(`📄 Hi! I don't have access to this channel's history. Please re-add me to the channel or check my permissions! 🔧`);
        }
        return;
      } else if (historyError.data?.error === 'missing_scope') {
        console.log(`🚫 Missing required scope for channel ${channelId}: ${historyError.data.needed}`);
        bootstrappedChannels.add(channelId);
        if (say) {
          await say(`📄 I need additional permissions to access this channel. Please check the app configuration! 🔧`);
        }
        return;
      }
      throw historyError; // Re-throw other errors
    }

    if (result.messages && result.messages.length > 0) {
      // Convert and filter messages
      const conversationMessages = result.messages
        .filter(msg => !msg.bot_id && !msg.subtype && msg.text && msg.text.trim().length > 0)
        .reverse() // Slack gives newest first, we want chronological order
        .map(msg => ({
          user: msg.user,
          text: msg.text || '',
          timestamp: msg.ts,
          thread_ts: msg.thread_ts
        }));

      console.log(`📊 Found ${conversationMessages.length} messages from last ${CONFIG.BOOTSTRAP_DAYS_LOOKBACK} days in channel ${channelId}`);

      if (conversationMessages.length >= CONFIG.MIN_MESSAGES_FOR_BOOTSTRAP) {
        console.log(`✅ Channel has sufficient history (${conversationMessages.length} messages), creating bootstrap Canvas`);
        
        const summaryData = await generateSummary(conversationMessages);
        await updateCanvasWithClient(channelId, summaryData, client, teamId);
        
        // Notify about bootstrap with helpful message
        if (say) {
          if (conversationMessages.length > CONFIG.AI_TOKEN_SAFE_LIMIT) {
            await say(`📄 Welcome! I found ${conversationMessages.length} messages from the last ${CONFIG.BOOTSTRAP_DAYS_LOOKBACK} days and created a comprehensive Canvas summary of your recent conversations! 🎨✨`);
          } else {
            await say(`📄 Welcome! I've created a Canvas summary of your recent ${conversationMessages.length} messages from the last ${CONFIG.BOOTSTRAP_DAYS_LOOKBACK} days. Let's keep the conversation going! 🎨✨`);
          }
        }
        
        // Mark as bootstrapped
        bootstrappedChannels.add(channelId);
        
        // Initialize channel data for future messages
        initChannelData(channelId);
        
        console.log(`🎉 Bootstrap complete for channel ${channelId}`);
      } else {
        console.log(`📝 Channel has only ${conversationMessages.length} messages (need ${CONFIG.MIN_MESSAGES_FOR_BOOTSTRAP}+), starting fresh`);
        
        // Still mark as "bootstrapped" to avoid checking again, but no Canvas created
        bootstrappedChannels.add(channelId);
        
        // Optional: Let users know Paper is ready for new conversations
        if (say && conversationMessages.length > 0) {
          await say(`📄 Hi! I found some older messages but not enough recent activity. I'm ready to start creating Canvas summaries as you have new conversations! 🚀`);
        }
      }
    } else {
      console.log(`📝 No conversation history found in channel ${channelId}, starting fresh`);
      bootstrappedChannels.add(channelId);
    }
    
  } catch (error) {
    console.error(`❌ Error bootstrapping channel ${channelId}:`, error);
    
    // Mark as bootstrapped even on error to avoid infinite retries
    bootstrappedChannels.add(channelId);
    
    // Let user know there was an issue but Paper is still ready
    if (say) {
      await say(`📄 Hi! I had trouble accessing the conversation history, but I'm ready to start creating Canvas summaries as you continue chatting! 🚀`);
    }
  }
}

// Create or update summary using Canvas API (with authenticated client)
async function updateCanvasWithClient(channelId, summaryData, client, teamId) {
  try {
    // First check if we have a stored canvas ID
    let canvasId = canvasData.get(channelId);
    
    // If not, check if channel already has a canvas
    if (!canvasId) {
      try {
        const channelInfo = await client.conversations.info({
          channel: channelId,
          include_locale: false
        });
        
        // Check if channel has a canvas in properties
        if (channelInfo.channel.properties && channelInfo.channel.properties.canvas) {
          canvasId = channelInfo.channel.properties.canvas.document_id;
          canvasData.set(channelId, canvasId);
          console.log('📄 Found existing canvas for channel:', channelId, 'Canvas ID:', canvasId);
        }
      } catch (error) {
        if (error.data?.error === 'channel_not_found') {
          console.log(`⚠️ Channel ${channelId} not accessible - app may have been removed`);
          channelData.delete(channelId);
          canvasData.delete(channelId);
          bootstrappedChannels.delete(channelId);
          return;
        }
        console.error('Error checking for existing canvas:', error);
      }
    }
    
    const canvasContent = await createCanvasContent(summaryData);
    const canvasTitle = await generateCanvasTitle(summaryData);
    
    if (!canvasId) {
      // Create new channel canvas using the correct API
      console.log('🎨 Creating new channel canvas:', channelId);
      
      const response = await client.apiCall('conversations.canvases.create', {
        channel_id: channelId,
        title: canvasTitle,
        document_content: {
          type: 'markdown',
          markdown: canvasContent
        }
      });
      
      if (response.ok) {
        canvasId = response.canvas_id;
        canvasData.set(channelId, canvasId);
        console.log('✅ Canvas created successfully:', canvasId);
      } else {
        console.error('❌ Failed to create canvas:', response.error);
        return;
      }
    } else {
      // Update existing canvas
      console.log('📝 Updating existing canvas:', canvasId);
      
      const response = await client.apiCall('canvases.edit', {
        canvas_id: canvasId,
        changes: [{
          operation: 'replace',
          document_content: {
            type: 'markdown',
            markdown: canvasContent
          }
        }]
      });
      
      if (response.ok) {
        console.log('✅ Canvas updated successfully:', canvasId);
      } else {
        console.error('❌ Failed to update canvas:', response.error);
        return;
      }
    }
    
  } catch (error) {
    console.error('❌ Error updating canvas:', error);
    
    // Handle specific canvas errors
    if (error.data?.error === 'canvas_not_found') {
      console.log('🗑️ Canvas no longer exists, clearing stored ID');
      canvasData.delete(channelId);
    } else if (error.data?.error === 'channel_not_found') {
      console.log(`🚫 Cleaning up inaccessible channel: ${channelId}`);
      channelData.delete(channelId);
      canvasData.delete(channelId);
      bootstrappedChannels.delete(channelId);
    }
  }
}

// Create or update summary using Canvas API (fallback for legacy calls)
async function updateCanvas(channelId, summaryData) {
  try {
    // Get workspace-specific client in OAuth mode
    let client, teamId;
    if (isOAuthMode) {
      // Get channel info to determine team ID
      let channelInfo;
      try {
        channelInfo = await app.client.conversations.info({ channel: channelId });
      } catch (error) {
        console.error(`❌ Cannot get channel info for canvas update: ${error.message}`);
        return;
      }
      
      teamId = channelInfo.channel?.shared_team_ids?.[0] || 'UNKNOWN';
      console.log(`🔍 Canvas update: Getting installation for team ${teamId}`);
      
      const installation = await installationStore.fetchInstallation({ teamId });
      if (!installation) {
        console.error(`❌ No installation found for team ${teamId} during canvas update`);
        return;
      }
      
      // Create WebClient with workspace-specific token
      const { WebClient } = require('@slack/web-api');
      client = new WebClient(installation.bot.token);
      console.log(`🔍 Canvas update: Using workspace token ${installation.bot.token.substring(0, 15)}...`);
      
      // Use multi-workspace canvas update function
      await updateCanvasWithClient(channelId, summaryData, client, teamId);
    } else {
      // Use single-workspace logic with global client
      client = app.client;
      
      // First check if we have a stored canvas ID
      let canvasId = canvasData.get(channelId);
      
      // If not, check if channel already has a canvas
      if (!canvasId) {
        canvasId = await getExistingCanvasId(channelId);
        if (canvasId === 'CHANNEL_INACCESSIBLE') {
          console.log(`🚫 Skipping inaccessible channel: ${channelId}`);
          return; // Exit early for inaccessible channels
        }
        if (canvasId) {
          canvasData.set(channelId, canvasId);
          console.log('📄 Found existing canvas for channel:', channelId, 'Canvas ID:', canvasId);
        }
      }
      
      const canvasContent = await createCanvasContent(summaryData);
      const canvasTitle = await generateCanvasTitle(summaryData);
      
      if (!canvasId) {
        // Create new channel canvas using the correct API
        console.log('🎨 Creating new channel canvas:', channelId);
        
        const response = await client.apiCall('conversations.canvases.create', {
          channel_id: channelId,
          title: canvasTitle,
          document_content: {
            type: "markdown",
            markdown: canvasContent
          }
        });
        
        canvasId = response.canvas_id;
        canvasData.set(channelId, canvasId);
        
        console.log(`✅ Channel Canvas created successfully: ${canvasId}`);
        
        // Get workspace info for Canvas link (with fallback for missing team:read scope)
        let canvasUrl = `https://slack.com/canvas/${canvasId}`; // Generic fallback
        try {
          const teamInfo = await client.team.info();
          const workspaceUrl = `https://${teamInfo.team.domain}.slack.com`;
          canvasUrl = `${workspaceUrl}/docs/${teamInfo.team.id}/${canvasId}`;
        } catch (error) {
          console.log(`⚠️ Cannot fetch team info (missing team:read scope), using generic Canvas URL`);
        }
        
        // Clean Canvas creation notification
        await client.chat.postMessage({
          channel: channelId,
          text: `📄 <${canvasUrl}|${canvasTitle}>`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `📄 <${canvasUrl}|${canvasTitle}> ✨`
              }
            }
          ],
          unfurl_links: true,
          unfurl_media: true
        });
      } else {
        // Update existing canvas with enhanced content
        console.log('🔄 Updating existing canvas:', canvasId);
        
        // Update canvas content and title
        await client.apiCall('canvases.edit', {
          canvas_id: canvasId,
          changes: [
            {
              operation: "replace",
              document_content: {
                type: "markdown", 
                markdown: canvasContent
              }
            }
          ]
        });
        
        // Also update the title dynamically
        try {
          await client.apiCall('canvases.edit', {
            canvas_id: canvasId,
            changes: [
              {
                operation: "replace",
                title: canvasTitle
              }
            ]
          });
          console.log(`📝 Canvas title updated to: ${canvasTitle}`);
        } catch (titleError) {
          console.log('📝 Canvas title update not supported by API, keeping original title');
        }
        
        console.log(`✅ Canvas updated successfully: ${canvasId}`);
      }
    }
  } catch (error) {
    if (error.data?.error === 'channel_not_found') {
      console.log(`🚫 Channel ${channelId} became inaccessible during Canvas operation`);
      // Clean up data for inaccessible channel
      channelData.delete(channelId);
      canvasData.delete(channelId);
      bootstrappedChannels.delete(channelId);
      return;
    }
    
    console.error('❌ Canvas API error:', error);
    
    // Enhanced fallback with better formatting
    try {
      // Use workspace-specific client for fallback too
      let fallbackClient = app.client;
      if (isOAuthMode) {
        try {
          const channelInfo = await app.client.conversations.info({ channel: channelId });
          const teamId = channelInfo.channel?.shared_team_ids?.[0] || 'UNKNOWN';
          const installation = await installationStore.fetchInstallation({ teamId });
          if (installation) {
            const { WebClient } = require('@slack/web-api');
            fallbackClient = new WebClient(installation.bot.token);
          }
        } catch (fallbackClientError) {
          console.log('Using global client for fallback message');
        }
      }
      
      await fallbackClient.chat.postMessage({
        channel: channelId,
        text: "📄 *Paper: Conversation Summary*",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "📄 *Paper: Conversation Summary*\n\n_(Canvas unavailable - using message format)_"
            }
          },
          {
            type: "divider"
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: summaryData.summary
            }
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `🤖 Generated by Paper • ${new Date().toLocaleString()}`
              }
            ]
          }
        ]
      });
      console.log(`📄 Enhanced summary posted as message for channel ${channelId}`);
    } catch (fallbackError) {
      if (fallbackError.data?.error === 'channel_not_found') {
        console.log(`🚫 Channel ${channelId} inaccessible for fallback message too - cleaning up`);
        channelData.delete(channelId);
        canvasData.delete(channelId);
        bootstrappedChannels.delete(channelId);
      } else {
        console.error('❌ Error posting fallback message:', fallbackError);
      }
    }
  }
}

// Bootstrap Canvas for existing channels with recent history
async function bootstrapChannelCanvas(channelId, say = null) {
  // Skip if already bootstrapped
  if (bootstrappedChannels.has(channelId)) {
    console.log(`📄 Channel ${channelId} already bootstrapped, skipping`);
    return;
  }

  try {
    console.log(`🎯 Bootstrapping Canvas for channel: ${channelId}`);
    
    // Get workspace-specific client in OAuth mode
    let client;
    if (isOAuthMode) {
      // Get channel info to determine team ID
      const channelInfo = await app.client.conversations.info({ channel: channelId });
      const teamId = channelInfo.channel?.shared_team_ids?.[0] || 'UNKNOWN';
      
      console.log(`🔍 Bootstrap: Getting installation for team ${teamId}`);
      const installation = await installationStore.fetchInstallation({ teamId });
      
      if (!installation) {
        console.error(`❌ No installation found for team ${teamId} during bootstrap`);
        bootstrappedChannels.add(channelId);
        if (say) {
          await say("📄 Hi! I need to be properly installed in this workspace. Please reinstall Paper! 🔧");
        }
        return;
      }
      
      // Create WebClient with workspace-specific token
      const { WebClient } = require('@slack/web-api');
      client = new WebClient(installation.bot.token);
      console.log(`🔍 Bootstrap: Using workspace token ${installation.bot.token.substring(0, 15)}...`);
    } else {
      // Use global client in token mode
      client = app.client;
    }
    
    // Calculate 14 days ago timestamp
    const fourteenDaysAgo = Math.floor((Date.now() - (CONFIG.BOOTSTRAP_DAYS_LOOKBACK * 24 * 60 * 60 * 1000)) / 1000);
    
    // Fetch conversation history from last 14 days with better error handling
    let result;
    try {
      result = await client.conversations.history({
        channel: channelId,
        oldest: fourteenDaysAgo.toString(),
        limit: CONFIG.MAX_CONVERSATION_HISTORY,
        exclude_archived: true
      });
    } catch (historyError) {
      if (historyError.data?.error === 'channel_not_found') {
        console.log(`🚫 Channel ${channelId} not accessible - app may have been removed or channel deleted`);
        bootstrappedChannels.add(channelId); // Mark as processed to avoid retries
        if (say) {
          await say(`📄 Hi! I don't have access to this channel's history. Please re-add me to the channel or check my permissions! 🔧`);
        }
        return;
      } else if (historyError.data?.error === 'missing_scope') {
        console.log(`🚫 Missing required scope for channel ${channelId}: ${historyError.data.needed}`);
        bootstrappedChannels.add(channelId);
        if (say) {
          await say(`📄 I need additional permissions to access this channel. Please check the app configuration! 🔧`);
        }
        return;
      }
      throw historyError; // Re-throw other errors
    }

    if (result.messages && result.messages.length > 0) {
      // Convert and filter messages
      const conversationMessages = result.messages
        .filter(msg => !msg.bot_id && !msg.subtype && msg.text && msg.text.trim().length > 0)
        .reverse() // Slack gives newest first, we want chronological order
        .map(msg => ({
          user: msg.user,
          text: msg.text || '',
          timestamp: msg.ts,
          thread_ts: msg.thread_ts
        }));

      console.log(`📊 Found ${conversationMessages.length} messages from last ${CONFIG.BOOTSTRAP_DAYS_LOOKBACK} days in channel ${channelId}`);

      if (conversationMessages.length >= CONFIG.MIN_MESSAGES_FOR_BOOTSTRAP) {
        console.log(`✅ Channel has sufficient history (${conversationMessages.length} messages), creating bootstrap Canvas`);
        
        const summaryData = await generateSummary(conversationMessages);
        await updateCanvas(channelId, summaryData);
        
        // Notify about bootstrap with helpful message
        if (say) {
          if (conversationMessages.length > CONFIG.AI_TOKEN_SAFE_LIMIT) {
            await say(`📄 Welcome! I found ${conversationMessages.length} messages from the last ${CONFIG.BOOTSTRAP_DAYS_LOOKBACK} days and created a comprehensive Canvas summary of your recent conversations! 🎨✨`);
          } else {
            await say(`📄 Welcome! I've created a Canvas summary of your recent ${conversationMessages.length} messages from the last ${CONFIG.BOOTSTRAP_DAYS_LOOKBACK} days. Let's keep the conversation going! 🎨✨`);
          }
        }
        
        // Mark as bootstrapped
        bootstrappedChannels.add(channelId);
        
        // Initialize channel data for future messages
        initChannelData(channelId);
        
        console.log(`🎉 Bootstrap complete for channel ${channelId}`);
      } else {
        console.log(`📝 Channel has only ${conversationMessages.length} messages (need ${CONFIG.MIN_MESSAGES_FOR_BOOTSTRAP}+), starting fresh`);
        
        // Still mark as "bootstrapped" to avoid checking again, but no Canvas created
        bootstrappedChannels.add(channelId);
        
        // Optional: Let users know Paper is ready for new conversations
        if (say && conversationMessages.length > 0) {
          await say(`📄 Hi! I found some older messages but not enough recent activity. I'm ready to start creating Canvas summaries as you have new conversations! 🚀`);
        }
      }
    } else {
      console.log(`📝 No conversation history found in channel ${channelId}, starting fresh`);
      bootstrappedChannels.add(channelId);
    }
    
  } catch (error) {
    console.error(`❌ Error bootstrapping channel ${channelId}:`, error);
    
    // Mark as bootstrapped even on error to avoid infinite retries
    bootstrappedChannels.add(channelId);
    
    // Let user know there was an issue but Paper is still ready
    if (say) {
      await say(`📄 Hi! I had trouble accessing the conversation history, but I'm ready to start creating Canvas summaries as you continue chatting! 🚀`);
    }
  }
}

// Process message batch
async function processBatch(channelId) {
  const data = channelData.get(channelId);
  if (!data || data.messages.length === 0) return;

  data.pendingUpdate = true;
  
  try {
    console.log(`📝 Processing batch for channel ${channelId} with ${data.messages.length} messages`);
    
    const summaryData = await generateSummary(data.messages);
    await updateCanvas(channelId, summaryData);
    
    data.lastBatchTime = Date.now();
    console.log(`✅ Batch processed successfully for channel ${channelId}`);
  } catch (error) {
    console.error(`❌ Error processing batch for channel ${channelId}:`, error);
    
    // Handle specific channel access errors
    if (error.data?.error === 'channel_not_found') {
      console.log(`🚫 Cleaning up inaccessible channel: ${channelId}`);
      channelData.delete(channelId);
      canvasData.delete(channelId);
      bootstrappedChannels.delete(channelId);
    } else if (error.data?.error === 'missing_scope') {
      console.log(`🚫 Missing scope for channel ${channelId}, marking as processed`);
      bootstrappedChannels.add(channelId);
    }
  } finally {
    data.pendingUpdate = false;
  }
}

// Handle when bot is added to a channel
app.event('member_joined_channel', async ({ event, say, client, body }) => {
  try {
    // Get bot user ID to compare
    const botInfo = await client.auth.test();
    const botUserId = botInfo.user_id;
    const teamId = body.team_id || event.team;
    
    // Only trigger bootstrap if the bot itself joined the channel
    if (event.user === botUserId) {
      console.log(`🎯 Paper bot added to channel: ${event.channel} in team ${teamId}, starting bootstrap...`);
      
      // Small delay to ensure permissions are fully set up
      setTimeout(async () => {
        await bootstrapChannelCanvasWithClient(event.channel, client, teamId, say);
      }, 2000);
    }
  } catch (error) {
    console.error('Error handling member_joined_channel event:', error);
  }
});

// Listen to all messages
app.message(async ({ message, say }) => {
  // Skip bot messages and system messages
  if (message.subtype || message.bot_id) return;
  
  const channelId = message.channel;
  
  // Bootstrap check: If this is the first time we see this channel, try to bootstrap
  if (!bootstrappedChannels.has(channelId)) {
    console.log(`🎯 First message detected in unboostrapped channel ${channelId}, starting bootstrap...`);
    
    // Bootstrap in background, don't block message processing
    setTimeout(async () => {
      try {
        // Get workspace-specific client in OAuth mode
        if (isOAuthMode) {
          // Get channel info to determine team ID
          let channelInfo;
          try {
            channelInfo = await app.client.conversations.info({ channel: channelId });
          } catch (error) {
            console.error(`❌ Cannot get channel info for bootstrap: ${error.message}`);
            return;
          }
          
          const teamId = channelInfo.channel?.shared_team_ids?.[0] || 'UNKNOWN';
          console.log(`🔍 Bootstrap: Getting installation for team ${teamId}`);
          
          const installation = await installationStore.fetchInstallation({ teamId });
          if (!installation) {
            console.error(`❌ No installation found for team ${teamId} during bootstrap`);
            return;
          }
          
          // Create WebClient with workspace-specific token
          const { WebClient } = require('@slack/web-api');
          const client = new WebClient(installation.bot.token);
          console.log(`🔍 Bootstrap: Using workspace token ${installation.bot.token.substring(0, 15)}...`);
          
          // Use multi-workspace bootstrap function
          await bootstrapChannelCanvasWithClient(channelId, client, teamId);
        } else {
          // Use single-workspace bootstrap function in token mode
          await bootstrapChannelCanvas(channelId);
        }
      } catch (error) {
        console.error(`❌ Error bootstrapping channel ${channelId}:`, error);
      }
    }, 1000);
  }
  
  // Add message to batch
  addMessageToBatch(channelId, message);
  
  // Check if we should process the batch
  if (shouldProcessBatch(channelId)) {
    // Add small delay to avoid rate limits
    setTimeout(() => processBatch(channelId), 1000);
  }
});

// Handle app mentions for manual trigger
app.event('app_mention', async ({ event, say }) => {
  const channelId = event.channel;
  
  if (event.text.includes('summary') || event.text.includes('update')) {
    try {
      // Bootstrap check: If not bootstrapped yet, do it now
      if (!bootstrappedChannels.has(channelId)) {
        console.log(`🎯 Manual summary requested in unboostrapped channel ${channelId}, bootstrapping first...`);
        
        // Get workspace-specific client for bootstrap in OAuth mode
        if (isOAuthMode) {
          // Get channel info to determine team ID
          let channelInfo;
          try {
            channelInfo = await app.client.conversations.info({ channel: channelId });
          } catch (error) {
            console.error(`❌ Cannot get channel info for manual bootstrap: ${error.message}`);
            await say("📄 Hi! I had trouble accessing this channel. Please try again! 🔧");
            return;
          }
          
          const teamId = channelInfo.channel?.shared_team_ids?.[0] || 'UNKNOWN';
          console.log(`🔍 Manual bootstrap: Getting installation for team ${teamId}`);
          
          const installation = await installationStore.fetchInstallation({ teamId });
          if (!installation) {
            console.error(`❌ No installation found for team ${teamId} during manual bootstrap`);
            await say("📄 Hi! I need to be properly installed in this workspace. Please reinstall Paper! 🔧");
            return;
          }
          
          // Create WebClient with workspace-specific token
          const { WebClient } = require('@slack/web-api');
          const client = new WebClient(installation.bot.token);
          console.log(`🔍 Manual bootstrap: Using workspace token ${installation.bot.token.substring(0, 15)}...`);
          
          // Use multi-workspace bootstrap function
          await bootstrapChannelCanvasWithClient(channelId, client, teamId, say);
        } else {
          // Use single-workspace bootstrap function in token mode
          await bootstrapChannelCanvas(channelId, say);
        }
        return; // Bootstrap will create the Canvas
      }
      
      // Fetch recent conversation history from Slack with error handling
      console.log('Fetching conversation history for channel:', channelId);
      
      // Get workspace-specific client in OAuth mode
      let client;
      if (isOAuthMode) {
        // Get channel info to determine team ID
        const channelInfo = await app.client.conversations.info({ channel: channelId });
        const teamId = channelInfo.channel?.shared_team_ids?.[0] || 'UNKNOWN';
        
        console.log(`🔍 Manual summary: Getting installation for team ${teamId}`);
        const installation = await installationStore.fetchInstallation({ teamId });
        
        if (!installation) {
          console.error(`❌ No installation found for team ${teamId} during manual summary`);
          await say("📄 Hi! I need to be properly installed in this workspace. Please reinstall Paper! 🔧");
          return;
        }
        
        // Create WebClient with workspace-specific token
        const { WebClient } = require('@slack/web-api');
        client = new WebClient(installation.bot.token);
        console.log(`🔍 Manual summary: Using workspace token ${installation.bot.token.substring(0, 15)}...`);
      } else {
        // Use global client in token mode
        client = app.client;
      }
      
      let result;
      try {
        result = await client.conversations.history({
          channel: channelId,
          limit: CONFIG.MAX_CONVERSATION_HISTORY,
          exclude_archived: true
        });
      } catch (historyError) {
        if (historyError.data?.error === 'channel_not_found') {
          console.log(`🚫 Channel ${channelId} not accessible during manual summary request`);
          await say("📄 I don't have access to this channel's history. Please re-add me to the channel! 🔧");
          return;
        } else if (historyError.data?.error === 'missing_scope') {
          console.log(`🚫 Missing required scope for channel ${channelId}: ${historyError.data.needed}`);
          await say("📄 I need additional permissions to access this channel. Please check the app configuration! 🔧");
          return;
        }
        throw historyError;
      }
      
      if (result.messages && result.messages.length > 0) {
        // Convert messages to our format and filter out bot messages
        const conversationMessages = result.messages
          .filter(msg => !msg.bot_id && !msg.subtype)
          .reverse() // Slack gives newest first, we want chronological order
          .map(msg => ({
            user: msg.user,
            text: msg.text || '',
            timestamp: msg.ts,
            thread_ts: msg.thread_ts
          }));
        
        console.log(`Found ${conversationMessages.length} messages to summarize`);
        
        if (conversationMessages.length >= 3) {
          const summaryData = await generateSummary(conversationMessages);
          await updateCanvas(channelId, summaryData);
          
          // Provide feedback for very long conversations
          if (conversationMessages.length > CONFIG.AI_TOKEN_SAFE_LIMIT) {
            await say(`📊 Wow! This is a long conversation with ${conversationMessages.length} messages. I've created a comprehensive summary focusing on key decisions, action items, and recent activity. Canvas updated! 🎨`);
          }
        } else if (conversationMessages.length > 0) {
          await say(`📄 I found ${conversationMessages.length} message${conversationMessages.length === 1 ? '' : 's'}, but need at least 3 messages to create a meaningful summary. Have a conversation with your team and try again!`);
        } else {
          await say("📄 This channel seems quiet! Start a conversation with your team (3+ messages) and I'll create a beautiful Canvas summary for you. ✨");
        }
      } else {
        await say("📄 No conversation history found in this channel.");
      }
    } catch (error) {
      console.error('Error fetching conversation history:', error);
      await say("❌ Sorry, I couldn't fetch the conversation history. Please try again.");
    }
  } else {
    await say("📄 Hi! I'm *Paper* - I automatically create conversation summaries in a canvas. Mention me with 'summary' to update manually!");
  }
});

// Handle app installation
app.event('app_home_opened', async ({ event, client }) => {
  try {
    // Ensure we have a valid user ID
    if (!event.user || typeof event.user !== 'string' || event.user.trim() === '') {
      console.log('⚠️ App home opened but invalid user ID provided:', event.user);
      return;
    }
    
    console.log(`📱 Opening app home for user: ${event.user}`);
    
    await client.views.publish({
      user_id: event.user,
      view: {
        type: 'home',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*📄 Welcome to Paper!*\n\n🎯 *AI-Powered Conversation Intelligence*\nI automatically create beautiful Canvas summaries of your team conversations using advanced AI.'
            }
          },
          {
            type: 'section',
            fields: [
              {
                type: 'mrkdwn',
                text: '*✨ What I Do:*\n• Create AI Canvas summaries\n• Extract action items with ✅ checkboxes\n• Group links & dates automatically\n• Bootstrap from 14 days of history when joining channels\n• Handle multi-day conversations (1000+ messages)\n• Update every 10 messages or 2 minutes'
              },
              {
                type: 'mrkdwn',
                text: '*🚀 How to Use:*\n• Add me to any channel\n• Have conversations naturally\n• Watch Canvas summaries appear!\n• Type `@Paper summary` for manual updates'
              }
            ]
          },
          {
            type: 'divider'
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*🎨 Features:*\n> Smart conversation analysis with GPT-4\n> Clickable user mentions in summaries\n> Professional Granola-style formatting\n> One persistent canvas per channel\n> Strategic blockquotes for key insights'
            }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*💡 Pro Tip:* Add me to your most active channels and watch your team\'s conversation insights come to life! Perfect for meetings, planning sessions, and decision tracking.'
            }
          }
        ]
      }
    });
  } catch (error) {
    console.error('Error publishing home view:', error);
  }
});

// Auto-update canvases periodically for active channels
async function autoUpdateCanvases() {
  console.log('🔄 Running automatic canvas updates...');
  
  for (const [channelId, data] of channelData.entries()) {
    // Only update if there are recent messages and enough time has passed
    const timeSinceLastUpdate = Date.now() - data.lastBatchTime;
    const hasRecentActivity = data.messages.length > 0;
    const shouldUpdate = timeSinceLastUpdate >= (15 * 60 * 1000); // 15 minutes
    
    if (hasRecentActivity && shouldUpdate && !data.pendingUpdate) {
      console.log(`🔄 Auto-updating canvas for channel: ${channelId}`);
      try {
        await processBatch(channelId);
      } catch (error) {
        if (error.message && error.message.includes('channel_not_found')) {
          console.log(`🚫 Cleaning up inaccessible channel: ${channelId}`);
          channelData.delete(channelId);
          canvasData.delete(channelId);
          bootstrappedChannels.delete(channelId);
        } else {
          console.error(`Error auto-updating canvas for ${channelId}:`, error);
        }
      }
    }
  }
}

// Run auto-updates every 10 minutes
setInterval(autoUpdateCanvases, 10 * 60 * 1000);

// Cleanup old data periodically  
setInterval(() => {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  
  for (const [channelId, data] of channelData.entries()) {
    if (data.lastBatchTime < oneHourAgo && data.messages.length === 0) {
      channelData.delete(channelId);
      canvasData.delete(channelId);
      bootstrappedChannels.delete(channelId);
      console.log(`🧹 Cleaned up inactive channel data: ${channelId}`);
    }
  }
}, 30 * 60 * 1000); // Clean up every 30 minutes

// Error handling
app.error((error) => {
  console.error('Slack app error:', error);
});

// Add Socket Mode error handling
app.error((error) => {
  console.error('Slack app error:', error);
  if (error.message && error.message.includes('server explicit disconnect')) {
    console.log('🔄 Socket Mode disconnected, will attempt reconnection...');
  }
});

// Start the app with HTTP server for Render port binding
(async () => {
  try {
    const port = process.env.PORT || 10000;
    
    // Start HTTP server first for Render port detection
    const express = require('express');
    const httpApp = express();
    
    // Health check endpoint
    httpApp.get('/', (req, res) => {
      res.json({ 
        status: 'healthy', 
        app: 'Paper Slack Canvas Summarizer',
        mode: 'Socket Mode',
        timestamp: new Date().toISOString()
      });
    });
    
    httpApp.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: Date.now() });
    });
    
    // Start HTTP server early
    httpApp.listen(port, '0.0.0.0', () => {
      console.log(`🌐 HTTP server running on port ${port} for Render!`);
    });
    
    // Start Slack app in Socket Mode with retry logic
    let retryCount = 0;
    const maxRetries = 3;
    
    while (retryCount < maxRetries) {
      try {
        await app.start();
        console.log(`⚡️ Paper Slack app connected via Socket Mode!`);
        break; // Success, exit retry loop
      } catch (startError) {
        retryCount++;
        console.error(`❌ Socket Mode connection attempt ${retryCount} failed:`, startError.message);
        
        if (retryCount < maxRetries) {
          const delay = retryCount * 2000; // Exponential backoff
          console.log(`🔄 Retrying Socket Mode connection in ${delay/1000} seconds...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          throw startError; // Final failure
        }
      }
    }

    // Environment debug endpoint (for troubleshooting)
    httpApp.get('/debug', (req, res) => {
      const envStatus = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_APP_TOKEN', 'OPENAI_API_KEY']
        .map(key => ({ 
          name: key, 
          present: !!process.env[key],
          preview: process.env[key] ? process.env[key].substring(0, 10) + '...' : 'missing'
        }));
      
      const workspaces = isOAuthMode ? 
        Array.from(installationStore.installations.entries()).map(([teamId, installation]) => ({
          teamId,
          teamName: installation.team?.name || 'Unknown',
          botToken: installation.bot?.token ? installation.bot.token.substring(0, 15) + '...' : 'missing'
        })) : 
        [{ teamId: 'SINGLE_WORKSPACE', teamName: 'Token Mode', botToken: 'Using environment token' }];
      
      res.json({
        status: 'debug',
        timestamp: new Date().toISOString(),
        environment: {
          NODE_ENV: process.env.NODE_ENV,
          variables: envStatus,
          dotenv_loaded: dotenvResult.parsed ? Object.keys(dotenvResult.parsed).length : 0
        },
        multiWorkspace: {
          totalWorkspaces: workspaces.length,
          workspaces: workspaces,
          isMultiTenant: isOAuthMode,
          mode: isOAuthMode ? 'OAuth Multi-Workspace' : 'Token Single-Workspace'
        }
      });
    });
    
    // Workspaces endpoint to see all installed workspaces
    httpApp.get('/workspaces', (req, res) => {
      const workspaces = isOAuthMode ? 
        Array.from(installationStore.installations.entries()).map(([teamId, installation]) => ({
          teamId,
          teamName: installation.team?.name || 'Unknown',
          installedAt: installation.installedAt || 'Unknown',
          scopes: installation.bot?.scopes || []
        })) :
        [{ teamId: 'SINGLE_WORKSPACE', teamName: 'Token Mode', installedAt: 'Environment Variable', scopes: ['Using hardcoded token'] }];
      
      res.json({
        status: 'workspaces',
        timestamp: new Date().toISOString(),
        totalWorkspaces: workspaces.length,
        workspaces: workspaces
      });
    });

    // OAuth callback endpoint - handle the redirect after Slack authorization
    httpApp.get('/slack/oauth/callback', async (req, res) => {
      try {
        console.log('🔄 OAuth callback received (GET):');
        console.log('   Query params:', req.query);
        console.log('   URL:', req.url);
        console.log('   Body:', req.body);
        
        const { code, state, error } = req.query;
        
        if (error) {
          console.error('❌ OAuth error:', error);
          return res.status(400).send(`
            <h1>OAuth Error</h1>
            <p>Authorization failed: ${error}</p>
            <p><a href="/install">Try installing again</a></p>
          `);
        }
        
        console.log('🔍 Extracted GET params:', { 
          code: code ? code.substring(0, 20) + '...' : 'MISSING', 
          state: state || 'MISSING', 
          error: error || 'NONE' 
        });
        
        if (!code) {
          console.error('❌ No authorization code received in GET callback');
          console.error('   Available query keys:', Object.keys(req.query));
          console.error('   Full query object:', req.query);
          return res.status(400).send(`
            <h1>OAuth Error</h1>
            <p>No authorization code received</p>
            <p>Query parameters: ${JSON.stringify(req.query)}</p>
            <p><a href="/install">Try installing again</a></p>
          `);
        }
        
        // Exchange code for tokens using Slack Web API
        console.log('🔄 Exchanging authorization code for tokens...');
        const result = await app.client.oauth.v2.access({
          client_id: process.env.SLACK_CLIENT_ID,
          client_secret: process.env.SLACK_CLIENT_SECRET,
          code: code,
          redirect_uri: process.env.SLACK_OAUTH_REDIRECT_URI || 'https://paperforslack.onrender.com/slack/oauth/callback'
        });
        
        console.log('✅ OAuth token exchange successful for workspace:', result.team.name, `(${result.team.id})`);
        console.log('🔍 OAuth result structure:', {
          access_token: result.access_token ? result.access_token.substring(0, 15) + '...' : 'MISSING',
          token_type: result.token_type,
          bot_user_id: result.bot_user_id,
          scope: result.scope,
          team: result.team,
          authed_user: result.authed_user
        });
        
        // Store the installation
        const installation = {
          team: {
            id: result.team.id,
            name: result.team.name
          },
          bot: {
            token: result.access_token, // This is the bot token in OAuth v2
            scopes: result.scope ? result.scope.split(',') : [],
            userId: result.bot_user_id
          },
          user: {
            token: result.authed_user?.access_token,
            scopes: result.authed_user?.scope ? result.authed_user.scope.split(',') : [],
            id: result.authed_user?.id
          },
          installedAt: new Date().toISOString()
        };
        
        console.log('🔍 Installation object being stored:', {
          teamId: installation.team.id,
          botToken: installation.bot.token ? installation.bot.token.substring(0, 15) + '...' : 'MISSING',
          botUserId: installation.bot.userId,
          scopes: installation.bot.scopes
        });
        
        await installationStore.storeInstallation(installation);
        console.log('✅ New workspace installation stored:', result.team.name, `(${result.team.id})`);
        
        // Show success page
        res.send(`
          <!DOCTYPE html>
          <html>
            <head>
              <title>Paper Installed Successfully!</title>
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
              <style>
                * { 
                  margin: 0; 
                  padding: 0; 
                  box-sizing: border-box; 
                }
                
                body { 
                  font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                  background: #f5f5f7;
                  min-height: 100vh;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  padding: 20px;
                  color: #1d1d1f;
                }
                
                .container { 
                  max-width: 560px;
                  background: #ffffff;
                  padding: 48px 40px;
                  border-radius: 18px;
                  text-align: center;
                  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.04), 0 1px 4px rgba(0, 0, 0, 0.08);
                  border: 1px solid rgba(0, 0, 0, 0.05);
                }
                
                .success-icon { 
                  color: #34c759; 
                  font-size: 56px; 
                  margin-bottom: 24px;
                  display: block;
                }
                
                .title { 
                  color: #1d1d1f; 
                  font-size: 26px; 
                  font-weight: 600; 
                  margin-bottom: 12px;
                  letter-spacing: -0.015em;
                }
                
                .subtitle { 
                  color: #86868b; 
                  font-size: 17px; 
                  margin-bottom: 32px;
                  font-weight: 400;
                  line-height: 1.4;
                }
                
                .instructions { 
                  background: #f2f2f7; 
                  padding: 24px; 
                  border-radius: 16px; 
                  margin: 32px 0; 
                  text-align: left;
                  border: 1px solid rgba(0, 0, 0, 0.04);
                }
                
                .instructions h3 { 
                  color: #1d1d1f;
                  font-size: 16px;
                  font-weight: 600;
                  margin-bottom: 16px;
                  display: flex;
                  align-items: center;
                  gap: 8px;
                }
                
                .instructions ol {
                  padding-left: 20px;
                  margin: 0;
                }
                
                .instructions li { 
                  color: #515154;
                  font-size: 15px;
                  margin: 8px 0;
                  line-height: 1.4;
                }
                
                .instructions code {
                  background: #e5e5ea;
                  color: #1d1d1f;
                  padding: 2px 6px;
                  border-radius: 4px;
                  font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', monospace;
                  font-size: 13px;
                }
                
                .features-section {
                  margin: 32px 0;
                }
                
                .features-title {
                  color: #1d1d1f;
                  font-size: 16px;
                  font-weight: 600;
                  margin-bottom: 16px;
                }
                
                .features-list {
                  list-style: none;
                  padding: 0;
                  text-align: left;
                }
                
                .features-list li {
                  color: #515154;
                  font-size: 15px;
                  margin: 8px 0;
                  padding-left: 20px;
                  position: relative;
                  line-height: 1.4;
                }
                
                .features-list li::before {
                  content: '•';
                  position: absolute;
                  left: 0;
                  color: #007aff;
                  font-weight: 600;
                }
                
                .back-btn {
                  background: #007aff;
                  color: #ffffff;
                  padding: 16px 28px;
                  border-radius: 12px;
                  text-decoration: none;
                  font-weight: 600;
                  font-size: 16px;
                  display: inline-block;
                  transition: all 0.2s cubic-bezier(0.25, 0.46, 0.45, 0.94);
                  border: 1px solid #007aff;
                  letter-spacing: -0.01em;
                  margin-top: 8px;
                }
                
                .back-btn:hover {
                  background: #0056cc;
                  border-color: #0056cc;
                  transform: translateY(-1px);
                  box-shadow: 0 8px 20px rgba(0, 122, 255, 0.2);
                }
                
                .back-btn:active {
                  transform: translateY(0);
                  transition: all 0.1s;
                }
                
                @media (max-width: 480px) {
                  .container { 
                    margin: 16px;
                    padding: 32px 24px;
                  }
                  
                  .title { 
                    font-size: 22px; 
                  }
                  
                  .subtitle { 
                    font-size: 16px; 
                  }
                  
                  .instructions {
                    padding: 20px;
                  }
                }
              </style>
            </head>
            <body>
              <div class="container">
                <span class="success-icon">🎉</span>
                <h1 class="title">Paper Installed!</h1>
                <p class="subtitle">Your AI conversation summarizer is ready to go!</p>
                
                <div class="instructions">
                  <h3>
                    <span>🚀</span>
                    <span>Next Steps:</span>
                  </h3>
                  <ol>
                    <li>Go to any Slack channel</li>
                    <li>Add Paper to the channel: <code>/invite @Paper</code></li>
                    <li>Have conversations (3+ messages)</li>
                    <li>Watch Canvas summaries appear automatically!</li>
                    <li>Try manual updates: <code>@Paper summary</code></li>
                  </ol>
                </div>
                
                <div class="features-section">
                  <div class="features-title">✨ Features you'll love:</div>
                  <ul class="features-list">
                    <li>Automatic Canvas creation</li>
                    <li>Action items with checkboxes</li>
                    <li>Link and date extraction</li>
                    <li>Multi-day conversation support</li>
                  </ul>
                </div>
                
                <a href="slack://open" class="back-btn">Open Slack</a>
              </div>
            </body>
          </html>
        `);
      } catch (error) {
        console.error('❌ Error in OAuth callback:', error);
        res.status(500).send(`
          <h1>OAuth Error</h1>
          <p>Something went wrong during installation: ${error.message}</p>
          <p><a href="/install">Try installing again</a></p>
        `);
      }
    });

    // Also handle POST requests to OAuth callback
    httpApp.post('/slack/oauth/callback', async (req, res) => {
      try {
        console.log('🔄 OAuth callback received (POST):');
        console.log('   Query params:', req.query);
        console.log('   Body:', req.body);
        console.log('   URL:', req.url);
        
        // Try to get parameters from both query and body
        const params = { ...req.query, ...req.body };
        const { code, state, error } = params;
        
        console.log('🔍 Extracted params:', { code: code?.substring(0, 20) + '...', state, error });
        
        if (error) {
          console.error('❌ OAuth error:', error);
          return res.status(400).send(`
            <h1>OAuth Error</h1>
            <p>Authorization failed: ${error}</p>
            <p><a href="/install">Try installing again</a></p>
          `);
        }
        
        if (!code) {
          console.error('❌ No authorization code received in POST callback');
          return res.status(400).send(`
            <h1>OAuth Error</h1>
            <p>No authorization code received</p>
            <p><a href="/install">Try installing again</a></p>
          `);
        }
        
        // Exchange code for tokens using Slack Web API
        console.log('🔄 Exchanging authorization code for tokens (POST)...');
        const result = await app.client.oauth.v2.access({
          client_id: process.env.SLACK_CLIENT_ID,
          client_secret: process.env.SLACK_CLIENT_SECRET,
          code: code,
          redirect_uri: process.env.SLACK_OAUTH_REDIRECT_URI || 'https://paperforslack.onrender.com/slack/oauth/callback'
        });
        
        console.log('✅ OAuth token exchange successful for workspace:', result.team.name, `(${result.team.id})`);
        
        // Store the installation
        const installation = {
          team: {
            id: result.team.id,
            name: result.team.name
          },
          bot: {
            token: result.access_token, // This is the bot token in OAuth v2
            scopes: result.scope ? result.scope.split(',') : [],
            userId: result.bot_user_id
          },
          user: {
            token: result.authed_user?.access_token,
            scopes: result.authed_user?.scope ? result.authed_user.scope.split(',') : [],
            id: result.authed_user?.id
          },
          installedAt: new Date().toISOString()
        };
        
        await installationStore.storeInstallation(installation);
        console.log('✅ New workspace installation stored (POST):', result.team.name, `(${result.team.id})`);
        
        // Show success page
        res.send(`Success! Installation completed for ${result.team.name}. You can close this window and return to Slack.`);
      } catch (error) {
        console.error('❌ Error in OAuth POST callback:', error);
        res.status(500).send(`
          <h1>OAuth Error</h1>
          <p>Something went wrong during installation: ${error.message}</p>
          <p><a href="/install">Try installing again</a></p>
        `);
      }
    });

    // OAuth is now handled automatically by Slack Bolt with proper multi-workspace support
    
    // Installation page for users to install the app
    httpApp.get('/install', (req, res) => {
      try {
        // Validate OAuth credentials
        if (!process.env.SLACK_CLIENT_ID || !process.env.SLACK_CLIENT_SECRET) {
          console.error('❌ Missing OAuth credentials for installation page');
          return res.status(500).send(`
            <!DOCTYPE html>
            <html>
              <head>
                <title>Installation Error - Paper for Slack</title>
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
                <style>
                  * { 
                    margin: 0; 
                    padding: 0; 
                    box-sizing: border-box; 
                  }
                  
                  body { 
                    font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    background: #f5f5f7;
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 20px;
                    color: #1d1d1f;
                  }
                  
                  .container { 
                    max-width: 480px;
                    background: #ffffff;
                    padding: 48px 40px;
                    border-radius: 18px;
                    text-align: center;
                    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.04), 0 1px 4px rgba(0, 0, 0, 0.08);
                    border: 1px solid rgba(0, 0, 0, 0.05);
                  }
                  
                  .error-icon {
                    color: #ff3b30;
                    font-size: 48px;
                    margin-bottom: 24px;
                    display: block;
                  }
                  
                  .title { 
                    color: #1d1d1f; 
                    font-size: 26px; 
                    font-weight: 600; 
                    margin-bottom: 12px;
                    letter-spacing: -0.015em;
                  }
                  
                  .subtitle { 
                    color: #86868b; 
                    font-size: 17px; 
                    margin-bottom: 24px;
                    font-weight: 400;
                    line-height: 1.4;
                  }
                  
                  .error { 
                    color: #ff3b30; 
                    font-size: 15px; 
                    background: #fff2f2;
                    padding: 16px;
                    border-radius: 12px;
                    border: 1px solid rgba(255, 59, 48, 0.1);
                    line-height: 1.4;
                  }
                  
                  @media (max-width: 480px) {
                    .container { 
                      margin: 16px;
                      padding: 32px 24px;
                    }
                    
                    .title { 
                      font-size: 22px; 
                    }
                    
                    .subtitle { 
                      font-size: 16px; 
                    }
                  }
                </style>
              </head>
              <body>
                <div class="container">
                  <span class="error-icon">⚠️</span>
                  <h1 class="title">Configuration Error</h1>
                  <p class="subtitle">Paper installation is not properly configured</p>
                  <p class="error">OAuth credentials are missing. Please contact the administrator.</p>
                </div>
              </body>
            </html>
          `);
        }

        const clientId = process.env.SLACK_CLIENT_ID.trim();
        const redirectUri = process.env.SLACK_OAUTH_REDIRECT_URI || 'https://paperforslack.onrender.com/slack/oauth/callback';
        
        const installUrl = `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=channels:read,channels:history,chat:write,chat:write.public,app_mentions:read,canvases:write,canvases:read,im:write,mpim:write,groups:read,groups:history,users:read,team:read&redirect_uri=${encodeURIComponent(redirectUri)}`;
        
        console.log(`🔍 Install page accessed - Generated OAuth URL with client ID: ${clientId.substring(0, 10)}...`);
        
        res.send(`
          <!DOCTYPE html>
          <html>
            <head>
              <title>Install Paper for Slack</title>
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
              <style>
                * { 
                  margin: 0; 
                  padding: 0; 
                  box-sizing: border-box; 
                }
                
                body { 
                  font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                  background: #f5f5f7;
                  min-height: 100vh;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  padding: 20px;
                  color: #1d1d1f;
                }
                
                .container { 
                  max-width: 480px;
                  background: #ffffff;
                  padding: 48px 40px;
                  border-radius: 18px;
                  text-align: center;
                  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.04), 0 1px 4px rgba(0, 0, 0, 0.08);
                  border: 1px solid rgba(0, 0, 0, 0.05);
                }
                
                .logo { 
                  font-size: 48px; 
                  margin-bottom: 16px; 
                  display: block;
                }
                
                .title { 
                  color: #1d1d1f; 
                  font-size: 28px; 
                  font-weight: 600; 
                  margin-bottom: 12px;
                  letter-spacing: -0.015em;
                }
                
                .subtitle { 
                  color: #86868b; 
                  font-size: 17px; 
                  margin-bottom: 32px;
                  font-weight: 400;
                  line-height: 1.4;
                }
                
                .features { 
                  text-align: left; 
                  margin: 32px 0; 
                  padding: 0;
                  list-style: none;
                }
                
                .features li { 
                  color: #515154; 
                  font-size: 15px;
                  margin: 12px 0;
                  padding-left: 24px;
                  position: relative;
                  line-height: 1.4;
                }
                
                .features li::before {
                  content: '✓';
                  position: absolute;
                  left: 0;
                  color: #007aff;
                  font-weight: 600;
                  font-size: 14px;
                }
                
                .install-btn { 
                  background: #007aff;
                  color: #ffffff;
                  padding: 16px 28px;
                  border-radius: 12px;
                  text-decoration: none;
                  font-weight: 600;
                  font-size: 16px;
                  display: inline-block;
                  transition: all 0.2s cubic-bezier(0.25, 0.46, 0.45, 0.94);
                  border: 1px solid #007aff;
                  letter-spacing: -0.01em;
                }
                
                .install-btn:hover { 
                  background: #0056cc;
                  border-color: #0056cc;
                  transform: translateY(-1px);
                  box-shadow: 0 8px 20px rgba(0, 122, 255, 0.2);
                }
                
                .install-btn:active {
                  transform: translateY(0);
                  transition: all 0.1s;
                }
                
                @media (max-width: 480px) {
                  .container { 
                    margin: 16px;
                    padding: 32px 24px;
                  }
                  
                  .title { 
                    font-size: 24px; 
                  }
                  
                  .subtitle { 
                    font-size: 16px; 
                  }
                }
              </style>
            </head>
            <body>
              <div class="container">
                <span class="logo">📄</span>
                <h1 class="title">Install Paper</h1>
                <p class="subtitle">AI-powered conversation summaries for your Slack workspace</p>
                
                <ul class="features">
                  <li>Automatic Canvas summaries using GPT-4</li>
                  <li>Action items with interactive checkboxes</li>
                  <li>Smart conversation analysis</li>
                  <li>Multi-workspace support</li>
                  <li>Real-time updates every 10 messages</li>
                </ul>
                
                <a href="${installUrl}" class="install-btn">Add to Slack</a>
              </div>
            </body>
          </html>
        `);
      } catch (error) {
        console.error('❌ Error in install page:', error);
        res.status(500).send(`
          <!DOCTYPE html>
          <html>
            <head>
              <title>Error - Paper for Slack</title>
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
              <style>
                * { 
                  margin: 0; 
                  padding: 0; 
                  box-sizing: border-box; 
                }
                
                body { 
                  font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                  background: #f5f5f7;
                  min-height: 100vh;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  padding: 20px;
                  color: #1d1d1f;
                }
                
                .container { 
                  max-width: 480px;
                  background: #ffffff;
                  padding: 48px 40px;
                  border-radius: 18px;
                  text-align: center;
                  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.04), 0 1px 4px rgba(0, 0, 0, 0.08);
                  border: 1px solid rgba(0, 0, 0, 0.05);
                }
                
                .error-icon {
                  color: #ff3b30;
                  font-size: 48px;
                  margin-bottom: 24px;
                  display: block;
                }
                
                .title { 
                  color: #1d1d1f; 
                  font-size: 26px; 
                  font-weight: 600; 
                  margin-bottom: 12px;
                  letter-spacing: -0.015em;
                }
                
                .message { 
                  color: #86868b; 
                  font-size: 17px; 
                  margin-bottom: 24px;
                  font-weight: 400;
                  line-height: 1.4;
                }
                
                .error-details { 
                  color: #8e8e93; 
                  font-size: 13px; 
                  background: #f2f2f7;
                  padding: 12px;
                  border-radius: 8px;
                  border: 1px solid rgba(0, 0, 0, 0.04);
                  font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', monospace;
                }
                
                @media (max-width: 480px) {
                  .container { 
                    margin: 16px;
                    padding: 32px 24px;
                  }
                  
                  .title { 
                    font-size: 22px; 
                  }
                  
                  .message { 
                    font-size: 16px; 
                  }
                }
              </style>
            </head>
            <body>
              <div class="container">
                <span class="error-icon">⚠️</span>
                <h1 class="title">Something went wrong</h1>
                <p class="message">Unable to generate installation link. Please try again later.</p>
                <p class="error-details">Error: ${error.message}</p>
              </div>
            </body>
          </html>
        `);
      }
    });
    
    // OAuth success callback to log installations (only in OAuth mode)
    if (isOAuthMode && app.oauth) {
      app.oauth.installationStore.storeInstallation = async (installation) => {
        await installationStore.storeInstallation(installation);
        console.log('✅ Paper successfully installed in workspace:', installation.team?.name, `(${installation.team?.id})`);
      };
    }
    
  } catch (error) {
    console.error('Failed to start app:', error);
    process.exit(1);
  }
})(); 