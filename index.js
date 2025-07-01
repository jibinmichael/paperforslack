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

// Track app startup time for connection stability
global.appStartTime = Date.now();

// Global error handlers to prevent crashes from Socket Mode issues
process.on('uncaughtException', (error) => {
  console.error('🚨 Uncaught Exception:', error.message);
  
  // Handle specific StateMachine errors gracefully
  if (error.message && error.message.includes('server explicit disconnect')) {
    console.log('🛠️ Caught StateMachine disconnect error - preventing crash');
    console.log('💡 This indicates a Socket Mode configuration issue with Slack');
    console.log('🔄 App will continue running on HTTP mode');
    return; // Don't exit process
  }
  
  console.error('Full error:', error);
  // For other uncaught exceptions, still log but don't exit in production
  if (process.env.NODE_ENV !== 'production') {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit process for unhandled rejections in production
});

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

// Auto-detect configuration mode: OAuth (multi-workspace) vs Token (single-workspace)
const hasOAuthEnvVars = process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET;
const hasTokenEnvVars = process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN;

let appConfig;
let isOAuthMode = false;

if (hasOAuthEnvVars) {
  // OAuth mode for multi-workspace support
  console.log('🌐 Using OAuth multi-workspace configuration');
  isOAuthMode = true;
  appConfig = {
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    clientId: process.env.SLACK_CLIENT_ID,
    clientSecret: process.env.SLACK_CLIENT_SECRET,
    stateSecret: process.env.SLACK_STATE_SECRET || 'paper-canvas-state-secret',
    scopes: ['channels:read', 'channels:history', 'chat:write', 'chat:write.public', 'app_mentions:read', 'canvases:write', 'canvases:read', 'im:write', 'mpim:write', 'groups:read', 'groups:history', 'users:read', 'team:read'],
    installationStore: installationStore,
    installerOptions: {
      directInstall: true,
      stateVerification: false  // Disable for simplicity
    },
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
    port: process.env.PORT || 10000,
  };
} else if (hasTokenEnvVars) {
  // Simple token mode for single workspace
  console.log('🔧 Using simple token-only configuration (single workspace)');
  isOAuthMode = false;
  appConfig = {
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
    port: process.env.PORT || 10000,
  };
} else {
  console.error('❌ Missing required environment variables');
  console.error('For OAuth mode: SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET, SLACK_APP_TOKEN');
  console.error('For Token mode: SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, SLACK_APP_TOKEN');
  process.exit(1);
}

// Simple app initialization (like before)
console.log('🚀 Initializing Slack App...');
const app = new App(appConfig);
console.log('✅ Slack App initialized successfully');

// In-memory storage for message batching and canvas tracking
const channelData = new Map();
const canvasData = new Map();
const bootstrappedChannels = new Set(); // Track channels we've already bootstrapped

// Helper function to get the correct Slack client for both OAuth and token modes
async function getSlackClient(teamId = null) {
  if (isOAuthMode && teamId) {
    // OAuth mode: get client for specific workspace
    try {
      const installation = await installationStore.fetchInstallation({ teamId });
      if (installation && installation.bot) {
        return new (require('@slack/web-api').WebClient)(installation.bot.token);
      }
      console.error(`❌ No installation found for team: ${teamId}`);
      return null;
    } catch (error) {
      console.error(`❌ Error getting client for team ${teamId}:`, error);
      return null;
    }
  } else {
    // Token mode: use the single app client
    return app.client;
  }
}

// Helper function to get team ID from event context
function getTeamId(event) {
  return event.team_id || event.team || null;
}

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

// Get user display names and timezone info for better participant formatting
async function getUserDisplayNames(userIds, client = null) {
  const userNames = {};
  let userTimezone = 'America/New_York'; // Default timezone
  
  // Use provided client or fall back to app.client
  const slackClient = client || app.client;
  
  for (const userId of [...new Set(userIds)]) {
    try {
      const userInfo = await slackClient.users.info({ user: userId });
      userNames[userId] = userInfo.user.real_name || userInfo.user.display_name || userInfo.user.name;
      
      // Get timezone from the first user (assuming they're in the same workspace)
      if (userInfo.user.tz && userTimezone === 'America/New_York') {
        userTimezone = userInfo.user.tz;
      }
    } catch (error) {
      console.log(`⚠️ Cannot fetch user info (missing users:read scope), using user ID: ${userId}`);
      userNames[userId] = `User ${userId.substring(0,8)}`; // More readable fallback
    }
  }
  
  return { userNames, userTimezone };
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
async function generateSummary(messages, client = null) {
  try {
    // Smart selection for very long conversations to avoid token limits
    const selectedMessages = selectMessagesForSummary(messages);
    const isFiltered = selectedMessages.length < messages.length;
    
    console.log(`📝 Generating summary from ${selectedMessages.length} messages${isFiltered ? ` (filtered from ${messages.length})` : ''}`);
    
    // Get user display names and timezone
    const userIds = selectedMessages.map(msg => msg.user);
    const { userNames, userTimezone } = await getUserDisplayNames(userIds, client);
    
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
- Use REAL USER NAMES that are clickable, NOT user IDs: "**${Object.values(userNames)[0] || 'User Name'}**"
- Make action items specific and actionable: "- [ ] **Real Name**: Task description"
- Use blockquotes (>) for key insights, important decisions, or standout quotes  
- If dates/times are mentioned, add them to ONE "📅 Important Dates & Times" section
- Links will be added separately - don't include raw URLs in your summary
- Format ALL participant references with their real names in bold: **Name**

**USER MAPPING FOR NAMES:**
${Object.entries(userNames).map(([id, name]) => `${id} = ${name} → use **${name}**`).join('\n')}

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
      userTimezone: userTimezone,
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
      userTimezone: 'America/New_York',
      messageCount: {
        total: messages.length,
        processed: 0,
        isFiltered: false
      }
    };
  }
}

// Create beautiful Canvas with enhanced formatting (no title duplication)
async function createCanvasContent(summaryData, userTimezone = 'America/New_York') {
  let content = summaryData.summary;
  
  // Add links section if any links were shared  
  if (summaryData.links && summaryData.links.length > 0) {
    content += `\n\n---\n\n## 🔗 **Links & Resources**\n\n`;
    summaryData.links.forEach(link => {
      if (typeof link === 'object' && link.url && link.title) {
        content += `- [${link.title}](${link.url})\n`;
      } else {
        // Fallback for old format
        content += `- [${link}](${link})\n`;
      }
    });
  }
  
  const messageInfo = summaryData.messageCount;
  const messageStats = messageInfo ? 
    (messageInfo.isFiltered ? 
      `📊 Summarized ${messageInfo.processed} key messages from ${messageInfo.total} total messages` :
      `📊 Summarized all ${messageInfo.total} messages`) : '';

  // Get user timezone-aware timestamp
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

  content += `\n\n---

*🤖 Auto-generated by Paper • Last updated: ${timeString}*
${messageStats ? `\n*${messageStats}*` : ''}`;

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

// Extract links from messages with better formatting
function extractLinks(messages) {
  const linkRegex = /(https?:\/\/[^\s]+)/g;
  const links = [];
  
  messages.forEach(msg => {
    const foundLinks = msg.text.match(linkRegex);
    if (foundLinks) {
      foundLinks.forEach(link => {
        // Clean up link (remove trailing punctuation)
        const cleanLink = link.replace(/[.,;!?]$/, '');
        
        if (!links.find(l => l.url === cleanLink)) {
          // Try to extract a meaningful title from common domains
          let title = cleanLink;
          try {
            const urlObj = new URL(cleanLink);
            const domain = urlObj.hostname.replace('www.', '');
            
            // Extract meaningful titles for common domains
            if (domain.includes('google.com') && urlObj.pathname.includes('/spreadsheets/')) {
              title = '📊 Google Spreadsheet';
            } else if (domain.includes('docs.google.com')) {
              title = '📝 Google Docs';
            } else if (domain.includes('github.com')) {
              title = '👨‍💻 GitHub Repository';
            } else if (domain.includes('figma.com')) {
              title = '🎨 Figma Design';
            } else if (domain.includes('slack.com')) {
              title = '💬 Slack Link';
            } else if (domain.includes('youtube.com') || domain.includes('youtu.be')) {
              title = '📺 YouTube Video';
            } else if (domain.includes('zoom.us')) {
              title = '📹 Zoom Meeting';
            } else if (domain.includes('notion.')) {
              title = '📋 Notion Page';
            } else if (domain.includes('trello.com')) {
              title = '📌 Trello Board';
            } else {
              title = `🔗 ${domain.charAt(0).toUpperCase() + domain.slice(1)}`;
            }
          } catch (error) {
            title = `🔗 ${cleanLink.substring(0, 50)}...`;
          }
          
          links.push({ url: cleanLink, title });
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
    
    const canvasContent = await createCanvasContent(summaryData, summaryData.userTimezone);
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

// Create or update summary using Canvas API (simple token mode)
async function updateCanvas(channelId, summaryData) {
  try {
    const client = app.client;
    
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
    
    const canvasContent = await createCanvasContent(summaryData, summaryData.userTimezone);
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
        },
        unfurl_links: true,
        unfurl_media: true
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
      
      // Clean Canvas creation notification with preview
      await client.chat.postMessage({
        channel: channelId,
        text: `📄 <${canvasUrl}|${canvasTitle}> ✨`,
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
        ],
        unfurl_links: true,
        unfurl_media: true
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
    
    // Simple fallback message
    try {
      await client.chat.postMessage({
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
    
    const client = app.client;
    
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

// Process message batch with client support for both OAuth and token modes
async function processBatchWithClient(channelId, teamId = null) {
  const data = channelData.get(channelId);
  if (!data || data.messages.length === 0) return;

  data.pendingUpdate = true;
  
  try {
    console.log(`📝 Processing batch for channel ${channelId} with ${data.messages.length} messages`);
    
    const client = await getSlackClient(teamId);
    if (!client) {
      console.error(`❌ Could not get Slack client for team ${teamId}`);
      return;
    }
    
    const summaryData = await generateSummary(data.messages, client);
    await updateCanvasWithClient(channelId, summaryData, client, teamId);
    
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

// Process message batch (legacy function for backward compatibility)
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
app.event('member_joined_channel', async ({ event, say, client, context }) => {
  try {
    console.log(`👥 Member joined channel event:`, event);
    
    // Add connection stability check
    if (Date.now() - global.appStartTime < 10000) {
      console.log('🔄 Startup grace period - deferring member_joined_channel processing');
      return;
    }
    
    const teamId = getTeamId(context);
    
    // Get the appropriate client for this workspace
    const workspaceClient = await getSlackClient(teamId);
    if (!workspaceClient) {
      console.error(`❌ Could not get client for team ${teamId}`);
      return;
    }
    
    // Get bot user ID to compare
    const botInfo = await workspaceClient.auth.test();
    const botUserId = botInfo.user_id;
    
    // Only trigger bootstrap if the bot itself joined the channel
    if (event.user === botUserId) {
      console.log(`🎯 Paper bot added to channel: ${event.channel}, starting bootstrap...`);
      
      // Small delay to ensure permissions are fully set up
      setTimeout(async () => {
        await bootstrapChannelCanvasWithClient(event.channel, workspaceClient, teamId, say);
      }, 2000);
    }
  } catch (error) {
    console.error('Error handling member_joined_channel event:', error);
  }
});

// Listen to all messages
app.message(async ({ message, say, context }) => {
  try {
  // Skip bot messages and system messages
  if (message.subtype || message.bot_id) return;
    
    console.log(`💬 Message event received in channel ${message.channel}`);
    
    // Add connection stability check - avoid immediate processing during startup
    if (Date.now() - global.appStartTime < 10000) { // 10 second startup grace period
      console.log('🔄 Startup grace period - deferring message processing');
      return;
    }
  
  const channelId = message.channel;
  const teamId = getTeamId(context);
  
  // Bootstrap check: If this is the first time we see this channel, try to bootstrap
  if (!bootstrappedChannels.has(channelId)) {
    console.log(`🎯 First message detected in unboostrapped channel ${channelId}, starting bootstrap...`);
    
    // Bootstrap in background, don't block message processing
    setTimeout(async () => {
      try {
        const client = await getSlackClient(teamId);
        if (client) {
          await bootstrapChannelCanvasWithClient(channelId, client, teamId, say);
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
    setTimeout(() => processBatchWithClient(channelId, teamId), 1000);
  }
  } catch (error) {
    console.error('🚨 Error in message handler:', error.message);
  }
});

// Handle app mentions for manual trigger
app.event('app_mention', async ({ event, say, context }) => {
  try {
    console.log(`🏷️ App mention received in channel ${event.channel}`);
    
    // Add connection stability check
    if (Date.now() - global.appStartTime < 10000) {
      console.log('🔄 Startup grace period - deferring app mention processing');
      return;
    }
    
  const channelId = event.channel;
  const teamId = getTeamId(context);
  
  if (event.text.includes('summary') || event.text.includes('update')) {
    try {
      // Get the appropriate client for this workspace
      const client = await getSlackClient(teamId);
      if (!client) {
        await say("❌ Sorry, I couldn't connect to your workspace. Please try again.");
        return;
      }
      
      // Bootstrap check: If not bootstrapped yet, do it now
      if (!bootstrappedChannels.has(channelId)) {
        console.log(`🎯 Manual summary requested in unboostrapped channel ${channelId}, bootstrapping first...`);
        await bootstrapChannelCanvasWithClient(channelId, client, teamId, say);
        return; // Bootstrap will create the Canvas
      }
      
      // Fetch recent conversation history from Slack  
      console.log('Fetching conversation history for channel:', channelId);
      
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
          const summaryData = await generateSummary(conversationMessages, client);
          await updateCanvasWithClient(channelId, summaryData, client, teamId);
          
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
  } catch (error) {
    console.error('🚨 Error in app_mention handler:', error.message);
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

// Enhanced Socket Mode debugging and error handling
app.error((error) => {
  console.error('🚨 Slack app error detected:', {
    message: error.message,
    code: error.code,
    stack: error.stack?.split('\n')[0], // First line of stack trace
    timestamp: new Date().toISOString()
  });
  
  if (error.message && error.message.includes('server explicit disconnect')) {
    console.log('🔄 Socket Mode disconnected by server, investigating...');
    console.log('   This usually indicates:');
    console.log('   - Event subscription mismatch between manifest and handlers');
    console.log('   - App configuration issues in Slack admin');
    console.log('   - Token scope problems');
    console.log('   - Race condition in event handling setup');
  }
});

// Socket Mode debugging will be added after successful app.start()

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
        
        // Log app configuration for debugging
        console.log('🔍 App Configuration Debug:');
        console.log(`   - Socket Mode: ${appConfig.socketMode}`);
        console.log(`   - Has Bot Token: ${!!appConfig.token}`);
        console.log(`   - Has App Token: ${!!appConfig.appToken}`);
        console.log(`   - Has Signing Secret: ${!!appConfig.signingSecret}`);
        
        // Add Socket Mode debugging after successful connection
        if (app.receiver && app.receiver.client) {
          console.log('🔍 Setting up Socket Mode event debugging...');
          const socketModeClient = app.receiver.client;
          
          // Debug Socket Mode events
          socketModeClient.on('slack_event', (event) => {
            console.log('📨 Socket Mode event received:', {
              type: event.type,
              team_id: event.team_id,
              api_app_id: event.api_app_id,
              timestamp: new Date().toISOString()
            });
          });
          
          socketModeClient.on('disconnect', (event) => {
            console.log('🔌 Socket Mode disconnected:', {
              code: event.code,
              reason: event.reason,
              timestamp: new Date().toISOString()
            });
            
            // Handle server explicit disconnect gracefully
            if (event.reason === 'server explicit disconnect') {
              console.log('🚨 Server explicitly disconnected - likely configuration issue');
              console.log('💡 This usually means:');
              console.log('   - Event subscription mismatch in app manifest');
              console.log('   - App token permissions issue');
              console.log('   - Rate limiting or configuration conflict');
              
              // Don't crash - try to reconnect after delay
              setTimeout(() => {
                console.log('🔄 Attempting to reconnect after server disconnect...');
                socketModeClient.start().catch(console.error);
              }, 5000);
            }
          });
          
          socketModeClient.on('ready', () => {
            console.log('✅ Socket Mode client ready and listening for events');
          });
          
          socketModeClient.on('error', (error) => {
            console.error('🔌 Socket Mode client error:', {
              message: error.message,
              code: error.code,
              timestamp: new Date().toISOString()
            });
            
            // Handle StateMachine errors gracefully
            if (error.message && error.message.includes('server explicit disconnect')) {
              console.log('🛠️ Handling StateMachine disconnect error gracefully');
              return; // Don't let it crash
            }
          });
          
          console.log('✅ Socket Mode debugging listeners added');
        }
        
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
      const envKeys = isOAuthMode ? 
        ['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET', 'SLACK_SIGNING_SECRET', 'SLACK_APP_TOKEN', 'OPENAI_API_KEY'] :
        ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_APP_TOKEN', 'OPENAI_API_KEY'];
      
      const envStatus = envKeys.map(key => ({ 
        name: key, 
        present: !!process.env[key],
        preview: process.env[key] ? process.env[key].substring(0, 10) + '...' : 'missing'
      }));
      
      const workspaces = isOAuthMode ? 
        Array.from(installationStore.installations.entries()).map(([teamId, installation]) => ({
          teamId,
          teamName: installation.team?.name || 'Unknown',
          botToken: installation.bot?.token ? installation.bot.token.substring(0, 10) + '...' : 'Missing'
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
        workspaces: workspaces,
        mode: isOAuthMode ? 'OAuth Multi-Workspace' : 'Token Single-Workspace'
      });
    });

    // OAuth installation endpoints
    if (isOAuthMode) {
      // OAuth mode - serve installation flow
      httpApp.get('/install', (req, res) => {
        res.send(`
          <!DOCTYPE html>
          <html>
            <head>
            <title>Paper for Slack - Multi-Workspace</title>
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
              
              h1 {
                font-size: 32px;
                font-weight: 700;
                margin-bottom: 16px;
                color: #1d1d1f;
              }
              
              p {
                font-size: 18px;
                color: #6e6e73;
                margin-bottom: 32px;
                line-height: 1.5;
              }
              
              .install-button {
                display: inline-block;
                background: #4285f4;
                color: white;
                padding: 16px 32px;
                border-radius: 12px;
                text-decoration: none;
                font-weight: 600;
                font-size: 16px;
                transition: all 0.2s ease;
                border: none;
                cursor: pointer;
              }
              
              .install-button:hover {
                background: #3367d6;
                transform: translateY(-1px);
              }
              
              .features {
                margin-top: 40px;
                text-align: left;
              }
              
              .feature {
                margin-bottom: 12px;
                font-size: 16px;
                color: #1d1d1f;
              }
              
              .feature::before {
                content: "✨";
                margin-right: 8px;
              }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="logo">📄</div>
                <h1>Paper for Slack</h1>
                <p>AI-powered Canvas conversation summarizer that creates beautiful, structured summaries of your team discussions.</p>
                
                <a href="/slack/install" class="install-button">
                  Add to Slack
                </a>
                
                <div class="features">
                  <div class="feature">Automatic Canvas summaries</div>
                  <div class="feature">Smart action item tracking</div>
                  <div class="feature">Multi-day conversation support</div>
                  <div class="feature">Granola-style formatting</div>
                  <div class="feature">Real-time updates</div>
                </div>
              </div>
            </body>
          </html>
        `);
      });

      // OAuth success page
      httpApp.get('/slack/oauth_redirect', (req, res) => {
        res.send(`
          <!DOCTYPE html>
          <html>
            <head>
              <title>Paper for Slack - Success!</title>
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
              <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { 
                  font-family: 'DM Sans', sans-serif;
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
                  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.04);
                }
                .success { font-size: 64px; margin-bottom: 24px; }
                h1 { font-size: 28px; font-weight: 700; margin-bottom: 16px; }
                p { font-size: 18px; color: #6e6e73; line-height: 1.5; }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="success">🎉</div>
                <h1>Paper Installed Successfully!</h1>
                <p>Paper is now ready to create Canvas summaries in your workspace. Add me to any channel and start having conversations!</p>
              </div>
            </body>
          </html>
        `);
      });
    } else {
      // Token mode - simple info page
      httpApp.get('/install', (req, res) => {
        res.send(`
          <!DOCTYPE html>
          <html>
            <head>
            <title>Paper for Slack - Token Mode</title>
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
              </style>
            </head>
            <body>
              <div class="container">
              <span class="logo">📄</span>
              <h1 class="title">Paper</h1>
              <p class="subtitle">Running in single-workspace token mode</p>
              </div>
            </body>
          </html>
        `);
      });
    }
    
  } catch (error) {
    console.error('Failed to start app:', error);
    process.exit(1);
  }
})();