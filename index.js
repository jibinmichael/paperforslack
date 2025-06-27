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

// Configuration
const CONFIG = {
  BATCH_TIME_WINDOW: 2 * 60 * 1000, // 2 minutes
  BATCH_MESSAGE_LIMIT: 10,
  CANVAS_UPDATE_DEBOUNCE: 3 * 60 * 1000, // 3 minutes
  MAX_MESSAGES_FOR_SUMMARY: 50
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

// Generate AI summary with enhanced formatting
async function generateSummary(messages) {
  try {
    // Get user display names
    const userIds = messages.map(msg => msg.user);
    const userNames = await getUserDisplayNames(userIds);
    
    // Extract links and dates
    const links = extractLinks(messages);
    const dates = extractDates(messages);
    
    // Create conversation text with real names and user IDs for mentions
    const conversationText = messages.map(msg => 
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
      dates: dates
    };
  } catch (error) {
    console.error('Error generating summary:', error);
    return {
      summary: "❌ Error generating summary. Please try again later.",
      links: [],
      dates: []
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
  
  content += `\n\n---

*🤖 Auto-generated by Paper • Last updated: ${new Date().toLocaleString()}*

---

### 🔄 **How Paper Works**
- **Smart Batching**: Summarizes every 10 messages or 2 minutes
- **Auto-Updates**: Canvas refreshes automatically  
- **AI-Powered**: Uses OpenAI GPT-4 for intelligent summaries
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
      console.error('❌ Error posting fallback message:', fallbackError);
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

// Listen to all messages
app.message(async ({ message, say }) => {
  // Skip bot messages and system messages
  if (message.subtype || message.bot_id) return;
  
  const channelId = message.channel;
  
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
      // Fetch recent conversation history from Slack  
      console.log('Fetching conversation history for channel:', channelId);
      const result = await app.client.conversations.history({
        channel: channelId,
        limit: 50,
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
        
        if (conversationMessages.length > 0) {
          const summaryData = await generateSummary(conversationMessages);
          await updateCanvas(channelId, summaryData);
        } else {
          await say("📄 No recent conversation found to summarize. Try having a conversation first!");
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
    await client.views.publish({
      user_id: event.user,
      view: {
        type: 'home',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*📄 Welcome to Paper!*\n\nI automatically summarize channel conversations in Slack Canvas format.\n\n• Add me to any channel\n• I\'ll create a summary canvas automatically\n• Summaries update every few minutes\n• Mention me with "summary" for manual updates'
            }
          },
          {
            type: 'divider'
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*🔧 How it works:*\n• Listens to channel messages\n• Batches them intelligently\n• Creates Granola-style summaries\n• Updates canvas automatically'
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
        console.error(`Error auto-updating canvas for ${channelId}:`, error);
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
    
    // Start HTTP server on the required port
    httpApp.listen(port, '0.0.0.0', () => {
      console.log(`🌐 HTTP server running on port ${port} for Render!`);
    });
    
  } catch (error) {
    console.error('Failed to start app:', error);
    process.exit(1);
  }
})(); 