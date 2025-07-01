const { App } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const OpenAI = require('openai');
require('dotenv').config();

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize Slack app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  port: process.env.PORT || 10000
});

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

// Create or update summary using Canvas API
async function updateCanvas(channelId, summaryData) {
  try {
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
      
      const response = await app.client.apiCall('conversations.canvases.create', {
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
        const teamInfo = await app.client.team.info();
        const workspaceUrl = `https://${teamInfo.team.domain}.slack.com`;
        canvasUrl = `${workspaceUrl}/docs/${teamInfo.team.id}/${canvasId}`;
      } catch (error) {
        console.log(`⚠️ Cannot fetch team info (missing team:read scope), using generic Canvas URL`);
      }
      
      // Clean Canvas creation notification
      await app.client.chat.postMessage({
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
      await app.client.apiCall('canvases.edit', {
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
        await app.client.apiCall('canvases.edit', {
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
    
    // Enhanced fallback with better formatting
    try {
      await app.client.chat.postMessage({
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
    
    // Calculate 14 days ago timestamp
    const fourteenDaysAgo = Math.floor((Date.now() - (CONFIG.BOOTSTRAP_DAYS_LOOKBACK * 24 * 60 * 60 * 1000)) / 1000);
    
    // Fetch conversation history from last 14 days
    const result = await app.client.conversations.history({
      channel: channelId,
      oldest: fourteenDaysAgo.toString(),
      limit: CONFIG.MAX_CONVERSATION_HISTORY,
      exclude_archived: true
    });

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
    console.log(`Processing batch for channel ${channelId} with ${data.messages.length} messages`);
    
    const summaryData = await generateSummary(data.messages);
    await updateCanvas(channelId, summaryData);
    
    data.lastBatchTime = Date.now();
  } catch (error) {
    console.error('Error processing batch:', error);
  } finally {
    data.pendingUpdate = false;
  }
}

// Handle when bot is added to a channel
app.event('member_joined_channel', async ({ event, say, client }) => {
  try {
    // Get bot user ID to compare
    const botInfo = await client.auth.test();
    const botUserId = botInfo.user_id;
    
    // Only trigger bootstrap if the bot itself joined the channel
    if (event.user === botUserId) {
      console.log(`🎯 Paper bot added to channel: ${event.channel}, starting bootstrap...`);
      
      // Small delay to ensure permissions are fully set up
      setTimeout(async () => {
        await bootstrapChannelCanvas(event.channel, say);
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
      await bootstrapChannelCanvas(channelId);
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
        await bootstrapChannelCanvas(channelId, say);
        return; // Bootstrap will create the Canvas
      }
      
      // Fetch recent conversation history from Slack  
      console.log('Fetching conversation history for channel:', channelId);
      const result = await app.client.conversations.history({
        channel: channelId,
        limit: CONFIG.MAX_CONVERSATION_HISTORY,
        exclude_archived: true
      });
      
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
    if (!event.user) {
      console.log('⚠️ App home opened but no user ID provided');
      return;
    }
    
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

// Start the app with HTTP server for Render port binding
(async () => {
  try {
    const port = process.env.PORT || 10000;
    
    // Start Slack app in Socket Mode (no HTTP needed for Slack)
    await app.start();
    console.log(`⚡️ Paper Slack app connected via Socket Mode!`);
    
    // Start HTTP server for Render port detection
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

    // OAuth redirect handler for public installations
    httpApp.get('/slack/oauth/callback', async (req, res) => {
      const { code, error } = req.query;
      
      if (error) {
        console.error('OAuth error:', error);
        res.send(`
          <!DOCTYPE html>
          <html>
            <head>
              <title>Paper Installation Failed</title>
              <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
              <style>
                * { 
                  margin: 0; 
                  padding: 0; 
                  box-sizing: border-box; 
                }
                
                body { 
                  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
                  background: linear-gradient(135deg, #ff6b6b 0%, #ee5a52 100%);
                  min-height: 100vh;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  padding: 20px;
                }
                
                .container { 
                  max-width: 500px;
                  width: 100%;
                  background: rgba(255, 255, 255, 0.95);
                  backdrop-filter: blur(10px);
                  padding: 60px 40px;
                  border-radius: 20px;
                  box-shadow: 0 20px 40px rgba(0,0,0,0.1);
                  text-align: center;
                  border: 1px solid rgba(255,255,255,0.2);
                }
                
                .error { 
                  color: #e74c3c; 
                  font-size: 32px;
                  font-weight: 700;
                  margin-bottom: 16px;
                  letter-spacing: -0.02em;
                }
                
                .subtitle {
                  color: #6c757d;
                  font-size: 18px;
                  margin-bottom: 20px;
                  font-weight: 400;
                }
                
                .error-detail {
                  background: #f8f9fa;
                  border-left: 4px solid #e74c3c;
                  padding: 16px;
                  margin: 20px 0;
                  border-radius: 8px;
                  text-align: left;
                  font-family: 'Monaco', 'Menlo', monospace;
                  font-size: 14px;
                  color: #495057;
                }
                
                .btn { 
                  display: inline-block;
                  background: linear-gradient(135deg, #ff6b6b 0%, #ee5a52 100%);
                  color: white;
                  padding: 16px 32px;
                  text-decoration: none;
                  border-radius: 12px;
                  margin-top: 20px;
                  font-weight: 600;
                  font-size: 16px;
                  transition: all 0.3s ease;
                }
                
                .btn:hover {
                  transform: translateY(-2px);
                  box-shadow: 0 12px 24px rgba(255, 107, 107, 0.3);
                }
              </style>
            </head>
            <body>
              <div class="container">
                <h1 class="error">❌ Installation Failed</h1>
                <p class="subtitle">Sorry, there was an error installing Paper to your Slack workspace.</p>
                <div class="error-detail">
                  <strong>Error:</strong> ${error}
                </div>
                <a href="/" class="btn">Try Again</a>
              </div>
            </body>
          </html>
        `);
        return;
      }

      if (code) {
        console.log('✅ Paper OAuth code received:', code);
        
        // Exchange code for tokens (required to complete installation)
        try {
          const result = await app.client.oauth.v2.access({
            client_id: process.env.SLACK_CLIENT_ID,
            client_secret: process.env.SLACK_CLIENT_SECRET,
            code: code,
            redirect_uri: process.env.SLACK_OAUTH_REDIRECT_URI || 'https://paper-for-slack-app-fph7r.ondigitalocean.app/slack/oauth/callback'
          });
          
          console.log('✅ OAuth tokens exchanged successfully:', result.team?.name);
          console.log('✅ Paper installed in workspace:', result.team?.id);
        } catch (error) {
          if (error.data?.error === 'invalid_code') {
            console.log('ℹ️ OAuth code already used (this is normal for page refreshes)');
          } else {
            console.error('❌ OAuth token exchange failed:', error);
          }
          // Still show success to user since they've already authorized
        }
        res.send(`
          <!DOCTYPE html>
          <html>
            <head>
              <title>Paper Installed Successfully!</title>
              <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
              <style>
                * { 
                  margin: 0; 
                  padding: 0; 
                  box-sizing: border-box; 
                }
                
                body { 
                  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  min-height: 100vh;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  padding: 20px;
                }
                
                .container { 
                  max-width: 600px;
                  width: 100%;
                  background: rgba(255, 255, 255, 0.95);
                  backdrop-filter: blur(10px);
                  padding: 60px 40px;
                  border-radius: 20px;
                  box-shadow: 0 20px 40px rgba(0,0,0,0.1);
                  text-align: center;
                  border: 1px solid rgba(255,255,255,0.2);
                }
                
                .success { 
                  color: #27ae60; 
                  font-size: 32px;
                  font-weight: 700;
                  margin-bottom: 16px;
                  letter-spacing: -0.02em;
                }
                
                .subtitle {
                  color: #6c757d;
                  font-size: 18px;
                  margin-bottom: 40px;
                  font-weight: 400;
                }
                
                .features-grid {
                  display: grid;
                  grid-template-columns: 1fr 1fr;
                  gap: 30px;
                  margin: 40px 0;
                  text-align: left;
                }
                
                .feature-column h3 {
                  color: #2d3748;
                  font-size: 18px;
                  font-weight: 600;
                  margin-bottom: 16px;
                  display: flex;
                  align-items: center;
                  gap: 8px;
                }
                
                .feature { 
                  color: #4a5568;
                  margin: 12px 0;
                  font-size: 15px;
                  line-height: 1.5;
                  display: flex;
                  align-items: flex-start;
                  gap: 8px;
                }
                
                .feature::before {
                  content: "✅";
                  flex-shrink: 0;
                  margin-top: 1px;
                }
                
                .usage-step {
                  color: #4a5568;
                  margin: 12px 0;
                  font-size: 15px;
                  line-height: 1.5;
                  display: flex;
                  align-items: flex-start;
                  gap: 12px;
                }
                
                .step-number {
                  background: #667eea;
                  color: white;
                  width: 24px;
                  height: 24px;
                  border-radius: 50%;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  font-size: 12px;
                  font-weight: 600;
                  flex-shrink: 0;
                  margin-top: 1px;
                }
                
                .btn { 
                  display: inline-block;
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  color: white;
                  padding: 16px 32px;
                  text-decoration: none;
                  border-radius: 12px;
                  margin-top: 30px;
                  font-weight: 600;
                  font-size: 16px;
                  transition: all 0.3s ease;
                  border: none;
                  cursor: pointer;
                }
                
                .btn:hover {
                  transform: translateY(-2px);
                  box-shadow: 0 12px 24px rgba(102, 126, 234, 0.3);
                }
                
                @media (max-width: 768px) {
                  .features-grid {
                    grid-template-columns: 1fr;
                    gap: 25px;
                  }
                  
                  .container {
                    padding: 40px 30px;
                  }
                  
                  .success {
                    font-size: 28px;
                  }
                }
              </style>
            </head>
            <body>
              <div class="container">
                <h1 class="success">🎉 Paper Installed Successfully!</h1>
                <p class="subtitle">Your AI conversation summarizer is ready to use!</p>
                
                <div class="features-grid">
                  <div class="feature-column">
                    <h3>📄 What Paper Does</h3>
                    <div class="feature">Creates AI-powered Canvas summaries</div>
                    <div class="feature">Extracts action items with checkboxes</div>
                    <div class="feature">Groups links and dates automatically</div>
                    <div class="feature">Updates every 10 minutes or 10 messages</div>
                    <div class="feature">One canvas per channel - always updated</div>
                  </div>

                  <div class="feature-column">
                    <h3>🚀 How to Use</h3>
                    <div class="usage-step">
                      <span class="step-number">1</span>
                      <span>Add @Paper to any channel</span>
                    </div>
                    <div class="usage-step">
                      <span class="step-number">2</span>
                      <span>Have a conversation (5+ messages)</span>
                    </div>
                    <div class="usage-step">
                      <span class="step-number">3</span>
                      <span>Watch Paper create beautiful Canvas summaries!</span>
                    </div>
                    <div class="usage-step">
                      <span class="step-number">4</span>
                      <span>Type <code>@Paper summary</code> for manual updates</span>
                    </div>
                  </div>
                </div>

                <a href="slack://app" class="btn">Open Slack</a>
              </div>
            </body>
          </html>
        `);
      } else {
        res.send(`
          <!DOCTYPE html>
          <html>
            <head>
              <title>Paper Installation</title>
              <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
              <style>
                * { 
                  margin: 0; 
                  padding: 0; 
                  box-sizing: border-box; 
                }
                
                body { 
                  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
                  background: linear-gradient(135deg, #ffd93d 0%, #ff9500 100%);
                  min-height: 100vh;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  padding: 20px;
                }
                
                .container { 
                  max-width: 500px;
                  width: 100%;
                  background: rgba(255, 255, 255, 0.95);
                  backdrop-filter: blur(10px);
                  padding: 60px 40px;
                  border-radius: 20px;
                  box-shadow: 0 20px 40px rgba(0,0,0,0.1);
                  text-align: center;
                  border: 1px solid rgba(255,255,255,0.2);
                }
                
                .title { 
                  color: #f39c12; 
                  font-size: 32px;
                  font-weight: 700;
                  margin-bottom: 16px;
                  letter-spacing: -0.02em;
                }
                
                .subtitle {
                  color: #6c757d;
                  font-size: 18px;
                  margin-bottom: 30px;
                  font-weight: 400;
                }
                
                .btn { 
                  display: inline-block;
                  background: linear-gradient(135deg, #ffd93d 0%, #ff9500 100%);
                  color: white;
                  padding: 16px 32px;
                  text-decoration: none;
                  border-radius: 12px;
                  margin-top: 20px;
                  font-weight: 600;
                  font-size: 16px;
                  transition: all 0.3s ease;
                }
                
                .btn:hover {
                  transform: translateY(-2px);
                  box-shadow: 0 12px 24px rgba(255, 217, 61, 0.3);
                }
              </style>
            </head>
            <body>
              <div class="container">
                <h1 class="title">📄 Paper Installation</h1>
                <p class="subtitle">Something went wrong. Please try installing again.</p>
                <a href="/" class="btn">Return to Home</a>
              </div>
            </body>
          </html>
        `);
      }
    });
    
    // Start HTTP server on the required port
    httpApp.listen(port, '0.0.0.0', () => {
      console.log(`🌐 HTTP server running on port ${port} for Render!`);
    });
    
  } catch (error) {
    console.error('Failed to start app:', error);
    process.exit(1);
  }
})(); 