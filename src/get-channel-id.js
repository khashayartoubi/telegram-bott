require('dotenv').config();
const axios = require('axios');

async function checkTelegram() {
  const token = process.env.BOT_TOKEN;

  try {
    const response = await axios.get(`https://api.telegram.org/bot${token}/getWebhookInfo`);

    console.log(JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error(error.response?.data || error.message);
  }
}

checkTelegram();
