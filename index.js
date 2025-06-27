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
  processBeforeResponse: true
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

// Granola-style summary template
const GRANOLA_PROMPT = `
You are creating a conversation summary in Granola-style format. Granola summaries are:
- Structured with clear sections and bullet points
- Focus on key decisions, action items, and important discussions
- Include participant names when relevant
- Use a clean, scannable format
- Highlight outcomes and next steps

Format the summary as:

## 📋 Conversation Summary

### 🗣️ Key Participants
- List main contributors

### 💬 Main Discussion Points
- Bullet point format
- Include key topics discussed

### ✅ Decisions Made
- Clear decisions reached
- Any agreements or conclusions

### 🎯 Action Items
- Who needs to do what
- Any deadlines mentioned

### 📌 Important Notes
- Other relevant information
- Links or resources shared

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

// Generate AI summary
async function generateSummary(messages) {
  try {
    const conversationText = messages.map(msg => 
      `${msg.user}: ${msg.text}`
    ).join('\n');

    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: GRANOLA_PROMPT
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

// Create or update canvas
async function updateCanvas(channelId, summary) {
  try {
    let canvasId = canvasData.get(channelId);
    
    if (!canvasId) {
      // Create new canvas
      const response = await app.client.canvases.create({
        owner_id: channelId,
        title: "📄 Paper: Conversation Summary",
        document_content: {
          type: "markdown",
          markdown: summary
        }
      });
      
      canvasId = response.canvas_id;
      canvasData.set(channelId, canvasId);
      
      // Share canvas in channel
      await app.client.chat.postMessage({
        channel: channelId,
        text: "📄 *Paper* has created a conversation summary canvas!",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "📄 *Paper* has created a conversation summary canvas for this channel!"
            }
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "📋 View Summary Canvas"
                },
                url: `slack://canvas/${canvasId}`,
                action_id: "view_canvas"
              }
            ]
          }
        ]
      });
    } else {
      // Update existing canvas
      await app.client.canvases.edit({
        canvas_id: canvasId,
        changes: [
          {
            operation: "replace",
            document_content: {
              type: "markdown", 
              markdown: summary
            }
          }
        ]
      });
    }
    
    console.log(`Canvas updated for channel ${channelId}`);
  } catch (error) {
    console.error('Error updating canvas:', error);
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
    await processBatch(channelId);
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

// Export for Vercel serverless
module.exports = async (req, res) => {
  try {
    // Let Slack Bolt handle all requests
    await app.receiver.app(req, res);
  } catch (error) {
    console.error('Error handling request:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}; 