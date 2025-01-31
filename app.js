require('dotenv').config(); // Load environment variables
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const { createCanvas } = require('canvas');
const path = require('path');

const ACTION_LOG_FILE = process.env.ACTION_LOG_FILE;
const SUBSCRIBERS_FILE = process.env.SUBSCRIBERS_FILE;
const ADMINS_FILE = process.env.ADMINS_FILE;

function logUserAction(userId, action) {
    const logEntry = {
        user_id: userId,
        action: action,
        timestamp: new Date().toISOString(),
    };

    let logs = [];
    if (fs.existsSync(ACTION_LOG_FILE)) {
        const data = fs.readFileSync(ACTION_LOG_FILE);
        logs = JSON.parse(data);
    }

    logs.push(logEntry);

    fs.writeFileSync(ACTION_LOG_FILE, JSON.stringify(logs, null, 2));
}

process.env.NODE_NO_WARNINGS = '1';

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

let userCaptchaData = {};
let subscribedUsers = loadSubscribers();
let activeInviteLinks = {};
let adminIds = loadAdmins();



const bot = new TelegramBot(BOT_TOKEN, {
  polling: true,
  webHook: false,
});

async function generateTimeLimitedLink() {
    try {
        const expireTime = Math.floor(Date.now() / 1000) + 60;
        const inviteLink = await bot.createChatInviteLink(CHANNEL_ID, { expire_date: expireTime, member_limit: 1 });
        return inviteLink.invite_link;
    } catch (error) {
        console.error('Error generating invite link for channel:', CHANNEL_ID);
        console.error('Error details:', error);
        return null;
    }
}


async function revokeInviteLink(inviteLink) {
  try {
    await bot.revokeChatInviteLink(CHANNEL_ID, inviteLink);
    console.log('Invite link revoked:', inviteLink);
  } catch (error) {
    console.error('Error revoking invite link:', error);
  }
}

function loadSubscribers() {
  if (!fs.existsSync(SUBSCRIBERS_FILE)) {
    return new Set();
  }
  try {
    const data = JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE));
    return new Set(data.subscribed_users || []);
  } catch (error) {
    console.error(`Could not load ${SUBSCRIBERS_FILE}:`, error);
    return new Set();
  }
}

function saveSubscribers(subscribers) {
  const data = { subscribed_users: Array.from(subscribers) };
  try {
    fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error(`Could not save subscribers to ${SUBSCRIBERS_FILE}:`, error);
  }
}

function loadAdmins() {
  if (!fs.existsSync(ADMINS_FILE)) {
    return new Set();
  }
  try {
    const data = JSON.parse(fs.readFileSync(ADMINS_FILE));
    return new Set(data.admin_ids || []);
  } catch (error) {
    console.error(`Could not load ${ADMINS_FILE}:`, error);
    return new Set();
  }
}

function saveAdmins(adminIds) {
  const data = { admin_ids: Array.from(adminIds) };
  try {
    fs.writeFileSync(ADMINS_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error(`Could not save admins to ${ADMINS_FILE}:`, error);
  }
}

function removeAdmins(adminIds) {
  const data = { admin_ids: Array.from(adminIds) };
  try {
    fs.writeFileSync(ADMINS_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error(`Could not save admins to ${ADMINS_FILE}:`, error);
  }
}

function generateCaptchaCode(length = 5) {
  const digits = '0123456789';
  return Array.from({ length }, () => digits[Math.floor(Math.random() * digits.length)]).join('');
}

function createCaptchaImage(code) {
  const width = 200;
  const height = 60;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, width, height);

  const textColor = `rgb(${Math.floor(Math.random() * 150)}, ${Math.floor(Math.random() * 100)}, ${Math.floor(Math.random() * 150)})`;
  ctx.fillStyle = textColor;

  ctx.font = '32px Arial';
  const textWidth = ctx.measureText(code).width;
  const x = (width - textWidth) / 2;
  const y = height / 2 + 10;
  ctx.fillText(code, x, y);

  return canvas.toBuffer();
}

const inlineKeyboard = [];

bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id;
  subscribedUsers.add(userId);
  saveSubscribers(subscribedUsers);

  const code = generateCaptchaCode();
  userCaptchaData[userId] = { code, attempts: 0 };

  const captchaImageBuffer = createCaptchaImage(code);
  const captchaFilePath = path.join(__dirname, 'captcha_image.jpg');

  fs.writeFileSync(captchaFilePath, captchaImageBuffer);

  const options = [];
  let correctOptionIndex = Math.floor(Math.random() * 9);
  for (let i = 0; i < 9; i++) {
    if (i === correctOptionIndex) {
      options.push(code);
    } else {
      options.push(generateCaptchaCode(5));
    }
  }

  inlineKeyboard.length = 0;

  const row1 = options.slice(0, 3).map((option, index) => ({
    text: option,
    callback_data: `captcha_option_${index}_${option}`,
  }));
  const row2 = options.slice(3, 6).map((option, index) => ({
    text: option,
    callback_data: `captcha_option_${index + 3}_${option}`,
  }));
  const row3 = options.slice(6, 9).map((option, index) => ({
    text: option,
    callback_data: `captcha_option_${index + 6}_${option}`,
  }));

  inlineKeyboard.push(row1, row2, row3);

  bot.sendPhoto(userId, captchaFilePath, {
    caption: 'Select the correct captcha code from the options below:',
    reply_markup: JSON.stringify({
      inline_keyboard: inlineKeyboard,
    }),
  });
});

bot.on('callback_query', async (callbackQuery) => {
    const userId = callbackQuery.from.id;
    const callbackData = callbackQuery.data;

    console.log('Callback received:', callbackData);
    logUserAction(userId, `Pressed button with data: ${callbackData}`);

    const parts = callbackData.split('_');
    if (parts.length !== 4 || parts[0] !== 'captcha' || parts[1] !== 'option') {
        bot.sendMessage(userId, '❌ Invalid captcha response. Please try again.');
        return;
    }

    const selectedCode = parts[3];
    const captchaInfo = userCaptchaData[userId];

    if (!captchaInfo) {
        bot.sendMessage(userId, '❌ No active captcha session. Please restart the process.');
        return;
    }

    const { code } = captchaInfo;
    if (selectedCode === code) {
        bot.sendMessage(userId, '✅ Correct!');
        delete userCaptchaData[userId];

        const channelInvite = await generateTimeLimitedLink();
        if (channelInvite) {
            activeInviteLinks[userId] = channelInvite;

            bot.sendMessage(userId, `Here is your **unique** invite link (valid for 1 minute):`, {
                reply_markup: JSON.stringify({
                    inline_keyboard: [[{ text: 'Join Channel', url: channelInvite }]],
                }),
                parse_mode: 'Markdown',
            });

            setTimeout(async () => {
                await revokeInviteLink(channelInvite);
                delete activeInviteLinks[userId];
            }, 60000);
        } else {
            bot.sendMessage(userId, '❌ An error occurred while generating the invite link. Please contact the admin.');
        }
    } else {
        captchaInfo.attempts++;
        if (captchaInfo.attempts >= 3) {
            bot.sendMessage(userId, '❌ You have exceeded the maximum attempts. Please try again later.');
            delete userCaptchaData[userId];
        } else {
            bot.sendMessage(userId, '❌ Incorrect. Try again.');
        }
    }
});

bot.onText(/\/help/, (msg) => {
    const userId = msg.from.id;

    const helpText = `
📚 *Here are the available commands:*

1️⃣ * /start*  
  - Start the bot and get your captcha to join the channel.

2️⃣ * /sendtousers <msg>*  
  - Send a message to all users (admins only).

3️⃣ * /add admin <id>*  
  - Add a user as an admin (owner only).

4️⃣ * /listusers*  
  - List all users subscribed to the bot (admins only).

5️⃣ * /help*  
  - Show this help message.

⚙️ *Bot Usage:*
- Use * /start* to begin interacting with the bot and get the captcha for access.
- If you're an admin, you can send messages to all users with * /sendtousers*.
- Owners can add new admins using * /add admin <id>*.
- Check the list of subscribed users using * /listUsers* (admins only).

🔧 *Note:*
- Only users with admin privileges can perform admin tasks like sending messages to all users and adding new admins.
`;

    bot.sendMessage(userId, helpText, { parse_mode: 'Markdown' });
});

  


bot.onText(/\/add(?:\s+admin)?(?:\s+(\d+))?/, (msg, match) => {
    const userId = msg.from.id;
    const newAdminId = match[1] ? parseInt(match[1], 10) : null;

    if (!newAdminId) {
        bot.sendMessage(userId, '❌ Please provide a valid admin ID. Usage: /add admin <id>');
        return;
    }

    if (!adminIds.has(userId)) {
        bot.sendMessage(userId, '❌ You are not authorized to add admins.');
        return;
    }
    if (adminIds.has(newAdminId)) {
        bot.sendMessage(userId, `❌ User ${newAdminId} is already an admin.`);
        return;
    }
    adminIds.add(newAdminId);
    removeAdmins(adminIds);
    bot.sendMessage(userId, `✅ User ${newAdminId} has been added as an admin.`);
});


bot.onText(/\/remove(?:\s+admin)?(?:\s+(\d+))?/, (msg, match) => {
  const userId = msg.from.id;
  const adminIdToRemove = match[1] ? parseInt(match[1], 10) : null;

  if (!adminIdToRemove) {
      bot.sendMessage(userId, '❌ Please provide a valid admin ID. Usage: /remove admin <id>');
      return;
  }

  if (!adminIds.has(userId)) {
      bot.sendMessage(userId, '❌ You are not authorized to remove admins.');
      return;
  }

  if (!adminIds.has(adminIdToRemove)) {
      bot.sendMessage(userId, `❌ User ${adminIdToRemove} is not an admin.`);
      return;
  }

  adminIds.delete(adminIdToRemove);
  saveAdmins(adminIds);
  bot.sendMessage(userId, `✅ User ${adminIdToRemove} has been removed as an admin.`);
});


bot.onText(/\/sendtousers (.+)/, async (msg, match) => {
  const userId = msg.from.id;
  const message = match[1]; // Extract the message content

  // Check if the user is an admin
  if (adminIds.has(userId)) {
      // Send message to all subscribed users
      for (const user of subscribedUsers) {
          try {
              await bot.sendMessage(user, message);
          } catch (error) {
              if (error.response && error.response.statusCode === 400 && error.response.body.error_code === 400) {
                  // Handle the PARTICIPANT_ID_INVALID error
                  console.error(`Error sending message to user ID ${user}:`, error.message);
                  if (error.response.body.description.includes('PARTICIPANT_ID_INVALID')) {
                      // Remove invalid user from the list
                      subscribedUsers.delete(user);
                      saveSubscribers(subscribedUsers);
                  }
              } else {
                  console.error(`Unexpected error sending message to user ID ${user}:`, error.message);
              }
          }
      }
      bot.sendMessage(userId, '✅ Message sent to all users.');
  } else {
      bot.sendMessage(userId, '❌ You are not authorized to send messages.');
  }
});

  


//   const userId = msg.from.id;

//   if (!adminIds.has(userId)) {
//     await bot.sendMessage(userId, '❌ You are not authorized to view the list of users.');
//     return;
//   }

//   const usersList = Array.from(subscribedUsers);
//   if (usersList.length === 0) {
//     await bot.sendMessage(userId, 'No users have subscribed yet.');
//     return;
//   }

//   let usernames = [];
//   let updatedUserList = new Set(subscribedUsers);

//   for (const id of usersList) {
//     try {
//       const chatMember = await bot.getChatMember(CHANNEL_ID, id);
//       if (chatMember.user.username) {
//         usernames.push(`@${chatMember.user.username}`);
//       } else {
//         updatedUserList.delete(id);  // Remove users without a username
//       }
//     } catch (error) {
//       if (error.response && error.response.statusCode === 400 &&
//           error.response.body.description.includes('PARTICIPANT_ID_INVALID')) {
//         updatedUserList.delete(id);  // Remove invalid user ID
//         console.log(`Removed invalid user ID ${id}`);
//       } else {
//         console.error(`Error retrieving user ID ${id}:`,);
//       }
//     }
//   }

//   subscribedUsers = updatedUserList;
//   saveSubscribers(subscribedUsers);

//   const userListMessage = `Here is the list of users currently in the bot:\n\n` + usernames.join('\n');
//   const chunkSize = 4096;
  
//   for (let i = 0; i < userListMessage.length; i += chunkSize) {
//     await bot.sendMessage(userId, userListMessage.substring(i, i + chunkSize));
//   }
// });
bot.onText(/\/listusers/, async (msg) => {
  const chatId = msg.chat.id;

  // Check if the user is an admin before listing users
  if (!adminIds.has(msg.from.id)) {
      return bot.sendMessage(chatId, '❌ You are not authorized to view the list of users.');
  }

  const users = Array.from(subscribedUsers);  // Convert Set to Array for iteration

  if (users.length === 0) {
      return bot.sendMessage(chatId, 'No users subscribed yet.');
  }

  // Retrieve detailed info for each user
  let userDetails = 'Subscribed users:\n';
  let validUsers = new Set();  // To keep track of valid users

  // Fetch user details (first_name, last_name, username) for each user ID
  for (const userId of users) {
      try {
          const user = await bot.getChat(userId);  // Get user info using bot.getChat
          const userName = user.username ? `@${user.username}` : 'No username';
          const fullName = `${user.first_name} ${user.last_name || ''}`;

          // If the user doesn't have a username, remove them from the subscribers list
          if (user.username) {
              // Shorten the name and username if too long
              const maxLength = 30;
              const shortenedName = fullName.length > maxLength ? fullName.slice(0, maxLength) + '...' : fullName;
              const shortenedUserName = userName.length > maxLength ? userName.slice(0, maxLength) + '...' : userName;

              userDetails += `${shortenedName} (${shortenedUserName})\n`;
              validUsers.add(userId);  // Add valid user to the set
          } else {
              // User doesn't have a username, remove from subscribed users
              subscribedUsers.delete(userId);
              saveSubscribers(subscribedUsers);
          }
      } catch (error) {
          console.error(`Error retrieving user ID ${userId}:`, error);

          // If user doesn't exist, remove their ID from the list
          subscribedUsers.delete(userId);
          saveSubscribers(subscribedUsers);

          userDetails += `Error retrieving user ID ${userId}: ${error.message}\n`;
      }
  }

  // Update the subscribedUsers list with only valid users
  subscribedUsers = validUsers;
  saveSubscribers(subscribedUsers);

  // Check if the message is too long (Telegram's message limit is 4096 characters)
  const chunkSize = 4096;
  for (let i = 0; i < userDetails.length; i += chunkSize) {
      await bot.sendMessage(chatId, userDetails.substring(i, i + chunkSize));
  }
});
