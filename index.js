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
- List main contributors with their key contributions
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
- [ ] **@Person**: Specific task or responsibility with checkbox for tracking
- [ ] **Timeline**: Any deadlines or timeframes mentioned with checkbox
- [ ] **Follow-up**: Required next steps or meetings with interactive checkbox

## 📌 **Key Insights & Resources**
- Important quotes or insights
- Links, documents, or resources shared
- Context that might be valuable later

## 🔍 **Context & Background**
- Why this conversation happened
- Any background context that's important
- Related previous discussions or decisions

**Important**: 
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
      console.error(`Error fetching user info for ${userId}:`, error);
      userNames[userId] = userId; // Fallback to user ID
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
    
    // Create conversation text with real names
    const conversationText = messages.map(msg => 
      `${userNames[msg.user] || msg.user}: ${msg.text}`
    ).join('\n');

    const enhancedPrompt = GRANOLA_PROMPT + `

**IMPORTANT FORMATTING INSTRUCTIONS:**
- For action items, use interactive checkboxes: "- [ ] Task description"
- Use real participant names when available: ${Object.entries(userNames).map(([id, name]) => `${id} = ${name}`).join(', ')}
- Make action items specific and actionable
- Include @mentions for people when assigning tasks: @${Object.values(userNames).join(', @')}`;

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

    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error generating summary:', error);
    return "❌ Error generating summary. Please try again later.";
  }
}

// Create beautiful Canvas with enhanced formatting (no title duplication)
async function createCanvasContent(summary) {
  return `${summary}

---

*🤖 Auto-generated by Paper • Last updated: ${new Date().toLocaleString()}*

---

### 🔄 **How Paper Works**
- **Smart Batching**: Summarizes every 10 messages or 2 minutes
- **Auto-Updates**: Canvas refreshes automatically  
- **AI-Powered**: Uses OpenAI GPT-4 for intelligent summaries
- **Granola Format**: Structured, scannable conversation insights

*💡 Mention @Paper with "summary" to trigger manual updates*`;
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
async function generateCanvasTitle(summary) {
  try {
    const titlePrompt = `Based on this conversation summary, generate a SHORT, descriptive title (max 6 words) that captures the main topic or purpose of the discussion. Return ONLY the title, nothing else:

${summary.substring(0, 500)}...`;

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
    return `📄 ${title}`;
  } catch (error) {
    console.error('Error generating canvas title:', error);
    return "📄 Conversation Summary";
  }
}

// Create or update summary using Canvas API
async function updateCanvas(channelId, summary) {
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
    
    const canvasContent = await createCanvasContent(summary);
    const canvasTitle = await generateCanvasTitle(summary);
    
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
      
      // Get workspace info for Canvas link
      const teamInfo = await app.client.team.info();
      const workspaceUrl = `https://${teamInfo.team.domain}.slack.com`;
      const canvasUrl = `${workspaceUrl}/docs/${teamInfo.team.id}/${canvasId}`;
      
      // Notify channel with Canvas link and preview
      await app.client.chat.postMessage({
        channel: channelId,
        text: `📄 *Paper has created: "${canvasTitle}"*\n\n🔗 View Canvas: ${canvasUrl}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `📄 *Paper created: "${canvasTitle}"*\n\n🔗 <${canvasUrl}|📄 Open Canvas> • One canvas per channel, auto-updated`
            }
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: "✨ Interactive checkboxes • 👥 Real names • 🏷️ Dynamic titles • 🔄 Auto-updates every 10 min"
              }
            ]
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
      } catch (titleError) {
        console.log('Note: Could not update canvas title (may not be supported)');
      }
      
      console.log(`✅ Canvas updated successfully: ${canvasId}`);
      
      // Subtle update notification for manual triggers
      await app.client.chat.postMessage({
        channel: channelId,
        text: "🔄 Canvas updated with latest insights",
        blocks: [
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: "📄 Canvas refreshed with new action items and participant insights • ✅ Interactive checkboxes ready"
              }
            ]
          }
        ]
      });
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
              text: summary
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
    
    const summary = await generateSummary(data.messages);
    await updateCanvas(channelId, summary);
    
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
    await say("📄 Updating your conversation summary...");
    
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
          const summary = await generateSummary(conversationMessages);
          await updateCanvas(channelId, summary);
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